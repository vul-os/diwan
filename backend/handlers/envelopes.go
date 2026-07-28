package handlers

import (
	"net/http"
	"time"

	"diwan/backend/models"
	"diwan/backend/storage"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// EnvelopeHandler implements CRUD for signing envelopes (OFFICE-41).
//
// Authorization (closes the e-signature IDOR): every envelope op is gated by
// the same per-file ACL model (backend/fileacl) used for Docs/Sheets/Slides.
// An envelope is tied to its SourceFileID — the document being signed — and the
// owner of that file (or anyone it is shared with, or an admin) is the only
// principal allowed to read/modify/delete the envelope or seal it. On create we
// also stamp the *envelope id* as ACL-owned by the caller so envelopes whose
// SourceFileID is empty/unowned are still private to their creator. Denied
// requests return 404 (never 403) so the response never leaks whether an
// envelope a caller cannot see actually exists.
type EnvelopeHandler struct {
	store storage.Storage
	authz *FileAuthz
}

func NewEnvelopeHandler(store storage.Storage) *EnvelopeHandler {
	return &EnvelopeHandler{store: store, authz: SharedFileAuthz()}
}

// NewEnvelopeHandlerWithAuthz builds a handler over a caller-supplied authorizer
// (tests use an in-memory NullStore so they never touch disk).
func NewEnvelopeHandlerWithAuthz(store storage.Storage, authz *FileAuthz) *EnvelopeHandler {
	return &EnvelopeHandler{store: store, authz: authz}
}

// canAccessEnvelope reports whether the caller may touch env. Access is granted
// when the caller can access the envelope's SourceFileID OR the envelope id
// itself (envelope id is recorded as ACL-owned by the creator). Admins always
// pass via FileAuthz.canAccess.
func (h *EnvelopeHandler) canAccessEnvelope(c *gin.Context, env *models.Envelope) bool {
	return h.authz.canAccessEnvelopeACL(c, env.SourceFileID, env.ID)
}

// requireEnvelope loads the envelope and enforces access. On any denial (missing
// or unauthorized) it writes a 404 and returns (nil, false); callers `return`.
func (h *EnvelopeHandler) requireEnvelope(c *gin.Context, id string) (*models.Envelope, bool) {
	env, err := h.store.GetEnvelope(id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "envelope not found"})
		return nil, false
	}
	if !h.canAccessEnvelope(c, env) {
		// 404 (not 403) so we never leak that the envelope exists.
		c.JSON(http.StatusNotFound, gin.H{"error": "envelope not found"})
		return nil, false
	}
	return env, true
}

// List — GET /api/envelopes
// Returns only the envelopes the caller may access (owned/shared source file, or
// owned envelope id). Admins see everything.
func (h *EnvelopeHandler) List(c *gin.Context) {
	envs, err := h.store.ListEnvelopes()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	out := make([]*models.Envelope, 0, len(envs))
	for _, env := range envs {
		if h.canAccessEnvelope(c, env) {
			out = append(out, env)
		}
	}
	c.JSON(http.StatusOK, out)
}

// Get — GET /api/envelopes/:id
func (h *EnvelopeHandler) Get(c *gin.Context) {
	env, ok := h.requireEnvelope(c, c.Param("id"))
	if !ok {
		return
	}
	c.JSON(http.StatusOK, env)
}

