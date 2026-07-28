package handlers

// orchestration.go — OFFICE-45: Multi-signer orchestration + reminders.
//
// Routes (registered in main.go):
//   GET    /api/sign/:envelopeId/status   → per-envelope progress for all signers
//   POST   /api/sign/:envelopeId/remind   → re-emit reminder for pending signer(s)
//   POST   /api/sign/:envelopeId/cancel   → void the envelope (terminal)
//   POST   /api/sign/:token/decline       → signer declines (terminal per-signer)
//
// Orchestration is driven by advanceOrchestration, called from Complete.
// Sequential mode: on each signer completion, issue the next-order signer's
// token if it hasn't been issued yet.
// Parallel mode: all tokens issued up-front by Send; orchestration is a no-op.

import (
	"fmt"
	"log"
	"net/http"
	"net/smtp"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"diwan/backend/models"
	"diwan/backend/storage"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// OrchestrationHandler drives the multi-signer state machine.
type OrchestrationHandler struct {
	store storage.Storage
	authz *FileAuthz
}

func NewOrchestrationHandler(store storage.Storage) *OrchestrationHandler {
	return &OrchestrationHandler{store: store, authz: SharedFileAuthz()}
}

// NewOrchestrationHandlerWithAuthz builds the handler over a caller-supplied
// authorizer (tests use an in-memory NullStore).
func NewOrchestrationHandlerWithAuthz(store storage.Storage, authz *FileAuthz) *OrchestrationHandler {
	return &OrchestrationHandler{store: store, authz: authz}
}

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/sign/:envelopeId/status
// ──────────────────────────────────────────────────────────────────────────────

// SignerProgress is the per-signer element returned by the status endpoint.
type SignerProgress struct {
	ID        string              `json:"id"`
	Name      string              `json:"name"`
	Email     string              `json:"email"`
	Order     int                 `json:"order"`
	Status    models.SignerStatus `json:"status"`
	UpdatedAt time.Time           `json:"updated_at"`
}

// EnvelopeStatusResponse is the full status payload.
type EnvelopeStatusResponse struct {
	EnvelopeID string                  `json:"envelope_id"`
	Title      string                  `json:"title"`
	Status     models.EnvelopeStatus   `json:"status"`
	OrderMode  models.SigningOrderMode `json:"order_mode"`
	Signers    []SignerProgress        `json:"signers"`
	CreatedAt  time.Time               `json:"created_at"`
	UpdatedAt  time.Time               `json:"updated_at"`
}

// Status returns per-signer progress for the envelope.
//
// AC: status endpoint reflects each signer.
func (h *OrchestrationHandler) Status(c *gin.Context) {
	envelopeID := c.Param("id")

	env, err := h.store.GetEnvelope(envelopeID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "envelope not found"})
		return
	}

	// Authorization: the status payload leaks the full signer roster
	// (names/emails/status), so only the document/envelope owner (or admin) may
	// read it — matching Remind/Cancel/Send. Deny with 404 (never leak existence).
	if !h.authz.canAccessEnvelopeACL(c, env.SourceFileID, env.ID) {
		c.JSON(http.StatusNotFound, gin.H{"error": "envelope not found"})
		return
	}

	signers := make([]SignerProgress, 0, len(env.Signers))
	for _, sg := range env.Signers {
		signers = append(signers, SignerProgress{
			ID:        sg.ID,
			Name:      sg.Name,
			Email:     sg.Email,
			Order:     sg.Order,
			Status:    sg.Status,
			UpdatedAt: sg.UpdatedAt,
		})
	}
	// Sort by order for deterministic output.
	sort.Slice(signers, func(i, j int) bool { return signers[i].Order < signers[j].Order })

	c.JSON(http.StatusOK, EnvelopeStatusResponse{
		EnvelopeID: env.ID,
		Title:      env.Title,
		Status:     env.Status,
		OrderMode:  env.OrderMode,
		Signers:    signers,
		CreatedAt:  env.CreatedAt,
		UpdatedAt:  env.UpdatedAt,
	})
}

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/sign/:envelopeId/remind
// ──────────────────────────────────────────────────────────────────────────────

