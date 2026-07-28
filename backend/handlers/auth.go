package handlers

import (
	"crypto/sha256"
	"crypto/subtle"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"diwan/backend/audit"
	"diwan/backend/billing"
	"diwan/backend/config"
	"diwan/backend/invites"
	"diwan/backend/middleware"
	"diwan/backend/models"
	"diwan/backend/userauth"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
)

type attemptRecord struct {
	count       int
	lockedUntil time.Time
	// lastSeen is updated on every request touching this record. It drives the
	// TTL sweep in sweepAttemptsLocked so stale per-IP entries (the client never
	// came back, or the IP was spoofed/rotated) don't accumulate forever.
	lastSeen time.Time
}

// attemptTTL bounds how long a per-IP login-attempt record is kept after its
// last activity. Without this, AuthHandler.attempts (keyed by client IP, which
// an attacker fully controls via spoofed/rotating source addresses or the
// X-Forwarded-For chain) grows without bound — an unbounded-memory DoS.
const attemptTTL = 30 * time.Minute

// maxAttemptRecords hard-caps the map size as a second line of defense: even
// under a burst faster than the TTL sweep interval, the map is never allowed
// to grow past this many tracked IPs — the oldest entries are evicted first.
const maxAttemptRecords = 10000

// attemptSweepInterval is the minimum spacing between sweeps so a busy login
// endpoint doesn't pay the O(n) sweep cost on every single request.
const attemptSweepInterval = time.Minute

type AuthHandler struct {
	cfg      *config.Config
	mu       sync.Mutex
	attempts map[string]*attemptRecord
	// lastSweep records when sweepAttemptsLocked last ran (mu-protected).
	lastSweep time.Time
	// creds is the per-user credential store. When it holds registered users,
	// login verifies against it and the JWT subject is bound to the
	// authenticated account (no longer self-asserted by the client).
	creds userauth.Store
	// invites mints/consumes single-use registration invite tokens (additive to
	// the static DIWAN_REGISTRATION_TOKEN + admin-JWT paths).
	invites invites.Store
	// audit records registration / invite-consume events (append-only).
	audit audit.Store
}

func NewAuthHandler(cfg *config.Config) *AuthHandler {
	// Use the process-wide shared credential store so the register path's seat
	// count and the admin seat gate see the SAME members.
	return &AuthHandler{
		cfg:      cfg,
		attempts: make(map[string]*attemptRecord),
		creds:    SharedCredsStore(),
		invites:  SharedInviteStore(),
		audit:    SharedAuditStore(),
	}
}

// NewAuthHandlerWithCreds builds a handler over a caller-supplied credential
// store (tests use an in-memory NullStore). Invite + audit stores default to
// in-memory NullStores; use NewAuthHandlerWithStores to inject them.
func NewAuthHandlerWithCreds(cfg *config.Config, creds userauth.Store) *AuthHandler {
	return &AuthHandler{
		cfg:      cfg,
		attempts: make(map[string]*attemptRecord),
		creds:    creds,
		invites:  invites.NewNullStore(),
		audit:    audit.NewNullStore(),
	}
}

// NewAuthHandlerWithStores builds a handler over caller-supplied credential,
// invite, and audit stores (tests).
func NewAuthHandlerWithStores(cfg *config.Config, creds userauth.Store, inv invites.Store, aud audit.Store) *AuthHandler {
	return &AuthHandler{
		cfg:      cfg,
		attempts: make(map[string]*attemptRecord),
		creds:    creds,
		invites:  inv,
		audit:    aud,
	}
}