// Create — POST /api/envelopes
// Accepts a full Envelope payload (including fields + signers) from the
// frontend SigningSetup component.
func (h *EnvelopeHandler) Create(c *gin.Context) {
	var env models.Envelope
	if err := c.ShouldBindJSON(&env); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// The caller must be allowed to create an envelope over the referenced
	// source document. If a SourceFileID is supplied, enforce access to it so a
	// user cannot wrap a document they cannot see in a signing envelope. An empty
	// SourceFileID is permitted (draft / not-yet-attached) and the envelope is
	// scoped private via its own id below.
	if env.SourceFileID != "" && !h.authz.require(c, env.SourceFileID) {
		return
	}

	now := time.Now().UTC()
	// SECURITY: never honor a client-supplied envelope id. The id flows into the
	// storage path (envelopePath) and is stamped as an ACL owner key, so a
	// crafted id ("../../x") could escape the store or hijack another envelope's
	// ownership. Always mint a fresh server-side id.
	env.ID = uuid.New().String()
	env.CreatedAt = now
	env.UpdatedAt = now
	if env.Status == "" {
		env.Status = models.EnvelopeStatusDraft
	}
	if env.OrderMode == "" {
		env.OrderMode = models.SigningOrderSequential
	}

	// Assign IDs to fields and signers if not already set.
	for _, f := range env.Fields {
		if f.ID == "" {
			f.ID = uuid.New().String()
		}
	}
	for _, s := range env.Signers {
		if s.ID == "" {
			s.ID = uuid.New().String()
		}
		if s.EnvelopeID == "" {
			s.EnvelopeID = env.ID
		}
		s.CreatedAt = now
		s.UpdatedAt = now
		if s.Status == "" {
			s.Status = models.SignerStatusPending
		}
	}

	if err := h.store.CreateEnvelope(&env); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Stamp the creating identity as owner of the envelope id so the envelope is
	// private by default even when SourceFileID is empty/unowned.
	h.authz.recordOwner(c, env.ID)

	// Emit a "created" audit event (hash-chained — first event, prev="" by design).
	audit := &models.AuditEvent{
		ID:         uuid.New().String(),
		EnvelopeID: env.ID,
		Action:     models.AuditActionCreated,
		Timestamp:  now,
		Identity:   identityFromContext(c),
		IP:         c.ClientIP(),
	}
	_, _ = appendChainedAuditEvent(h.store, audit) // best-effort

	c.JSON(http.StatusCreated, env)
}

// Update — PUT /api/envelopes/:id
// Replaces the full envelope (fields + signers included).
func (h *EnvelopeHandler) Update(c *gin.Context) {
	id := c.Param("id")
	existing, ok := h.requireEnvelope(c, id)
	if !ok {
		return
	}

	var env models.Envelope
	if err := c.ShouldBindJSON(&env); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	env.ID = id
	// Preserve the source document binding — a client must not be able to
	// re-point an envelope it owns at a file it does not own to change its ACL.
	env.SourceFileID = existing.SourceFileID
	env.CreatedAt = existing.CreatedAt
	env.UpdatedAt = time.Now().UTC()
	if env.Status == "" {
		env.Status = existing.Status
	}
	if env.OrderMode == "" {
		env.OrderMode = existing.OrderMode
	}

	now := env.UpdatedAt
	for _, f := range env.Fields {
		if f.ID == "" {
			f.ID = uuid.New().String()
		}
	}
	for _, s := range env.Signers {
		if s.ID == "" {
			s.ID = uuid.New().String()
		}
		if s.EnvelopeID == "" {
			s.EnvelopeID = id
		}
		if s.CreatedAt.IsZero() {
			s.CreatedAt = now
		}
		s.UpdatedAt = now
		if s.Status == "" {
			s.Status = models.SignerStatusPending
		}
	}

	if err := h.store.UpdateEnvelope(&env); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, env)
}

// Delete — DELETE /api/envelopes/:id
func (h *EnvelopeHandler) Delete(c *gin.Context) {
	id := c.Param("id")
	if _, ok := h.requireEnvelope(c, id); !ok {
		return
	}
	if err := h.store.DeleteEnvelope(id); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "envelope not found"})
		return
	}
	// Drop the envelope-id ACL entry we recorded on create (source-file ACL is
	// owned by the file lifecycle and left intact).
	_ = h.authz.Store().Delete(id)
	c.JSON(http.StatusNoContent, nil)
}