// Remind emits a reminder notification for all pending/viewed signers who have
// not yet completed. When SMTP env vars are configured, it sends email.
// When absent, it logs only.
//
// AC: reminder hooks (log/notify) for pending signers; honest "no mailer" response.
func (h *OrchestrationHandler) Remind(c *gin.Context) {
	envelopeID := c.Param("id")

	env, err := h.store.GetEnvelope(envelopeID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "envelope not found"})
		return
	}

	// Authorization: only the document/envelope owner (or admin) may remind.
	if !h.authz.canAccessEnvelopeACL(c, env.SourceFileID, env.ID) {
		c.JSON(http.StatusNotFound, gin.H{"error": "envelope not found"})
		return
	}

	if env.Status == models.EnvelopeStatusCompleted ||
		env.Status == models.EnvelopeStatusDeclined ||
		env.Status == models.EnvelopeStatusVoided {
		c.JSON(http.StatusBadRequest, gin.H{"error": "envelope is not active"})
		return
	}

	noMailer := smtpHost() == ""
	var pending []string
	deliveredCount := 0
	for _, sg := range env.Signers {
		if sg.Status == models.SignerStatusPending ||
			sg.Status == models.SignerStatusSent ||
			sg.Status == models.SignerStatusViewed {
			pending = append(pending, sg.ID)
			delivered, emitErr := emitReminder(env, sg)
			if emitErr != nil {
				log.Printf("[REMINDER] send error envelope=%s signer=%s: %v", env.ID, sg.ID, emitErr)
			}
			if delivered {
				deliveredCount++
			}
		}
	}

	resp := gin.H{
		"envelope_id":     envelopeID,
		"pending":         pending,
		"delivered":       deliveredCount > 0,
		"delivered_count": deliveredCount,
	}
	if noMailer {
		resp["no_mailer"] = true
	}
	c.JSON(http.StatusOK, resp)
}

// smtpHost returns VULOS_SMTP_HOST, or "" when not configured.
func smtpHost() string { return strings.TrimSpace(os.Getenv("VULOS_SMTP_HOST")) }

// emitReminder logs a reminder for sg and, when SMTP is configured, sends an
// email. Returns (delivered, error).
func emitReminder(env *models.Envelope, sg *models.Signer) (bool, error) {
	log.Printf("[REMINDER] envelope=%s signer=%s (%s <%s>) status=%s link=/sign/%s",
		env.ID, sg.ID, sg.Name, sg.Email, sg.Status, sg.Token)

	host := smtpHost()
	if host == "" {
		log.Printf("[REMINDER] no mailer configured (set VULOS_SMTP_* env vars to enable email delivery)")
		return false, nil
	}

	portStr := strings.TrimSpace(os.Getenv("VULOS_SMTP_PORT"))
	port := 587
	if portStr != "" {
		if p, err := strconv.Atoi(portStr); err == nil && p > 0 {
			port = p
		}
	}
	user := strings.TrimSpace(os.Getenv("VULOS_SMTP_USER"))
	pass := strings.TrimSpace(os.Getenv("VULOS_SMTP_PASSWORD"))
	from := strings.TrimSpace(os.Getenv("VULOS_SMTP_FROM"))
	if from == "" {
		from = user
	}

	addr := fmt.Sprintf("%s:%d", host, port)
	auth := smtp.PlainAuth("", user, pass, host)

	subject := "Reminder: please sign — " + env.Title
	body := fmt.Sprintf("Hello %s,\n\nPlease sign the document \"%s\".\n\nYour signing link: /sign/%s\n",
		sg.Name, env.Title, sg.Token)

	msg := []byte(
		"To: " + sg.Email + "\r\n" +
			"From: " + from + "\r\n" +
			"Subject: " + subject + "\r\n" +
			"\r\n" +
			body,
	)

	if err := smtp.SendMail(addr, auth, from, []string{sg.Email}, msg); err != nil {
		return false, err
	}
	log.Printf("[REMINDER] email sent envelope=%s signer=%s to=%s", env.ID, sg.ID, sg.Email)
	return true, nil
}

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/sign/:envelopeId/cancel
// ──────────────────────────────────────────────────────────────────────────────

// Cancel voids an active envelope. Terminal state; audit event appended.
//
// AC: cancel/expire envelopes.
func (h *OrchestrationHandler) Cancel(c *gin.Context) {
	envelopeID := c.Param("id")

	env, err := h.store.GetEnvelope(envelopeID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "envelope not found"})
		return
	}

	// Authorization: only the document/envelope owner (or admin) may cancel.
	if !h.authz.canAccessEnvelopeACL(c, env.SourceFileID, env.ID) {
		c.JSON(http.StatusNotFound, gin.H{"error": "envelope not found"})
		return
	}

	if env.Status == models.EnvelopeStatusCompleted ||
		env.Status == models.EnvelopeStatusVoided {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("envelope already in terminal state: %s", env.Status)})
		return
	}

	env.Status = models.EnvelopeStatusVoided
	env.UpdatedAt = time.Now().UTC()
	if err := h.store.UpdateEnvelope(env); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "update envelope: " + err.Error()})
		return
	}

	cancelEvent := &models.AuditEvent{
		ID:         uuid.New().String(),
		EnvelopeID: envelopeID,
		Action:     models.AuditActionVoided,
		Timestamp:  time.Now().UTC(),
		IP:         c.ClientIP(),
		Identity:   identityFromContext(c),
	}
	_, _ = appendChainedAuditEvent(h.store, cancelEvent)

	c.JSON(http.StatusOK, gin.H{"envelope_id": envelopeID, "status": env.Status})
}

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/sign/:token/decline
// ──────────────────────────────────────────────────────────────────────────────