// requestIsHTTPS reports whether the session cookie should be marked Secure:
// either this process terminated TLS directly, or a reverse proxy in front of
// it forwarded X-Forwarded-Proto: https (the standard signal when TLS is
// terminated upstream, e.g. Fly/nginx — Office already trusts this proxy
// boundary elsewhere, see the CORS setup in main.go). Without this, the
// session cookie was never marked Secure even when served over HTTPS, so it
// could be sent over a downgraded plain-HTTP connection (e.g. via active
// network MITM) and captured.
func requestIsHTTPS(r *http.Request) bool {
	if r == nil {
		return false
	}
	if r.TLS != nil {
		return true
	}
	return strings.EqualFold(strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")), "https")
}

// Me is the shells' auth boundary (src/shells/RequireAuth.jsx): it answers "is
// the caller authenticated, and as whom", 401 when not.
//
// It MUST sit behind the same AuthWithSSO gate the protected routes use, so its
// verdict matches what the server actually enforces. That is why this is not
// simply /auth/status: Status reports only on Office's OWN product JWT, and in
// cloud the user is authenticated by the CP session/app token instead — so a
// shell keyed off Status would bounce every SSO user into a login redirect loop.
// Reaching this handler at all means the middleware already authenticated the
// request; an unauthenticated caller is rejected upstream with 401.
func (h *AuthHandler) Me(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"authenticated": true,
		"user_id":       c.GetString(middleware.CtxUserID),
		"tenant_id":     c.GetString(middleware.CtxTenantID),
		"is_admin":      c.GetBool(middleware.CtxIsAdmin),
	})
}

func (h *AuthHandler) Status(c *gin.Context) {
	authenticated := false
	if h.cfg.Auth.Enabled {
		token := c.GetHeader("Authorization")
		if len(token) > 7 {
			token = token[7:]
		}
		if token == "" {
			if cookie, err := c.Cookie("session"); err == nil {
				token = cookie
			}
		}
		if token != "" {
			if secret, serr := middleware.JWTSecret(); serr == nil {
				claims := &jwt.RegisteredClaims{}
				parsed, err := jwt.ParseWithClaims(token, claims, func(t *jwt.Token) (interface{}, error) {
					if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
						return nil, jwt.ErrTokenSignatureInvalid
					}
					return secret, nil
				})
				authenticated = err == nil && parsed.Valid
			}
		}
	} else {
		authenticated = true
	}

	c.JSON(http.StatusOK, models.AuthStatusResponse{
		Enabled:       h.cfg.Auth.Enabled,
		Authenticated: authenticated,
	})
}

// sweepAttemptsLocked evicts login-attempt records that have gone quiet for
// longer than attemptTTL, then — if the map is still oversized (e.g. a burst
// of distinct IPs within the TTL window) — evicts the oldest remaining
// entries by lastSeen until the map is back at or under maxAttemptRecords.
// Caller MUST hold h.mu. Rate-limited by lastSweep/attemptSweepInterval so a
// busy login endpoint doesn't pay the O(n) scan on every call.
func (h *AuthHandler) sweepAttemptsLocked(now time.Time) {
	if now.Sub(h.lastSweep) < attemptSweepInterval && len(h.attempts) <= maxAttemptRecords {
		return
	}
	h.lastSweep = now
	for ip, rec := range h.attempts {
		if now.Sub(rec.lastSeen) > attemptTTL {
			delete(h.attempts, ip)
		}
	}
	if len(h.attempts) <= maxAttemptRecords {
		return
	}
	// Still oversized: evict the oldest entries (by lastSeen) down to the cap.
	type ipSeen struct {
		ip   string
		seen time.Time
	}
	entries := make([]ipSeen, 0, len(h.attempts))
	for ip, rec := range h.attempts {
		entries = append(entries, ipSeen{ip, rec.lastSeen})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].seen.Before(entries[j].seen) })
	for _, e := range entries[:len(entries)-maxAttemptRecords] {
		delete(h.attempts, e.ip)
	}
}

