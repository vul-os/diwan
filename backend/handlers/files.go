package handlers

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"diwan/backend/audit"
	"diwan/backend/billing"
	"diwan/backend/fileacl"
	"diwan/backend/models"
	"diwan/backend/storage"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type FileHandler struct {
	store storage.Storage
	authz *FileAuthz
	audit audit.Store
}

func NewFileHandler(store storage.Storage) *FileHandler {
	return &FileHandler{store: store, authz: SharedFileAuthz(), audit: SharedAuditStore()}
}

// NewFileHandlerWithAuthz builds a handler over a caller-supplied authorizer
// (tests use an in-memory NullStore so they never touch disk). The audit store
// defaults to the shared one; use NewFileHandlerWithAudit to inject it.
func NewFileHandlerWithAuthz(store storage.Storage, authz *FileAuthz) *FileHandler {
	return &FileHandler{store: store, authz: authz, audit: SharedAuditStore()}
}

// NewFileHandlerWithAudit builds a handler over caller-supplied authorizer +
// audit store (tests).
func NewFileHandlerWithAudit(store storage.Storage, authz *FileAuthz, aud audit.Store) *FileHandler {
	return &FileHandler{store: store, authz: authz, audit: aud}
}

func (h *FileHandler) List(c *gin.Context) {
	files, err := h.store.ListFiles()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	// Return only the files the caller may access (owned + shared). Unowned/
	// legacy files (no recorded owner) remain visible so local/OSS mode and
	// pre-ACL documents keep working; admins see everything.
	out := make([]*models.File, 0, len(files))
	for _, f := range files {
		if h.authz.canAccess(c, f.ID) {
			out = append(out, f)
		}
	}
	c.JSON(http.StatusOK, out)
}

// SharedWithMe returns the files that have been shared TO the caller by someone
// else — i.e. files the caller can access but does NOT own. This powers the
// "Shared with me" section in the app home.
//
// ACL-safety: the set is computed from the caller's OWN grants only
// (AccessibleFileIDs(me) is keyed on requesterID), then the owned files are
// removed by consulting each file's recorded owner. A file whose owner is the
// caller (owned) or unrecorded/legacy (no cross-account share) is excluded, so
// this can never surface another account's private document or leak the roster.
// Each returned file carries its owner id so the UI can attribute it.
//
// GET /api/files/shared
func (h *FileHandler) SharedWithMe(c *gin.Context) {
	me := requesterID(c)
	ids, err := h.authz.Store().AccessibleFileIDs(me)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	out := make([]gin.H, 0)
	for id := range ids {
		rec, ok, gerr := h.authz.Store().Get(id)
		if gerr != nil || !ok {
			continue // unowned/legacy — not a cross-account share
		}
		if rec.Owner == me || rec.Owner == "" {
			continue // owned by the caller (or ownerless) — not "shared with me"
		}
		// Defence in depth: the caller must actually be a recorded collaborator
		// (AccessibleFileIDs already guarantees this, but re-verify so a store
		// inconsistency can never widen the result).
		if !h.authz.canAccess(c, id) {
			continue
		}
		file, ferr := h.store.GetFile(id)
		if ferr != nil {
			continue // metadata gone (deleted) — skip
		}
		// Include the caller's role so the UI can show "shared as viewer", etc.
		role, _, _ := h.authz.Store().GetRole(id, me)
		out = append(out, gin.H{
			"id":         file.ID,
			"name":       file.Name,
			"type":       file.Type,
			"owner":      rec.Owner,
			"role":       string(role),
			"updated_at": file.UpdatedAt,
			"created_at": file.CreatedAt,
		})
	}
	c.JSON(http.StatusOK, gin.H{"files": out})
}

func (h *FileHandler) Get(c *gin.Context) {
	id := c.Param("id")
	if !h.authz.require(c, id) {
		return
	}
	file, err := h.store.GetFile(id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "file not found"})
		return
	}
	c.JSON(http.StatusOK, file)
}