// Decline lets a signer refuse to sign. Marks the signer declined, appends a
// hash-chained audit event, and transitions the envelope to declined (terminal).
//
// AC: decline terminates envelope with audit event.
func (h *OrchestrationHandler) Decline(c *gin.Context) {
	token := c.Param("id")

	envelopeID, signerID, err := h.store.ResolveToken(token)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "signing link not found"})
		return
	}

	env, err := h.store.GetEnvelope(envelopeID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "envelope not found"})
		return
	}

	var signer *models.Signer
	for _, sg := range env.Signers {
		if sg.ID == signerID {
			signer = sg
			break
		}
	}
	if signer == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "signer not found"})
		return
	}

	if signer.Status == models.SignerStatusSigned || signer.Status == models.SignerStatusDeclined {
		c.JSON(http.StatusConflict, gin.H{"error": "signer has already completed"})
		return
	}

	// Mark signer declined.
	signer.Status = models.SignerStatusDeclined
	signer.UpdatedAt = time.Now().UTC()
	_ = h.store.UpsertSigner(signer)

	// Transition envelope to declined (terminal).
	env.Status = models.EnvelopeStatusDeclined
	env.UpdatedAt = time.Now().UTC()
	_ = h.store.UpdateEnvelope(env)

	// Determine identity.
	identity := identityFromContext(c)
	if identity == "" {
		identity = signer.Email
		if identity == "" {
			identity = fmt.Sprintf("link:%s", token[:8])
		}
	}

	declineEvent := &models.AuditEvent{
		ID:         uuid.New().String(),
		EnvelopeID: envelopeID,
		SignerID:   signerID,
		Action:     models.AuditActionDeclined,
		Timestamp:  time.Now().UTC(),
		IP:         c.ClientIP(),
		Identity:   identity,
	}
	_, _ = appendChainedAuditEvent(h.store, declineEvent)

	log.Printf("[DECLINE] envelope=%s signer=%s (%s) — envelope voided", envelopeID, signerID, signer.Email)

	c.JSON(http.StatusOK, gin.H{
		"envelope_id": envelopeID,
		"signer_id":   signerID,
		"status":      "declined",
	})
}

// ──────────────────────────────────────────────────────────────────────────────
// AdvanceOrchestration — called by signing.Complete after a signer completes.
// ──────────────────────────────────────────────────────────────────────────────

// AdvanceOrchestration drives the sequential state machine: after signer at
// order N completes, it finds the next pending signer(s) at order N+1 and
// marks them "sent" (token already issued by Send; no new token needed).
// In parallel mode this is a no-op (all signers already active).
// It also emits reminders for newly unlocked signers.
//
// This is exported so signing.go (Complete handler) can call it.
func AdvanceOrchestration(store storage.Storage, env *models.Envelope) {
	if env.OrderMode != models.SigningOrderSequential {
		return
	}

	// Find the highest completed order.
	maxDone := -1
	for _, sg := range env.Signers {
		if sg.Status == models.SignerStatusSigned && sg.Order > maxDone {
			maxDone = sg.Order
		}
	}
	if maxDone < 0 {
		return
	}

	// Find the lowest order among remaining pending/sent signers.
	nextOrder := -1
	for _, sg := range env.Signers {
		if sg.Status == models.SignerStatusPending || sg.Status == models.SignerStatusSent {
			if nextOrder < 0 || sg.Order < nextOrder {
				nextOrder = sg.Order
			}
		}
	}
	if nextOrder < 0 || nextOrder <= maxDone {
		return
	}

	// Activate all signers at nextOrder (ties are parallel within the order).
	for _, sg := range env.Signers {
		if sg.Order == nextOrder &&
			(sg.Status == models.SignerStatusPending) {
			sg.Status = models.SignerStatusSent
			sg.UpdatedAt = time.Now().UTC()
			_ = store.UpsertSigner(sg)
			_, _ = emitReminder(env, sg)
			log.Printf("[ORCHESTRATION] sequential: unlocked signer %s (%s) order=%d envelope=%s",
				sg.ID, sg.Email, sg.Order, env.ID)
		}
	}
}
