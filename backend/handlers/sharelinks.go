package handlers

// sharelinks.go — expiring / password-protected read-only share links + the
// anonymous, token-gated view route they back, plus transfer-ownership.
//
// Threat model / invariants:
//   - Minting, listing, and revoking a link is OWNER-GATED (requireOwner). A
//     collaborator or stranger cannot create or enumerate links.
//   - The token is 256 bits of randomness (signing.GenerateShareLinkToken):
//     unguessable, so possession == access, and revocable so a leaked link dies.
//   - The token itself is stored ONLY as a SHA-256 hash, the same discipline
//     backend/invites applies to registration tokens. It is returned to the
//     owner exactly once — in the mint response — and never again, because no
//     backend can produce it. Reading the share-link store therefore yields
//     hashes, not working capabilities.
//   - A password, when set, is stored ONLY as a bcrypt hash; the plaintext never
//     touches disk and the view route rejects access until the correct password
//     is supplied. The hash is never serialized to any client.
//   - Expiry hard-bounds the link; an expired/revoked link resolves as "not
//     found" (no oracle distinguishing expired from never-existed beyond the
//     explicit 410 we choose for expired, which does not leak the file).
//   - The view route is strictly READ-ONLY: it returns id/name/type/content of a
//     single file and nothing else. There is no write, share, ACL, or version
//     path reachable through a share-link token — no privilege escalation.

import (
	"log"
	"net/http"
	"time"

	"diwan/backend/audit"
	"diwan/backend/fileacl"
	"diwan/backend/models"
	"diwan/backend/signing"
	"diwan/backend/storage"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
)

// maxShareLinkTTL bounds how far in the future a link may be set to expire (1
// year). This mirrors the signing-token TTL discipline: no effectively-eternal
// anonymous credential.
const maxShareLinkTTL = 365 * 24 * time.Hour

// ShareLinkHandler serves the owner-side link management endpoints and the
// anonymous view route.
type ShareLinkHandler struct {
	store storage.Storage
	authz *FileAuthz
	audit audit.Store
}

func NewShareLinkHandler(store storage.Storage) *ShareLinkHandler {
	return &ShareLinkHandler{store: store, authz: SharedFileAuthz(), audit: SharedAuditStore()}
}

// NewShareLinkHandlerWithDeps builds a handler over caller-supplied deps (tests).
func NewShareLinkHandlerWithDeps(store storage.Storage, authz *FileAuthz, aud audit.Store) *ShareLinkHandler {
	return &ShareLinkHandler{store: store, authz: authz, audit: aud}
}

// ─── Owner-side management ───────────────────────────────────────────────────

// Create handles POST /api/files/:id/share-links.
func (h *ShareLinkHandler) Create(c *gin.Context) {
	id := c.Param("id")
	if !h.authz.requireOwner(c, id) {
		return
	}
	if _, err := h.store.GetFile(id); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "file not found"})
		return
	}

	var req models.CreateShareLinkRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		// Body is optional (a bare link is valid) — tolerate an empty/absent body.
		req = models.CreateShareLinkRequest{}
	}

	token, err := signing.GenerateShareLinkToken()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not mint token"})
		return
	}

	link := &models.ShareLink{
		ID:        uuid.New().String(),
		FileID:    id,
		Token:     token,
		CreatedBy: requesterID(c),
		CreatedAt: time.Now(),
	}

	if req.Password != "" {
		hash, herr := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
		if herr != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "could not secure link"})
			return
		}
		link.PasswordHash = string(hash)
		link.HasPassword = true
	}
	if req.ExpiresInSeconds > 0 {
		ttl := time.Duration(req.ExpiresInSeconds) * time.Second
		if ttl > maxShareLinkTTL {
			ttl = maxShareLinkTTL
		}
		exp := time.Now().Add(ttl)
		link.ExpiresAt = &exp
	}

	if err := h.store.CreateShareLink(link); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	recordAudit(h.audit, requesterID(c), audit.ActionShareLinkMint, id, "link="+link.ID)

	// This response is the ONLY place the raw token is ever emitted — the store
	// kept only its hash, so List can never return it again. PasswordHash is
	// json:"-", so it is never serialized at all.
	c.JSON(http.StatusCreated, link)
}

// List handles GET /api/files/:id/share-links.
//
// The returned records carry NO token (models.ShareLink.Token is omitempty and
// the store has only a hash), so this endpoint cannot be used to recover a link
// URL — by the owner or by anyone who reaches it. It is a management view:
// which links exist, whether they are password-gated, when they expire, and the
// id needed to revoke them.
func (h *ShareLinkHandler) List(c *gin.Context) {
	id := c.Param("id")
	if !h.authz.requireOwner(c, id) {
		return
	}
	links, err := h.store.ListShareLinks(id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if links == nil {
		links = []*models.ShareLink{}
	}
	c.JSON(http.StatusOK, gin.H{"links": links})
}

// Revoke handles DELETE /api/files/:id/share-links/:lid.
func (h *ShareLinkHandler) Revoke(c *gin.Context) {
	id := c.Param("id")
	lid := c.Param("lid")
	if !h.authz.requireOwner(c, id) {
		return
	}
	if err := h.store.RevokeShareLink(id, lid); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "share link not found"})
		return
	}
	recordAudit(h.audit, requesterID(c), audit.ActionShareLinkRevoke, id, "link="+lid)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ─── Anonymous view route (no auth) ──────────────────────────────────────────