func (h *AuthHandler) Login(c *gin.Context) {
	if !h.cfg.Auth.Enabled {
		c.JSON(http.StatusOK, models.LoginResponse{Message: "auth not required"})
		return
	}

	ip := c.ClientIP()
	now := time.Now()

	h.mu.Lock()
	h.sweepAttemptsLocked(now)
	rec, ok := h.attempts[ip]
	if !ok {
		rec = &attemptRecord{}
		h.attempts[ip] = rec
	}
	rec.lastSeen = now

	// Check lockout
	if now.Before(rec.lockedUntil) {
		h.mu.Unlock()
		c.JSON(http.StatusTooManyRequests, models.ErrorResponse{
			Error:       "account locked",
			LockedUntil: rec.lockedUntil.Format(time.RFC3339),
		})
		return
	}
	h.mu.Unlock()

	var req models.LoginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{Error: "invalid request"})
		return
	}

	// Determine the verified subject for the JWT.
	//
	//   - If any per-user credentials are registered, login MUST authenticate
	//     against the credential store and the subject becomes the *canonical*
	//     account id returned by Verify — never the client-supplied AccountID.
	//   - Otherwise (no users registered) fall back to the legacy shared-password
	//     path for OSS single-user / local mode. In that mode the subject is the
	//     supplied AccountID (or "self"), which is acceptable because there is no
	//     multi-user store to protect.
	subject := req.AccountID
	authOK := false
	hasUsers := false
	if h.creds != nil {
		if hu, err := h.creds.HasUsers(); err == nil {
			hasUsers = hu
		}
	}
	if hasUsers {
		if canonical, err := h.creds.Verify(req.AccountID, req.Password); err == nil {
			subject = canonical
			authOK = true
		}
	} else {
		// Shared-password fallback (legacy single-user mode). Reject an empty
		// supplied OR configured password outright (an empty configured password
		// must never authenticate anyone), and compare in constant time to avoid
		// leaking the password length/prefix via timing.
		if req.Password != "" && h.cfg.Auth.Password != "" {
			// Compare fixed-width sha256 digests: a raw ConstantTimeCompare
			// short-circuits on a length mismatch, leaking the configured
			// password's byte-length via timing. Hashing both sides to 32 bytes
			// first closes that side-channel with no behaviour change.
			got := sha256.Sum256([]byte(req.Password))
			want := sha256.Sum256([]byte(h.cfg.Auth.Password))
			if subtle.ConstantTimeCompare(got[:], want[:]) == 1 {
				authOK = true
			}
		}
		if subject == "" {
			subject = "self"
		}
	}

	if !authOK {
		h.mu.Lock()
		rec.count++
		remaining := h.cfg.Auth.MaxAttempts - rec.count
		if remaining <= 0 {
			rec.lockedUntil = time.Now().Add(time.Duration(h.cfg.Auth.LockoutMinutes) * time.Minute)
			rec.count = 0
			remaining = 0
		}
		h.mu.Unlock()

		status := http.StatusUnauthorized
		if remaining == 0 {
			status = http.StatusTooManyRequests
		}
		c.JSON(status, models.ErrorResponse{
			Error:             "incorrect password",
			RemainingAttempts: remaining,
		})
		return
	}

	// Success — reset attempts
	h.mu.Lock()
	rec.count = 0
	rec.lockedUntil = time.Time{}
	h.mu.Unlock()

	expiry := time.Duration(h.cfg.Auth.SessionHours) * time.Hour
	if expiry == 0 {
		expiry = 24 * time.Hour
	}

	secret, serr := middleware.JWTSecret()
	if serr != nil {
		c.JSON(http.StatusServiceUnavailable, models.ErrorResponse{Error: "server auth not configured"})
		return
	}

	claims := jwt.RegisteredClaims{
		// Subject carries the VERIFIED account id (from the credential store when
		// per-user auth is active, otherwise the shared-mode subject). Downstream
		// handlers read it from context instead of trusting any client header,
		// and it is no longer self-asserted when real credentials exist.
		Subject:   subject,
		ExpiresAt: jwt.NewNumericDate(time.Now().Add(expiry)),
		IssuedAt:  jwt.NewNumericDate(time.Now()),
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := token.SignedString(secret)
	if err != nil {
		c.JSON(http.StatusInternalServerError, models.ErrorResponse{Error: "failed to create session"})
		return
	}

	http.SetCookie(c.Writer, &http.Cookie{
		Name:     "session",
		Value:    signed,
		MaxAge:   int(expiry.Seconds()),
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   requestIsHTTPS(c.Request),
	})
	// Return only a success message — never expose the token in the response body
	// so JavaScript cannot read it.
	c.JSON(http.StatusOK, models.LoginResponse{Message: "logged in"})
}

