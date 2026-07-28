package handlers

// admin.go — admin-only endpoints for invite-token management and the audit
// log viewer.
//
// Authorization: every route here is mounted on the protected group AND
// additionally requires the admin scope (middleware.CtxIsAdmin, set from the
// "vulos:admin" JWT audience). A non-admin caller receives 403. This keeps
// invite minting and audit reads off the surface of ordinary users.

import (
	"net/http"
	"os"
	"sync"
	"time"

	"diwan/backend/audit"
	"diwan/backend/billing"
	"diwan/backend/invites"
	"diwan/backend/middleware"
	"diwan/backend/userauth"

	"github.com/gin-gonic/gin"
)

// ---- shared process-wide stores ---------------------------------------------

func inviteDBPath() string {
	if v := os.Getenv("VULOS_INVITES_DB"); v != "" {
		return v
	}
	return "./data/invites.db"
}

func auditDBPath() string {
	if v := os.Getenv("VULOS_AUDIT_DB"); v != "" {
		return v
	}
	return "./data/audit.db"
}

var (
	defaultInviteStore invites.Store
	inviteStoreOnce    sync.Once
	defaultAuditStore  audit.Store
	auditStoreOnce     sync.Once
	defaultCredsStore  userauth.Store
	credsStoreOnce     sync.Once
)

func credsDBPath() string {
	if v := os.Getenv("VULOS_USERAUTH_DB"); v != "" {
		return v
	}
	return "./data/userauth.db"
}

// SharedCredsStore returns the process-wide per-user credential store backed by
// durable SQLite, falling back to in-memory (degraded) if it cannot be opened.
// Sharing one store across the auth handler and the admin/seat gate keeps the
// member count consistent (the seats cap counts real registered members).
func SharedCredsStore() userauth.Store {
	credsStoreOnce.Do(func() {
		if st, err := userauth.NewSQLiteStore(credsDBPath()); err == nil {
			defaultCredsStore = st
		} else {
			defaultCredsStore = userauth.NewNullStore()
		}
	})
	return defaultCredsStore
}

// SharedInviteStore returns a process-wide invite store backed by durable
// SQLite, falling back to in-memory (degraded) if the DB cannot be opened.
func SharedInviteStore() invites.Store {
	inviteStoreOnce.Do(func() {
		if st, err := invites.NewSQLiteStore(inviteDBPath()); err == nil {
			defaultInviteStore = st
		} else {
			defaultInviteStore = invites.NewNullStore()
		}
	})
	return defaultInviteStore
}

// SharedAuditStore returns a process-wide append-only audit store backed by
// durable SQLite, falling back to in-memory (degraded) if it cannot be opened.
func SharedAuditStore() audit.Store {
	auditStoreOnce.Do(func() {
		if st, err := audit.NewSQLiteStore(auditDBPath()); err == nil {
			defaultAuditStore = st
		} else {
			defaultAuditStore = audit.NewNullStore()
		}
	})
	return defaultAuditStore
}

// recordAudit is a fire-and-forget helper used across handlers. A nil store or
// a write error never blocks the primary operation.
func recordAudit(st audit.Store, actor string, action audit.Action, target, detail string) {
	if st == nil {
		return
	}
	_ = st.Append(audit.Entry{Actor: actor, Action: action, Target: target, Detail: detail})
}

// ---- AdminHandler -----------------------------------------------------------

type AdminHandler struct {
	invites invites.Store
	audit   audit.Store
	creds   userauth.Store
}

func NewAdminHandler() *AdminHandler {
	return &AdminHandler{invites: SharedInviteStore(), audit: SharedAuditStore(), creds: SharedCredsStore()}
}

// NewAdminHandlerWith builds a handler over caller-supplied stores (tests).
func NewAdminHandlerWith(inv invites.Store, aud audit.Store) *AdminHandler {
	return &AdminHandler{invites: inv, audit: aud, creds: userauth.NewNullStore()}
}

// NewAdminHandlerWithCreds builds a handler over caller-supplied invite, audit,
// and credential stores (tests that exercise the real-member seat count).
func NewAdminHandlerWithCreds(inv invites.Store, aud audit.Store, creds userauth.Store) *AdminHandler {
	return &AdminHandler{invites: inv, audit: aud, creds: creds}
}