// resolveActiveLink looks up a token and validates it is live (exists, not
// revoked, not expired). It returns the link and the file, or writes an error
// response and returns ok=false. It deliberately returns 404 for a missing or
// revoked link (no existence oracle) and 410 Gone for an expired one.
func (h *ShareLinkHandler) resolveActiveLink(c *gin.Context, token string) (*models.ShareLink, *models.File, bool) {
	link, err := h.store.GetShareLinkByToken(token)
	if err != nil || link == nil || link.Revoked {
		c.JSON(http.StatusNotFound, gin.H{"error": "link not found"})
		return nil, nil, false
	}
	if link.ExpiresAt != nil && time.Now().After(*link.ExpiresAt) {
		c.JSON(http.StatusGone, gin.H{"error": "this link has expired"})
		return nil, nil, false
	}
	file, ferr := h.store.GetFile(link.FileID)
	if ferr != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "document no longer exists"})
		return nil, nil, false
	}
	return link, file, true
}

// ViewMeta handles GET /api/share/:token — returns just enough for the viewer to
// decide whether to prompt for a password. NEVER returns content when a password
// is required and not yet supplied.
func (h *ShareLinkHandler) ViewMeta(c *gin.Context) {
	link, file, ok := h.resolveActiveLink(c, c.Param("token"))
	if !ok {
		return
	}
	if link.HasPassword {
		// Do not reveal name/content behind a password gate.
		c.JSON(http.StatusOK, gin.H{
			"requires_password": true,
			"type":              file.Type,
		})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"requires_password": false,
		"id":                file.ID,
		"name":              file.Name,
		"type":              file.Type,
		"content":           file.Content,
		"read_only":         true,
	})
}

// View handles POST /api/share/:token — token-gated read-only document fetch.
// A password link requires the correct password in the body; a bare link needs
// no body. This is the ONLY content-bearing anonymous endpoint and it is strictly
// read-only.
func (h *ShareLinkHandler) View(c *gin.Context) {
	link, file, ok := h.resolveActiveLink(c, c.Param("token"))
	if !ok {
		return
	}

	if link.HasPassword {
		var body struct {
			Password string `json:"password"`
		}
		_ = c.ShouldBindJSON(&body)
		if body.Password == "" {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "password required", "requires_password": true})
			return
		}
		if err := bcrypt.CompareHashAndPassword([]byte(link.PasswordHash), []byte(body.Password)); err != nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "incorrect password", "requires_password": true})
			return
		}
	}

	// Read-only projection: id/name/type/content only. No rev-CAS write path, no
	// ACL, no version, no share is reachable from here.
	c.JSON(http.StatusOK, gin.H{
		"id":        file.ID,
		"name":      file.Name,
		"type":      file.Type,
		"content":   file.Content,
		"read_only": true,
	})
}

// ─── Transfer ownership ──────────────────────────────────────────────────────

// TransferOwner handles POST /api/files/:id/transfer-owner. Only the current
// owner (or an admin) may transfer. The previous owner is demoted to editor so
// they keep access unless they remove themselves.
func (h *FileHandler) TransferOwner(c *gin.Context) {
	id := c.Param("id")
	if !h.authz.requireOwner(c, id) {
		return
	}
	if _, err := h.store.GetFile(id); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "file not found"})
		return
	}
	var req models.TransferOwnerRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	newOwner := req.NewOwner
	if newOwner == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "new_owner is required"})
		return
	}

	prevOwner := requesterID(c)
	if rec, ok, _ := h.authz.Store().Get(id); ok && rec.Owner != "" {
		prevOwner = rec.Owner
	}
	if newOwner == prevOwner {
		c.JSON(http.StatusBadRequest, gin.H{"error": "that account is already the owner"})
		return
	}

	// Set the new owner. If the new owner was a collaborator, remove that lesser
	// grant so the roster is not contradictory (owner + editor of self).
	if err := h.authz.Store().SetOwner(id, newOwner); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not transfer ownership"})
		return
	}
	_ = h.authz.Store().Unshare(id, newOwner)
	// Demote the previous owner to editor so they retain access.
	if prevOwner != "" {
		if err := h.authz.Store().ShareWithRole(id, prevOwner, fileacl.RoleEditor); err != nil {
			// Non-fatal: ownership already transferred, so we don't fail the
			// request — but a swallowed error here would silently leave the
			// previous owner locked out (no collaborator record at all), so log
			// it for operator visibility instead of discarding it.
			log.Printf("[sharelinks] TransferOwner(%s): demote previous owner %q to editor failed: %v", id, prevOwner, err)
		}
	}
	recordAudit(h.audit, requesterID(c), audit.ActionACLSetOwner, id, "new_owner="+newOwner)
	c.JSON(http.StatusOK, gin.H{"ok": true, "owner": newOwner})
}