// EnvRegistrationToken is the env var holding the registration/invite token. It
// gates registration once the instance is bootstrapped (≥1 user) so a stranger
// cannot register new accounts on a running multi-user instance. The token is
// supplied by the client via the X-Registration-Token header.
const EnvRegistrationToken = "DIWAN_REGISTRATION_TOKEN"

// reservedPrivilegedID reports whether accountID looks like a privileged /
// system identity that must NOT be self-registered by an unauthenticated or
// non-admin caller (e.g. admin@, root@, the bare "self"/"system" handles, or any
// "admin"/"root" local-part). This blocks the "register admin@vulos.org while
// HasUsers==false" privilege grab — only the holder of the registration token
// may claim such an id.
func reservedPrivilegedID(accountID string) bool {
	id := strings.ToLower(strings.TrimSpace(accountID))
	if id == "" {
		return false
	}
	if id == "self" || id == "system" || id == "admin" || id == "root" {
		return true
	}
	local := id
	if at := strings.Index(id, "@"); at >= 0 {
		local = id[:at]
	}
	switch local {
	case "admin", "administrator", "root", "superuser", "system", "postmaster", "security":
		return true
	}
	return false
}

// passwordPolicyError returns a non-empty reason when pw fails the minimal
// password policy: ≥10 chars and at least two distinct character classes
// (lower / upper / digit / symbol). Rejects trivially weak passwords like
// "password" or "12345678" without being onerous for a self-host operator.
func passwordPolicyError(pw string) string {
	if len(pw) < 10 {
		return "password must be at least 10 characters"
	}
	var hasLower, hasUpper, hasDigit, hasSymbol bool
	for _, r := range pw {
		switch {
		case r >= 'a' && r <= 'z':
			hasLower = true
		case r >= 'A' && r <= 'Z':
			hasUpper = true
		case r >= '0' && r <= '9':
			hasDigit = true
		default:
			hasSymbol = true
		}
	}
	classes := 0
	for _, ok := range []bool{hasLower, hasUpper, hasDigit, hasSymbol} {
		if ok {
			classes++
		}
	}
	if classes < 2 {
		return "password must mix at least two of: lowercase, uppercase, digits, symbols"
	}
	return ""
}

// registrationTokenOK reports whether the request carries the configured
// registration/invite token. Returns (configured, valid):
//   - configured=false → no token is set in the environment (registration on a
//     bootstrapped instance is then closed entirely; only first-user bootstrap
//     is allowed).
//   - valid=true → the supplied X-Registration-Token matched (constant-time).
func registrationTokenOK(c *gin.Context) (configured, valid bool) {
	want := strings.TrimSpace(os.Getenv(EnvRegistrationToken))
	if want == "" {
		return false, false
	}
	got := strings.TrimSpace(c.GetHeader("X-Registration-Token"))
	if got == "" {
		return true, false
	}
	// Compare fixed-width sha256 digests rather than the raw token: a direct
	// ConstantTimeCompare short-circuits on a length mismatch, leaking the
	// configured token's byte-length via timing. Hashing both sides to 32 bytes
	// first closes that side-channel (correct token still accepted, wrong
	// rejected).
	gotH := sha256.Sum256([]byte(got))
	wantH := sha256.Sum256([]byte(want))
	return true, subtle.ConstantTimeCompare(gotH[:], wantH[:]) == 1
}

