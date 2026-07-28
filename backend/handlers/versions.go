package handlers

import (
	"net/http"
	"time"

	"diwan/backend/docindex"
	"diwan/backend/models"
	"diwan/backend/storage"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// VersionHandler serves GET /api/files/:id/versions and
// POST /api/files/:id/versions/:vid/restore.
type VersionHandler struct {
	store storage.Storage
	authz *FileAuthz
}

func NewVersionHandler(store storage.Storage) *VersionHandler {
	return &VersionHandler{store: store, authz: SharedFileAuthz()}
}

// ListVersions handles GET /api/files/:id/versions.
func (h *VersionHandler) ListVersions(c *gin.Context) {
	fileID := c.Param("id")
	if !h.authz.require(c, fileID) {
		return
	}
	// Verify file exists.
	if _, err := h.store.GetFile(fileID); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "file not found"})
		return
	}

	versions, err := h.store.ListVersions(fileID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if versions == nil {
		versions = []*models.FileVersion{}
	}
	c.JSON(http.StatusOK, versions)
}

// RestoreVersion handles POST /api/files/:id/versions/:vid/restore.
// It creates a new snapshot of the current content, then replaces the
// file content with the chosen version's content.
func (h *VersionHandler) RestoreVersion(c *gin.Context) {
	fileID := c.Param("id")
	versionID := c.Param("vid")

	// Restoring reverts file.Content to a prior version — a full body overwrite.
	// It is a mutation, so require editor rights: a viewer/commenter gets 403.
	if !h.authz.requireEditor(c, fileID) {
		return
	}

	file, err := h.store.GetFile(fileID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "file not found"})
		return
	}

	v, err := h.store.GetVersion(fileID, versionID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "version not found"})
		return
	}

	// Snapshot the current state before restore so it can be undone.
	snap := &models.FileVersion{
		ID:        uuid.New().String(),
		FileID:    fileID,
		Name:      file.Name,
		Content:   file.Content,
		CreatedAt: time.Now(),
	}
	_ = h.store.CreateVersion(snap)
	_ = h.store.PruneVersions(fileID, storage.DefaultVersionCap)

	// Write the restored content back.
	file.Content = v.Content
	file.Name = v.Name
	if err := h.store.UpdateFile(file); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	updated, _ := h.store.GetFile(fileID)
	c.JSON(http.StatusOK, updated)
}

// Diff handles GET /api/files/:id/versions/:vid/diff?against=current|prior.
//
// It compares the chosen version against either the file's CURRENT content
// (default) or the version immediately PRIOR to it in history (against=prior),
// returning a readable line-level diff for Docs and a coarser summary for
// Sheets/Slides (see docindex.DiffContent). Read-only: requires only view access.
func (h *VersionHandler) Diff(c *gin.Context) {
	fileID := c.Param("id")
	versionID := c.Param("vid")
	if !h.authz.require(c, fileID) {
		return
	}

	file, err := h.store.GetFile(fileID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "file not found"})
		return
	}
	target, err := h.store.GetVersion(fileID, versionID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "version not found"})
		return
	}

	// Determine the "other side" of the diff.
	var (
		oldContent, newContent interface{}
		oldLabel, newLabel     string
	)
	against := c.DefaultQuery("against", "current")
	switch against {
	case "prior":
		// Compare the version immediately older than the target against it.
		versions, verr := h.store.ListVersions(fileID)
		if verr != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": verr.Error()})
			return
		}
		// versions is newest-first; find target and the one after it (older).
		var prior *models.FileVersion
		for i, v := range versions {
			if v.ID == versionID {
				if i+1 < len(versions) {
					prior = versions[i+1]
				}
				break
			}
		}
		if prior == nil {
			// No older version — diff against an empty document.
			oldContent, oldLabel = nil, "(nothing)"
		} else {
			oldContent, oldLabel = prior.Content, versionLabel(prior)
		}
		newContent, newLabel = target.Content, versionLabel(target)
	default: // "current"
		oldContent, oldLabel = target.Content, versionLabel(target)
		newContent, newLabel = file.Content, "current"
	}

	diff := docindex.DiffContent(string(file.Type), oldContent, newContent)
	c.JSON(http.StatusOK, gin.H{
		"file_id":   fileID,
		"type":      file.Type,
		"against":   against,
		"old_label": oldLabel,
		"new_label": newLabel,
		"diff":      diff,
	})
}

// versionLabel returns a short human label for a version (its custom label if
// set, otherwise a timestamp-based fallback).
func versionLabel(v *models.FileVersion) string {
	if v.Label != "" {
		return v.Label
	}
	return v.CreatedAt.Format("Jan 2, 15:04")
}