// currentSeatUsage returns the number of seats currently consumed: the count of
// REAL registered members PLUS outstanding (active, unexpired) invites. Counting
// real members closes the churn-bypass hole where revoking/expiring invites
// freed seats without removing the members they admitted. Shared by the admin
// invite-mint gate and the register/accept-invite gate so both see one count.
//
// It does NOT fail open: a store error returns a non-nil error so the caller
// treats the situation as "cannot determine seats → cannot add" rather than
// silently dropping the cap to zero.
func currentSeatUsage(creds userauth.Store, inv invites.Store) (int64, error) {
	var members int64
	if creds != nil {
		n, err := creds.CountUsers()
		if err != nil {
			return 0, err
		}
		members = n
	}

	if inv == nil {
		return members, nil
	}
	list, err := inv.List()
	if err != nil {
		return 0, err
	}
	now := time.Now()
	var pending int64
	for _, i := range list {
		if i.Active(now) {
			pending++
		}
	}
	return members + pending, nil
}

// activeSeatCount returns the seats consumed for this handler's stores.
func (h *AdminHandler) activeSeatCount() (int64, error) {
	return currentSeatUsage(h.creds, h.invites)
}

// requireAdmin enforces the admin scope; writes 403 and returns false otherwise.
func requireAdmin(c *gin.Context) bool {
	if c.GetBool(middleware.CtxIsAdmin) {
		return true
	}
	c.JSON(http.StatusForbidden, gin.H{"error": "admin privileges required"})
	return false
}

// MintInvite POST /api/admin/invites
//
//	body: { "note": "alice@vulos.org", "max_uses": 1, "ttl_hours": 168 }
//
// Returns the RAW token exactly once (never stored). max_uses<=0 → single use;
// ttl_hours<=0 → never expires.
func (h *AdminHandler) MintInvite(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	var req struct {
		Note     string `json:"note"`
		MaxUses  int    `json:"max_uses"`
		TTLHours int    `json:"ttl_hours"`
	}
	_ = c.ShouldBindJSON(&req)
	ttl := time.Duration(req.TTLHours) * time.Hour
	actor := requesterID(c)

	// SEATS GATE: minting an invite consumes a seat. Enforce max_seats BEFORE
	// minting (server-side, before the token is issued). Current seat usage is the
	// count of REAL registered members plus outstanding active invites. Standalone
	// → unlimited → no-op. A store error is NOT treated as zero seats (that would
	// silently disable the cap); we refuse the mint so the cap cannot be bypassed.
	seats, err := h.activeSeatCount()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "cannot determine current seat usage; try again"})
		return
	}
	if d := billing.GateSeats(c.Request.Context(), actor, seats); !d.Allowed() {
		c.JSON(d.Code, gin.H{"error": d.Reason})
		return
	}

	raw, inv, err := h.invites.Mint(actor, req.Note, req.MaxUses, ttl)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	recordAudit(h.audit, actor, audit.ActionInviteMint, inv.ID, "note="+req.Note)
	// METER: report the seat consumption after a successful mint.
	billing.MeterSeats(c.Request.Context(), actor)
	// token is the ONLY time the raw secret is returned.
	c.JSON(http.StatusCreated, gin.H{"token": raw, "invite": inv})
}

// ListInvites GET /api/admin/invites — metadata only (never the raw token).
func (h *AdminHandler) ListInvites(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	list, err := h.invites.List()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if list == nil {
		list = []invites.Invite{}
	}
	c.JSON(http.StatusOK, list)
}

// RevokeInvite DELETE /api/admin/invites/:id
func (h *AdminHandler) RevokeInvite(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	id := c.Param("id")
	if err := h.invites.Revoke(id); err != nil {
		if err == invites.ErrNotFound {
			c.JSON(http.StatusNotFound, gin.H{"error": "invite not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	recordAudit(h.audit, requesterID(c), audit.ActionInviteRevoke, id, "")
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ListAudit GET /api/admin/audit?limit=N — append-only log, newest first.
func (h *AdminHandler) ListAudit(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	limit := parseLimit(c.Query("limit"), 200)
	entries, err := h.audit.List(limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if entries == nil {
		entries = []audit.Entry{}
	}
	c.JSON(http.StatusOK, entries)
}

func parseLimit(s string, def int) int {
	if s == "" {
		return def
	}
	n := 0
	for _, r := range s {
		if r < '0' || r > '9' {
			return def
		}
		n = n*10 + int(r-'0')
		if n > 5000 {
			return 5000
		}
	}
	if n == 0 {
		return def
	}
	return n
}