// requestIsAdmin validates an optional session JWT on the request and reports
// whether it carries the "vulos:admin" audience. Used by Register (which is
// mounted unauthenticated) so an admin can provision accounts even though the
// route did not pass through middleware.Auth. Mirrors the verification in
// middleware.Auth (HMAC pinned to reject alg-confusion).
func (h *AuthHandler) requestIsAdmin(c *gin.Context) bool {
	token := c.GetHeader("Authorization")
	if strings.HasPrefix(token, "Bearer ") {
		token = strings.TrimPrefix(token, "Bearer ")
	} else if cookie, err := c.Cookie("session"); err == nil {
		token = cookie
	} else {
		return false
	}
	if token == "" {
		return false
	}
	secret, err := middleware.JWTSecret()
	if err != nil {
		return false
	}
	claims := &jwt.RegisteredClaims{}
	parsed, perr := jwt.ParseWithClaims(token, claims, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, jwt.ErrTokenSignatureInvalid
		}
		return secret, nil
	})
	if perr != nil || !parsed.Valid {
		return false
	}
	for _, aud := range claims.Audience {
		if aud == "vulos:admin" {
			return true
		}
	}
	return false
}

// Register creates a per-user credential (account id + bcrypt password hash).
//
//	POST /api/auth/register  { "account_id": "alice@vulos.org", "password": "..." }
//	  (optional header) X-Registration-Token: <invite/admin token>
//
// Gating (closes the unauthenticated-registration + first-user TOCTOU +
// arbitrary-privileged-id holes):
//
//   - FIRST USER (atomic bootstrap): when the credential store is empty the very
//     first registration is allowed without a token via the store's atomic
//     RegisterFirst (a transaction-guarded count-then-insert), so two concurrent
//     callers cannot both win the bootstrap. A reserved/privileged id
//     (admin@, root@, …) still requires the registration token even as the first
//     user, so the first account is a normal user unless the operator opts in.
//
//   - BOOTSTRAPPED INSTANCE (≥1 user): registration REQUIRES the configured
//     registration/invite token (X-Registration-Token, validated constant-time).
//     If no token is configured, registration is CLOSED on a running instance —
//     a stranger can no longer self-register. An admin JWT also satisfies the
//     gate (an admin may provision accounts).
//
//   - Password policy is enforced for every registration.
func (h *AuthHandler) Register(c *gin.Context) {
	if !h.cfg.Auth.Enabled {
		c.JSON(http.StatusOK, models.LoginResponse{Message: "auth not required"})
		return
	}
	if h.creds == nil {
		c.JSON(http.StatusServiceUnavailable, models.ErrorResponse{Error: "credential store unavailable"})
		return
	}
	var req models.LoginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{Error: "invalid request"})
		return
	}
	if strings.TrimSpace(req.AccountID) == "" {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{Error: "account_id required"})
		return
	}
	if reason := passwordPolicyError(req.Password); reason != "" {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{Error: reason})
		return
	}

	hasUsers := false
	if hu, err := h.creds.HasUsers(); err == nil {
		hasUsers = hu
	}

	// Token / admin authorization signal. Register is mounted on the
	// UNauthenticated route group (so the first user can bootstrap without a
	// token), therefore the admin scope is not present in context — detect it by
	// validating an optional admin JWT on the request directly.
	tokenConfigured, tokenValid := registrationTokenOK(c)
	isAdmin := c.GetBool(middleware.CtxIsAdmin) || h.requestIsAdmin(c)

	// Invite-token path (additive to the static token + admin JWT). The same
	// X-Registration-Token header may carry a single-use/expiring invite minted
	// by an admin. We only VALIDATE here (no consume yet) so a token is burned
	// only once the account is actually created below.
	headerTok := strings.TrimSpace(c.GetHeader("X-Registration-Token"))
	inviteValid := false
	if !tokenValid && !isAdmin && headerTok != "" && h.invites != nil {
		if _, err := h.invites.Valid(headerTok); err == nil {
			inviteValid = true
		}
	}

	authorized := tokenValid || isAdmin || inviteValid

	// consumeInvite burns the invite token after a successful create and records
	// it in the audit log. A no-op unless this registration was authorized by an
	// invite (not by the static token / admin).
	consumeInvite := func(accountID string) {
		if !inviteValid {
			return
		}
		if inv, err := h.invites.Consume(headerTok); err == nil {
			recordAudit(h.audit, accountID, audit.ActionInviteConsume, inv.ID, "account="+accountID)
		}
	}

	// A privileged/system id may only be claimed by an authorized caller (token
	// or admin) — never by anonymous self-registration, even as the first user.
	if reservedPrivilegedID(req.AccountID) && !authorized {
		c.JSON(http.StatusForbidden, models.ErrorResponse{Error: "this account id is reserved"})
		return
	}

	if !hasUsers && !authorized {
		// Unauthenticated FIRST-user bootstrap — atomic so the TOCTOU race is
		// closed. If another caller bootstrapped in the meantime, RegisterFirst
		// returns ErrNotFirstUser and we fall through to the gated requirement.
		switch err := h.creds.RegisterFirst(req.AccountID, req.Password); err {
		case nil:
			recordAudit(h.audit, req.AccountID, audit.ActionRegister, req.AccountID, "first-user bootstrap")
			c.JSON(http.StatusCreated, models.LoginResponse{Message: "registered"})
			return
		case userauth.ErrUserExists:
			c.JSON(http.StatusConflict, models.ErrorResponse{Error: "account already registered"})
			return
		case userauth.ErrNotFirstUser:
			// Lost the bootstrap race — now bootstrapped; require a token below.
		default:
			c.JSON(http.StatusInternalServerError, models.ErrorResponse{Error: "failed to register"})
			return
		}
	}

	// Bootstrapped instance: require an authorized caller.
	if !authorized {
		if !tokenConfigured {
			// No registration token configured → registration is closed.
			c.JSON(http.StatusForbidden, models.ErrorResponse{Error: "registration is closed; an invite token is required"})
			return
		}
		c.JSON(http.StatusUnauthorized, models.ErrorResponse{Error: "valid registration token required"})
		return
	}

	// SEATS GATE: admitting a new member via the register/accept-invite path
	// consumes a seat. Enforce max_seats BEFORE creating the credential (this path
	// was previously never seat-gated). Current usage counts real members + active
	// invites and does NOT fail open. Standalone → unlimited → no-op.
	seats, serr := currentSeatUsage(h.creds, h.invites)
	if serr != nil {
		c.JSON(http.StatusServiceUnavailable, models.ErrorResponse{Error: "cannot determine seat usage; try again"})
		return
	}
	if d := billing.GateSeats(c.Request.Context(), req.AccountID, seats); !d.Allowed() {
		c.JSON(d.Code, models.ErrorResponse{Error: d.Reason})
		return
	}

	switch err := h.creds.Register(req.AccountID, req.Password); err {
	case nil:
		consumeInvite(req.AccountID)
		// METER the added seat after a successful member create.
		billing.MeterSeats(c.Request.Context(), req.AccountID)
		via := "static-token-or-admin"
		if inviteValid {
			via = "invite-token"
		}
		recordAudit(h.audit, req.AccountID, audit.ActionRegister, req.AccountID, "via="+via)
		c.JSON(http.StatusCreated, models.LoginResponse{Message: "registered"})
	case userauth.ErrUserExists:
		c.JSON(http.StatusConflict, models.ErrorResponse{Error: "account already registered"})
	default:
		c.JSON(http.StatusInternalServerError, models.ErrorResponse{Error: "failed to register"})
	}
}

func (h *AuthHandler) Logout(c *gin.Context) {
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     "session",
		Value:    "",
		MaxAge:   -1,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   requestIsHTTPS(c.Request),
	})
	c.JSON(http.StatusOK, gin.H{"message": "logged out"})
}
