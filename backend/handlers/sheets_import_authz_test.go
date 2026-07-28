package handlers

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"diwan/backend/fileacl"
	"diwan/backend/middleware"
	"diwan/backend/models"

	"github.com/gin-gonic/gin"
)

// sheetsImportRouter wires POST /sheets/:id/import with a verified identity.
func sheetsImportRouter(h *SheetsHandler, user string) *gin.Engine {
	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Set(middleware.CtxAuthenticated, true)
		c.Set(middleware.CtxUserID, user)
		c.Next()
	})
	r.POST("/sheets/:id/import", h.Import)
	return r
}

// TestSheetsImportRequiresEditor proves the SECURITY FIX: POST /sheets/:id/import
// OVERWRITES the file content, so a read-only VIEWER (and a commenter) must be
// refused (403) — previously it only checked read access, letting a viewer clobber
// the whole spreadsheet by uploading an .xlsx. An editor passes the authz gate
// (and then fails later on the missing file field, which proves authz let them
// through rather than blocking them).
func TestSheetsImportRequiresEditor(t *testing.T) {
	st := newMemStorage()
	acl := fileacl.NewNullStore()
	authz := NewFileAuthzWithAuth(acl, true)
	h := &SheetsHandler{store: st, authz: authz}

	fileID := "sheet1"
	st.files[fileID] = &models.File{ID: fileID, Name: "Book", Type: models.FileTypeSheet, Rev: 1}
	_ = acl.SetOwner(fileID, "alice")
	_ = acl.ShareWithRole(fileID, "dave", fileacl.RoleViewer)
	_ = acl.ShareWithRole(fileID, "cara", fileacl.RoleCommenter)
	_ = acl.ShareWithRole(fileID, "bob", fileacl.RoleEditor)

	post := func(user string) int {
		r := sheetsImportRouter(h, user)
		// No multipart body: an EDITOR reaches the "file field missing" 400 (authz
		// passed); a VIEWER/COMMENTER is stopped at the authz gate with 403.
		req := httptest.NewRequest(http.MethodPost, "/sheets/"+fileID+"/import", nil)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		return w.Code
	}

	if code := post("dave"); code != http.StatusForbidden {
		t.Fatalf("viewer import: expected 403, got %d", code)
	}
	if code := post("cara"); code != http.StatusForbidden {
		t.Fatalf("commenter import: expected 403, got %d", code)
	}
	// A stranger has no access at all → 404 (no existence leak).
	if code := post("mallory"); code != http.StatusNotFound {
		t.Fatalf("stranger import: expected 404, got %d", code)
	}
	// Editor + owner pass the authz gate (then 400 on the missing file field).
	if code := post("bob"); code != http.StatusBadRequest {
		t.Fatalf("editor import (no file): expected 400 after passing authz, got %d", code)
	}
	if code := post("alice"); code != http.StatusBadRequest {
		t.Fatalf("owner import (no file): expected 400 after passing authz, got %d", code)
	}
}
