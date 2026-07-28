package handlers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"diwan/backend/audit"
	"diwan/backend/fileacl"
	"diwan/backend/middleware"
	"diwan/backend/models"

	"github.com/gin-gonic/gin"
)

// versionAwareStorage wraps pentestStorage and creates a version snapshot
// in UpdateFile, mirroring LocalStorage behaviour (OFFICE-08).
type versionAwareStorage struct {
	*pentestStorage
}

func newVersionAwareStorage() *versionAwareStorage {
	return &versionAwareStorage{pentestStorage: newPentestStorage()}
}

func (v *versionAwareStorage) UpdateFile(file *models.File) error {
	// Get existing before overwrite so we can snapshot it.
	existing, err := v.pentestStorage.GetFile(file.ID)
	if err != nil {
		return err
	}
	// Snapshot the current content as a version.
	snap := &models.FileVersion{
		ID:        fmt.Sprintf("%d", time.Now().UnixNano()),
		FileID:    existing.ID,
		Name:      existing.Name,
		Content:   existing.Content,
		CreatedAt: time.Now(),
	}
	_ = v.pentestStorage.CreateVersion(snap)
	// Delegate the actual update to the embedded store.
	return v.pentestStorage.UpdateFile(file)
}

func versionTestRouter(store *versionAwareStorage, verifiedUser string) *gin.Engine {
	acl := fileacl.NewNullStore()
	authz := NewFileAuthz(acl)
	fh := NewFileHandlerWithAudit(store, authz, audit.NewNullStore())
	vh := &VersionHandler{store: store, authz: authz}
	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Set(middleware.CtxAuthenticated, true)
		c.Set(middleware.CtxUserID, verifiedUser)
		c.Next()
	})
	r.GET("/files", fh.List)
	r.POST("/files", fh.Create)
	r.GET("/files/:id", fh.Get)
	r.PUT("/files/:id", fh.Update)
	r.DELETE("/files/:id", fh.Delete)
	r.GET("/files/:id/versions", vh.ListVersions)
	return r
}

func TestVersionSnapshot_UpdateCreatesVersion(t *testing.T) {
	store := newVersionAwareStorage()
	r := versionTestRouter(store, "alice")

	// Create a file.
	createBody := `{"name":"test.doc","type":"doc","content":{"text":"hello"}}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodPost, "/files", bytes.NewBufferString(createBody))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("create file: expected 201 got %d — %s", w.Code, w.Body.String())
	}
	var created models.File
	json.Unmarshal(w.Body.Bytes(), &created)
	fileID := created.ID

	// Update the file (this should create a version snapshot).
	updateBody := `{"name":"test.doc","content":{"text":"world"}}`
	w2 := httptest.NewRecorder()
	req2, _ := http.NewRequest(http.MethodPut, "/files/"+fileID, bytes.NewBufferString(updateBody))
	req2.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w2, req2)
	if w2.Code != http.StatusOK {
		t.Fatalf("update file: expected 200 got %d — %s", w2.Code, w2.Body.String())
	}

	// List versions — should have at least one.
	w3 := httptest.NewRecorder()
	req3, _ := http.NewRequest(http.MethodGet, "/files/"+fileID+"/versions", nil)
	r.ServeHTTP(w3, req3)
	if w3.Code != http.StatusOK {
		t.Fatalf("list versions: expected 200 got %d", w3.Code)
	}
	var versions []*models.FileVersion
	json.Unmarshal(w3.Body.Bytes(), &versions)
	if len(versions) == 0 {
		t.Fatal("expected at least one version after update, got 0")
	}
}
