package handlers

// OFFICE-26: Comments — anchored, threaded, resolvable.
// REST endpoints:
//   GET    /api/files/:id/comments           → list comments + replies for a file
//   POST   /api/files/:id/comments           → add a comment
//   PUT    /api/files/:id/comments/:cid      → edit body or change state (resolve/reopen)
//   DELETE /api/files/:id/comments/:cid      → delete a comment
//   POST   /api/files/:id/comments/:cid/replies   → add a reply
//   PUT    /api/files/:id/comments/:cid/replies/:rid → edit a reply
//   DELETE /api/files/:id/comments/:cid/replies/:rid → tombstone a reply

import (
	"net/http"
	"time"

	"diwan/backend/billing"
	"diwan/backend/models"
	"diwan/backend/notify"
	"diwan/backend/storage"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type CommentHandler struct {
	store  storage.Storage
	authz  *FileAuthz
	notify notify.Store
}

func NewCommentHandler(store storage.Storage) *CommentHandler {
	return &CommentHandler{store: store, authz: SharedFileAuthz(), notify: SharedNotifyStore()}
}

// NewCommentHandlerWith builds a handler over caller-supplied authz + notify
// stores (tests).
func NewCommentHandlerWith(store storage.Storage, authz *FileAuthz, nf notify.Store) *CommentHandler {
	return &CommentHandler{store: store, authz: authz, notify: nf}
}

// hlcNow returns a simple HLC-compatible clock string (wall-ms padded, monotone via uuid suffix).
func hlcNow() string {
	return time.Now().UTC().Format("20060102150405.000") + "-" + uuid.New().String()[:8]
}

// CommentWithReplies is the wire shape returned by List.
type CommentWithReplies struct {
	*models.Comment
	Replies []*models.CommentReply `json:"replies"`
}

// List returns all comments for a file with their replies.
func (h *CommentHandler) List(c *gin.Context) {
	fileID := c.Param("id")
	if !h.authz.require(c, fileID) {
		return
	}
	comments, err := h.store.ListComments(fileID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if comments == nil {
		comments = []*models.Comment{}
	}

	result := make([]CommentWithReplies, 0, len(comments))
	for _, cm := range comments {
		replies, _ := h.store.ListReplies(cm.ID)
		if replies == nil {
			replies = []*models.CommentReply{}
		}
		result = append(result, CommentWithReplies{Comment: cm, Replies: replies})
	}
	c.JSON(http.StatusOK, result)
}

// Create adds a new comment anchored to a file location.
func (h *CommentHandler) Create(c *gin.Context) {
	fileID := c.Param("id")
	if !h.authz.requireCommenter(c, fileID) {
		return
	}
	// OFFICE ACCESS GATE: a suspended / office-disabled account may not comment.
	if d := billing.GateOffice(c.Request.Context(), requesterID(c)); !d.Allowed() {
		c.JSON(d.Code, gin.H{"error": d.Reason})
		return
	}
	var req models.CreateCommentRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Validate @-mentions against the file's actual collaborators so a comment can
	// never mention — and thereby notify — an account that has no access to the
	// document (prevents using mentions as a cross-account probe/spam vector).
	mentions := h.validMentions(fileID, req.Mentions)
	// Validate the assignee the same way — a comment can only be assigned to an
	// account that actually collaborates on the file.
	assignee := h.validAssignee(fileID, req.Assignee)

	cm := &models.Comment{
		ID:     uuid.New().String(),
		FileID: fileID,
		Anchor: req.Anchor,
		// Bind the author to the VERIFIED identity, never the client-supplied
		// AuthorID (which is forgeable). A user cannot post a comment attributed
		// to someone else.
		AuthorID: requesterID(c),
		Body:     req.Body,
		State:    models.CommentOpen,
		SeqClock: hlcNow(),
		Mentions: mentions,
		Assignee: assignee,
	}
	if err := h.store.CreateComment(cm); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	// Surface an in-app notification to each mentioned collaborator (except the
	// author mentioning themselves).
	h.notifyMentions(c, fileID, cm.ID, cm.AuthorID, cm.Body, mentions)
	// Notify the assignee that a task was assigned to them (unless self-assigned).
	h.notifyAssignment(c, fileID, cm.ID, cm.AuthorID, assignee, cm.Body)
	c.JSON(http.StatusCreated, cm)
}

// validMentions filters the client-supplied mention ids down to accounts that
// are ACTUALLY collaborators/owner of the file (the authoritative ACL record).
// Anything else is dropped, so a mention can never address a non-participant.
func (h *CommentHandler) validMentions(fileID string, requested []string) []string {
	if len(requested) == 0 {
		return nil
	}
	rec, ok, err := h.authz.Store().Get(fileID)
	if err != nil || !ok {
		return nil
	}
	allowed := make(map[string]bool, len(rec.Collaborators)+1)
	if rec.Owner != "" {
		allowed[rec.Owner] = true
	}
	for _, ce := range rec.Collaborators {
		allowed[ce.AccountID] = true
	}
	seen := make(map[string]bool, len(requested))
	out := make([]string, 0, len(requested))
	for _, m := range requested {
		if m == "" || seen[m] || !allowed[m] {
			continue
		}
		seen[m] = true
		out = append(out, m)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// validAssignee returns the requested assignee id only when it is a real
// participant (owner or collaborator) of the file — otherwise "". This is the
// authorization boundary for assignment: a comment can never be assigned to (and
// notify) an account with no access to the document, mirroring validMentions.
func (h *CommentHandler) validAssignee(fileID, requested string) string {
	if requested == "" {
		return ""
	}
	rec, ok, err := h.authz.Store().Get(fileID)
	if err != nil || !ok {
		return ""
	}
	if rec.Owner == requested {
		return requested
	}
	for _, ce := range rec.Collaborators {
		if ce.AccountID == requested {
			return requested
		}
	}
	return ""
}

// notifyAssignment surfaces an in-app notification to a newly-assigned account
// (skipping self-assignment). Best-effort — a notify failure never fails the
// request.
func (h *CommentHandler) notifyAssignment(c *gin.Context, fileID, commentID, actor, assignee, body string) {
	if assignee == "" || assignee == actor || h.notify == nil {
		return
	}
	fileName := ""
	if f, err := h.store.GetFile(fileID); err == nil {
		fileName = f.Name
	}
	snippet := body
	if len(snippet) > 140 {
		snippet = snippet[:140]
	}
	_ = h.notify.Create(&models.Notification{
		Account:   assignee,
		Kind:      models.NotifyAssign,
		Actor:     actor,
		FileID:    fileID,
		FileName:  fileName,
		CommentID: commentID,
		Snippet:   snippet,
	})
}

// notifyMentions writes one in-app notification per mentioned account (skipping
// the actor themselves). Best-effort — a notify failure never fails the comment.
func (h *CommentHandler) notifyMentions(c *gin.Context, fileID, commentID, actor, body string, mentions []string) {
	if len(mentions) == 0 || h.notify == nil {
		return
	}
	fileName := ""
	if f, err := h.store.GetFile(fileID); err == nil {
		fileName = f.Name
	}
	snippet := body
	if len(snippet) > 140 {
		snippet = snippet[:140]
	}
	for _, acct := range mentions {
		if acct == actor {
			continue // don't notify yourself
		}
		_ = h.notify.Create(&models.Notification{
			Account:   acct,
			Kind:      models.NotifyMention,
			Actor:     actor,
			FileID:    fileID,
			FileName:  fileName,
			CommentID: commentID,
			Snippet:   snippet,
		})
	}
}

// Update edits the body or state of a comment.
func (h *CommentHandler) Update(c *gin.Context) {
	fileID := c.Param("id")
	commentID := c.Param("cid")

	if !h.authz.requireCommenter(c, fileID) {
		return
	}

	cm, err := h.store.GetComment(fileID, commentID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "comment not found"})
		return
	}

	var req models.UpdateCommentRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// AUTHORSHIP: editing a comment's BODY is restricted to its author (or an
	// admin) — file access alone is too coarse and would let any collaborator
	// rewrite someone else's words (IDOR). Changing only the STATE
	// (resolve/reopen) is intentionally collaborative: any participant with file
	// access may resolve/reopen a thread.
	if req.Body != "" && req.Body != cm.Body {
		if !isAuthorOrAdmin(c, cm.AuthorID) {
			c.JSON(http.StatusForbidden, gin.H{"error": "only the comment author may edit its text"})
			return
		}
		cm.Body = req.Body
	}

	// ASSIGNMENT: changing the assignee is collaborative (like resolve/reopen) —
	// any participant with comment access may (re)assign the task, but only to a
	// real collaborator (validated). Track whether it becomes a NEW assignment so
	// we notify the assignee exactly once.
	notifyNewAssignee := ""
	if req.Assignee != nil {
		next := h.validAssignee(fileID, *req.Assignee) // "" clears (or drops an invalid id)
		if next != cm.Assignee && next != "" {
			notifyNewAssignee = next
		}
		cm.Assignee = next
	}

	if req.State != "" {
		cm.State = req.State
		// Resolving the thread clears the assignment: a resolved task has no open
		// assignee. This also suppresses a stale "assigned to you" surface.
		if req.State == models.CommentResolved {
			cm.Assignee = ""
			notifyNewAssignee = ""
		}
	}
	cm.SeqClock = hlcNow()

	if err := h.store.UpdateComment(cm); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if notifyNewAssignee != "" {
		h.notifyAssignment(c, fileID, cm.ID, requesterID(c), notifyNewAssignee, cm.Body)
	}
	c.JSON(http.StatusOK, cm)
}

// Delete removes a comment.
func (h *CommentHandler) Delete(c *gin.Context) {
	fileID := c.Param("id")
	commentID := c.Param("cid")
	if !h.authz.requireCommenter(c, fileID) {
		return
	}
	// AUTHORSHIP: only the comment's author (or an admin) may delete it; file
	// access alone would let any collaborator remove someone else's comment.
	cm, err := h.store.GetComment(fileID, commentID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "comment not found"})
		return
	}
	if !isAuthorOrAdmin(c, cm.AuthorID) {
		c.JSON(http.StatusForbidden, gin.H{"error": "only the comment author may delete it"})
		return
	}
	if err := h.store.DeleteComment(fileID, commentID); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "comment not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "deleted"})
}

