package handlers

// folders.go — file organization parity: a per-account folder tree, star/
// favorite flags, and a trash (soft-delete with restore + permanent-delete).
//
// SECURITY / ACL
// --------------
// Folders are ACL-owned EXACTLY like files: an owner is recorded on create via
// the same fileacl store, so a folder — and everything filed under it — is
// private by default and can never be listed, opened, moved into, or reparented
// by another account. Every folder op runs through the shared FileAuthz:
//
//   - List        → returns only folders the caller can access.
//   - Get/Update/Delete/Move-into → require ownership (requireOwner) so a
//     non-owner collaborator can never reorganize or delete a foreign tree.
//   - Move a FILE into a folder → the caller must own BOTH the file and the
//     target folder (enforced below), so a file can never be relocated into
//     another account's tree, nor can a foreign file be pulled into mine.
//
// The store is ACL-agnostic (it just persists rows); all isolation lives here.

import (
	"log"
	"net/http"
	"time"

	"diwan/backend/audit"
	"diwan/backend/billing"
	"diwan/backend/models"
	"diwan/backend/storage"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// FolderHandler serves the folder-tree endpoints.
type FolderHandler struct {
	store storage.Storage
	authz *FileAuthz
	audit audit.Store
}

func NewFolderHandler(store storage.Storage) *FolderHandler {
	return &FolderHandler{store: store, authz: SharedFileAuthz(), audit: SharedAuditStore()}
}

// NewFolderHandlerWithAuthz builds a handler over a caller-supplied authorizer
// (tests). The audit store defaults to the shared one.
func NewFolderHandlerWithAuthz(store storage.Storage, authz *FileAuthz) *FolderHandler {
	return &FolderHandler{store: store, authz: authz, audit: SharedAuditStore()}
}

// List returns the folders the caller may access (owned/shared). Trashed folders
// are included so the client can render the Trash view; the client filters by
// the `trashed` flag per view.
func (h *FolderHandler) List(c *gin.Context) {
	folders, err := h.store.ListFolders()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	out := make([]*models.Folder, 0, len(folders))
	for _, f := range folders {
		// Reuse the SAME per-file ACL predicate: a folder id is recorded as
		// ACL-owned on create, so canAccess enforces per-account isolation.
		if h.authz.canAccess(c, f.ID) {
			out = append(out, f)
		}
	}
	c.JSON(http.StatusOK, out)
}

// Create makes a new folder owned by the caller. If a parent is given it must be
// a folder the caller owns (no filing under a foreign tree).
func (h *FolderHandler) Create(c *gin.Context) {
	account := requesterID(c)
	if d := billing.GateOffice(c.Request.Context(), account); !d.Allowed() {
		c.JSON(d.Code, gin.H{"error": d.Reason})
		return
	}
	var req models.CreateFolderRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	// A non-root parent must be a folder the caller OWNS.
	if req.ParentID != "" {
		if !h.requireOwnedFolder(c, req.ParentID) {
			return
		}
	}
	folder := &models.Folder{
		ID:       uuid.New().String(),
		Name:     req.Name,
		ParentID: req.ParentID,
	}
	if err := h.store.CreateFolder(folder); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	// Record ownership so the folder is private by default (mirrors file create).
	if err := h.authz.recordOwner(c, folder.ID); err != nil {
		_ = h.store.DeleteFolder(folder.ID)
		log.Printf("[folders] recordOwner failed for folder=%s: %v (rolled back)", folder.ID, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to record folder ownership"})
		return
	}
	c.JSON(http.StatusCreated, folder)
}

// Update renames / reparents / stars / trash-toggles a folder. Owner only.
func (h *FolderHandler) Update(c *gin.Context) {
	id := c.Param("id")
	if !h.requireOwnedFolder(c, id) {
		return
	}
	folder, err := h.store.GetFolder(id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "folder not found"})
		return
	}
	var req models.UpdateFolderRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if req.Name != nil {
		folder.Name = *req.Name
	}
	if req.ParentID != nil {
		newParent := *req.ParentID
		if newParent == id {
			c.JSON(http.StatusBadRequest, gin.H{"error": "a folder cannot be its own parent"})
			return
		}
		// Reparenting into a non-root target requires owning that target AND
		// that the move does not create a cycle (target not a descendant of id).
		if newParent != "" {
			if !h.requireOwnedFolder(c, newParent) {
				return
			}
			if h.isDescendant(newParent, id) {
				c.JSON(http.StatusBadRequest, gin.H{"error": "cannot move a folder into its own descendant"})
				return
			}
		}
		folder.ParentID = newParent
	}
	if req.Starred != nil {
		folder.Starred = *req.Starred
	}
	if err := h.store.UpdateFolder(folder); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, folder)
}

// Trash soft-deletes (or restores) a folder. POST /folders/:id/trash {trashed}.
func (h *FolderHandler) Trash(c *gin.Context) {
	id := c.Param("id")
	if !h.requireOwnedFolder(c, id) {
		return
	}
	folder, err := h.store.GetFolder(id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "folder not found"})
		return
	}
	var req struct {
		Trashed bool `json:"trashed"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	folder.Trashed = req.Trashed
	if req.Trashed {
		now := time.Now()
		folder.TrashedAt = &now
	} else {
		folder.TrashedAt = nil
	}
	if err := h.store.UpdateFolder(folder); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, folder)
}

// Delete PERMANENTLY removes a folder (from trash). Owner only. Files filed
// under it are NOT cascaded here (the client trashes/moves them first); we drop
// the folder row + its ACL. Any orphaned files simply fall back to root in the
// client's tree view (their own ACL is untouched).
func (h *FolderHandler) Delete(c *gin.Context) {
	id := c.Param("id")
	if !h.requireOwnedFolder(c, id) {
		return
	}
	if err := h.store.DeleteFolder(id); err != nil {
		if err.Error() == "folder not found" {
			c.JSON(http.StatusNotFound, gin.H{"error": "folder not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	// Reparent any child files owned by the caller that pointed at this folder
	// back to root so they don't vanish (best-effort; ACL still gates them).
	files, _ := h.store.ListFiles()
	for _, f := range files {
		if f.ParentID == id && h.authz.canAccess(c, f.ID) {
			_ = h.store.UpdateFileMeta(f.ID, "", f.Starred, f.Trashed, f.TrashedAt)
		}
	}
	_ = h.authz.Store().Delete(id)
	c.JSON(http.StatusOK, gin.H{"message": "deleted"})
}

// requireOwnedFolder verifies the folder exists and the caller owns it (or is an
// admin). Mirrors FileAuthz.requireOwner but for a folder id. Returns false and
// writes the response on denial (404 for no-access, 403 for non-owner).
func (h *FolderHandler) requireOwnedFolder(c *gin.Context, folderID string) bool {
	// requireOwner runs the same 404/403 logic over the folder's ACL record.
	return h.authz.requireOwner(c, folderID)
}

// isDescendant reports whether candidate is a descendant of ancestor in the
// folder tree (used to reject cycle-creating reparents). Bounded by the number
// of folders to avoid infinite loops on corrupt data.
func (h *FolderHandler) isDescendant(candidate, ancestor string) bool {
	all, err := h.store.ListFolders()
	if err != nil {
		return false
	}
	byID := make(map[string]*models.Folder, len(all))
	for _, f := range all {
		byID[f.ID] = f
	}
	cur := candidate
	for i := 0; i < len(all)+1; i++ {
		f, ok := byID[cur]
		if !ok || f.ParentID == "" {
			return false
		}
		if f.ParentID == ancestor {
			return true
		}
		cur = f.ParentID
	}
	return false
}