func (h *FileHandler) Create(c *gin.Context) {
	var req models.CreateFileRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	account := requesterID(c)

	// OFFICE ACCESS GATE: block file creation when the tier does not enable the
	// office product (or the account is suspended). Standalone → allow.
	if d := billing.GateOffice(c.Request.Context(), account); !d.Allowed() {
		c.JSON(d.Code, gin.H{"error": d.Reason})
		return
	}

	file := &models.File{
		ID:      uuid.New().String(),
		Name:    req.Name,
		Type:    req.Type,
		Content: req.Content,
	}

	// STORAGE GATE: atomically check AND reserve the storage quota for the new
	// document's content BEFORE persisting it. Standalone → unlimited → no-op.
	// The reservation is committed on success / released if the write fails.
	var contentBytes []byte
	if file.Content != nil {
		if b, err := json.Marshal(file.Content); err == nil {
			contentBytes = b
		}
	}
	d, res := billing.GateStorage(c.Request.Context(), account, int64(len(contentBytes)))
	if !d.Allowed() {
		c.JSON(d.Code, gin.H{"error": d.Reason})
		return
	}

	if err := h.store.CreateFile(file); err != nil {
		res.Release()
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	// Record the creating identity as owner so the file is private by default.
	// In multi-tenant mode an unowned file is NOT globally readable, so a failed
	// SetOwner must FAIL the create (rather than silently leave an unowned file):
	// otherwise the document is either inaccessible to its creator or — under the
	// old fail-open path — readable by everyone. Roll back the persisted row.
	if err := h.authz.recordOwner(c, file.ID); err != nil {
		_ = h.store.DeleteFile(file.ID)
		res.Release()
		log.Printf("[files] recordOwner failed for file=%s: %v (rolled back create)", file.ID, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to record file ownership"})
		return
	}

	// Async write-through to org bucket when content is present.
	if contentBytes != nil {
		if err := SharedBucketStore().PutObject(c, account, "file/"+file.ID, contentBytes, "application/json"); err != nil {
			log.Printf("[files] bucket sync create file=%s: %v (SQLite is primary — continuing)", file.ID, err)
		}
	}

	// METER: commit the reservation after a successful create (advances the
	// running total + reports usage). A no-op for unlimited / zero-byte content.
	res.Commit(c.Request.Context())

	c.JSON(http.StatusCreated, file)
}

func (h *FileHandler) Update(c *gin.Context) {
	id := c.Param("id")
	// Editors and owners may mutate content; viewers are read-only.
	if !h.authz.requireEditor(c, id) {
		return
	}
	account := requesterID(c)

	// OFFICE ACCESS GATE: a suspended / office-disabled account may not mutate
	// documents. Standalone → allow.
	if d := billing.GateOffice(c.Request.Context(), account); !d.Allowed() {
		c.JSON(d.Code, gin.H{"error": d.Reason})
		return
	}

	var req models.UpdateFileRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// SHEETS PROTECTED RANGES (fail-closed): enforce against the PREVIOUSLY STORED
	// content so a caller cannot strip a restricted range and then write it. Only
	// runs in multi-tenant mode for sheet content that already carries a restricted
	// range (see enforceProtectedRanges). A blocked write is a 403; nothing is
	// persisted.
	if req.Content != nil {
		if prev, gerr := h.store.GetFile(id); gerr == nil && prev != nil {
			if ok, code, reason := h.authz.enforceProtectedRanges(c, id, prev.Content, req.Content); !ok {
				c.JSON(code, gin.H{"error": reason})
				return
			}
		}
	}

	file := &models.File{
		ID:      id,
		Name:    req.Name,
		Content: req.Content,
		// P2 optimistic concurrency: echo the rev the client last read. The store
		// rejects a stale PUT with ErrRevConflict (→ 409) instead of clobbering.
		Rev: req.Rev,
		// EditorID stamps the version snapshot's Author with the VERIFIED requester
		// (never trusted from the body). Transient — not persisted on the file row.
		EditorID: account,
	}

	// STORAGE GATE: atomically check AND reserve the quota for the new content
	// BEFORE persisting it (this write previously bypassed the gate entirely).
	var contentBytes []byte
	if file.Content != nil {
		if b, err := json.Marshal(file.Content); err == nil {
			contentBytes = b
		}
	}
	d, res := billing.GateStorage(c.Request.Context(), account, int64(len(contentBytes)))
	if !d.Allowed() {
		c.JSON(d.Code, gin.H{"error": d.Reason})
		return
	}

	if err := h.store.UpdateFile(file); err != nil {
		res.Release()
		// P2: a stale rev (optimistic-concurrency CAS miss) is a 409 Conflict. Return
		// the CURRENT stored file so the client can reload, reconcile its pending
		// change against the newer content, and retry — never a silent lost update.
		if errors.Is(err, storage.ErrRevConflict) {
			current, gerr := h.store.GetFile(id)
			if gerr != nil {
				c.JSON(http.StatusConflict, gin.H{"error": "revision conflict"})
				return
			}
			c.JSON(http.StatusConflict, gin.H{"error": "revision conflict", "current": current})
			return
		}
		if err.Error() == "file not found" {
			c.JSON(http.StatusNotFound, gin.H{"error": "file not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	updated, _ := h.store.GetFile(file.ID)

	// Sync updated content blob to bucket (SQLite is still the primary source).
	if contentBytes != nil {
		if err := SharedBucketStore().PutObject(c, account, "file/"+id, contentBytes, "application/json"); err != nil {
			log.Printf("[files] bucket sync update file=%s: %v (SQLite is primary — continuing)", id, err)
		}
	}

	// METER: commit the reservation after a successful update.
	res.Commit(c.Request.Context())

	c.JSON(http.StatusOK, updated)
}

func (h *FileHandler) Delete(c *gin.Context) {
	id := c.Param("id")
	// Only the owner (or an admin) may delete a document.
	if !h.authz.requireOwner(c, id) {
		return
	}
	if err := h.store.DeleteFile(id); err != nil {
		if err.Error() == "file not found" {
			c.JSON(http.StatusNotFound, gin.H{"error": "file not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	// Drop ACL state for the deleted file.
	_ = h.authz.Store().Delete(id)

	// Best-effort removal from the org bucket (ignore error — bucket object
	// may not exist if S3 was not configured when the file was created).
	if err := SharedBucketStore().DeleteObject(c, requesterID(c), "file/"+id); err != nil {
		log.Printf("[files] bucket sync delete file=%s: %v (ignoring)", id, err)
	}

	c.JSON(http.StatusOK, gin.H{"message": "deleted"})
}

// Collaborators returns the owner + collaborator account ids of a file, for the
// @-mention autocomplete. Any caller WITH ACCESS to the file may read the list
// (they can already see who is on the doc), but a caller without access gets a
// 404 (no existence leak). Only ids the ACL actually records are returned, so
// the autocomplete can never suggest — and a mention can never target — a
// non-participant.
//
// GET /api/files/:id/collaborators
func (h *FileHandler) Collaborators(c *gin.Context) {
	id := c.Param("id")
	if !h.authz.require(c, id) {
		return
	}
	rec, ok, err := h.authz.Store().Get(id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	people := []gin.H{}
	if ok {
		if rec.Owner != "" {
			people = append(people, gin.H{"account_id": rec.Owner, "role": "owner"})
		}
		for _, ce := range rec.Collaborators {
			people = append(people, gin.H{"account_id": ce.AccountID, "role": string(ce.Role)})
		}
	}
	c.JSON(http.StatusOK, gin.H{"collaborators": people})
}

// Move reparents a file into a folder and/or toggles its star / trash state.
// This is a metadata-only mutation (no content version snapshot, no rev bump).
//
// SECURITY / ACL:
//   - The caller must OWN the file (requireOwner) — organization is an owner
//     action, so a collaborator can't relocate or trash someone else's file.
//   - Moving INTO a folder additionally requires the caller to OWN the target
//     folder, so a file can never be filed into another account's tree.
//
// POST /api/files/:id/move { "parent_id": "...", "starred": true, "trashed": false }
func (h *FileHandler) Move(c *gin.Context) {
	id := c.Param("id")
	if !h.authz.requireOwner(c, id) {
		return
	}
	file, err := h.store.GetFile(id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "file not found"})
		return
	}
	var req models.MoveFileRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	parentID := file.ParentID
	if req.ParentID != nil {
		target := *req.ParentID
		if target != "" {
			// The destination folder must exist AND be owned by the caller so a
			// file can never be relocated into another account's tree.
			if !h.authz.requireOwner(c, target) {
				return
			}
			if _, ferr := h.store.GetFolder(target); ferr != nil {
				c.JSON(http.StatusNotFound, gin.H{"error": "target folder not found"})
				return
			}
		}
		parentID = target
	}

	starred := file.Starred
	if req.Starred != nil {
		starred = *req.Starred
	}
	trashed := file.Trashed
	trashedAt := file.TrashedAt
	if req.Trashed != nil {
		trashed = *req.Trashed
		if trashed {
			now := time.Now()
			trashedAt = &now
		} else {
			trashedAt = nil
		}
	}

	if err := h.store.UpdateFileMeta(id, parentID, starred, trashed, trashedAt); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	updated, _ := h.store.GetFile(id)
	c.JSON(http.StatusOK, updated)
}

// Share grants or revokes another account's access to a file.
// Only the owner (or an admin) may manage collaborators.
//
// Role vocabulary: the account-share dialog grants one of three roles —
//   - viewer    — read only.
//   - commenter — read + comment (via the comment endpoints), but no content edits.
//   - editor    — read + write content.
//
// Owner is not a grantable role here (transfer uses a dedicated path). The role
// string is normalized through fileacl.NormalizeRole so long/short forms
// (view/viewer, comment/commenter, edit/editor) all resolve; an empty role
// defaults to editor for back-compat with the original two-role contract.
//
// POST /api/files/:id/share  { "account_id": "...", "role": "editor"|"commenter"|"viewer", "revoke": false }
func (h *FileHandler) Share(c *gin.Context) {
	id := c.Param("id")
	// Only the owner may grant or revoke access.
	if !h.authz.requireOwner(c, id) {
		return
	}
	// Verify the file actually exists before recording a share.
	if _, err := h.store.GetFile(id); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "file not found"})
		return
	}
	var req struct {
		AccountID string `json:"account_id" binding:"required"`
		Role      string `json:"role"`   // "editor" (default), "commenter", or "viewer"
		Revoke    bool   `json:"revoke"` // true to remove access
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	// Guard against sharing a file with its own owner (would clobber ownership
	// with a lesser collaborator role). Revoking self is likewise meaningless.
	if rec, ok, _ := h.authz.Store().Get(id); ok && rec.Owner == req.AccountID {
		c.JSON(http.StatusBadRequest, gin.H{"error": "cannot change the owner's own access"})
		return
	}
	var err error
	if req.Revoke {
		err = h.authz.Store().Unshare(id, req.AccountID)
	} else {
		role := fileacl.NormalizeRole(req.Role)
		if role == fileacl.RoleNone {
			if strings.TrimSpace(req.Role) != "" {
				c.JSON(http.StatusBadRequest, gin.H{"error": "role must be 'editor', 'commenter', or 'viewer'"})
				return
			}
			role = fileacl.RoleEditor // default (back-compat)
		}
		if !fileacl.IsGrantableRole(role) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "role must be 'editor', 'commenter', or 'viewer'"})
			return
		}
		err = h.authz.Store().ShareWithRole(id, req.AccountID, role)
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	// Append-only audit of the ACL change (grantee recorded in the detail).
	action := audit.ActionACLGrant
	if req.Revoke {
		action = audit.ActionACLRevoke
	}
	recordAudit(h.audit, requesterID(c), action, id, "grantee="+req.AccountID)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