// CreateReply adds a threaded reply to a comment.
func (h *CommentHandler) CreateReply(c *gin.Context) {
	fileID := c.Param("id")
	commentID := c.Param("cid")

	if !h.authz.requireCommenter(c, fileID) {
		return
	}

	// Ensure the comment exists.
	if _, err := h.store.GetComment(fileID, commentID); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "comment not found"})
		return
	}

	var req models.CreateReplyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	r := &models.CommentReply{
		ID:        uuid.New().String(),
		CommentID: commentID,
		FileID:    fileID,
		// Verified identity — not the forgeable client AuthorID.
		AuthorID: requesterID(c),
		Body:     req.Body,
		SeqClock: hlcNow(),
		Deleted:  false,
	}
	if err := h.store.CreateReply(r); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	// Notify @-mentioned collaborators on the reply (validated against the ACL).
	mentions := h.validMentions(fileID, req.Mentions)
	h.notifyMentions(c, fileID, commentID, r.AuthorID, r.Body, mentions)
	c.JSON(http.StatusCreated, r)
}

// UpdateReply edits the body of a reply.
func (h *CommentHandler) UpdateReply(c *gin.Context) {
	commentID := c.Param("cid")
	replyID := c.Param("rid")

	if !h.authz.requireCommenter(c, c.Param("id")) {
		return
	}

	r, err := h.store.GetReply(commentID, replyID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "reply not found"})
		return
	}
	// AUTHORSHIP: only the reply's author (or an admin) may edit its text.
	if !isAuthorOrAdmin(c, r.AuthorID) {
		c.JSON(http.StatusForbidden, gin.H{"error": "only the reply author may edit it"})
		return
	}

	var req models.UpdateReplyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if req.Body != "" {
		r.Body = req.Body
	}
	r.SeqClock = hlcNow()

	if err := h.store.UpdateReply(r); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, r)
}

// DeleteReply tombstones a reply (soft-delete for CRDT convergence).
func (h *CommentHandler) DeleteReply(c *gin.Context) {
	commentID := c.Param("cid")
	replyID := c.Param("rid")

	if !h.authz.requireCommenter(c, c.Param("id")) {
		return
	}

	r, err := h.store.GetReply(commentID, replyID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "reply not found"})
		return
	}
	// AUTHORSHIP: only the reply's author (or an admin) may delete it.
	if !isAuthorOrAdmin(c, r.AuthorID) {
		c.JSON(http.StatusForbidden, gin.H{"error": "only the reply author may delete it"})
		return
	}

	r.Deleted = true
	r.Body = ""
	r.SeqClock = hlcNow()

	if err := h.store.UpdateReply(r); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, r)
}
