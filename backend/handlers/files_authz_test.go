package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"diwan/backend/config"
	"diwan/backend/fileacl"
	"diwan/backend/middleware"
	"diwan/backend/models"
	"diwan/backend/storage"

	"github.com/gin-gonic/gin"
)

// memStorage is a minimal in-memory Storage implementation for handler tests.
// It implements File CRUD + folders/meta; the remaining interface methods panic
// to surface any unintended use.
type memStorage struct {
	files   map[string]*models.File
	folders map[string]*models.Folder
}

func newMemStorage() *memStorage {
	return &memStorage{
		files:   make(map[string]*models.File),
		folders: make(map[string]*models.Folder),
	}
}

func (m *memStorage) ListFiles() ([]*models.File, error) {
	out := make([]*models.File, 0, len(m.files))
	for _, f := range m.files {
		out = append(out, f)
	}
	return out, nil
}
func (m *memStorage) GetFile(id string) (*models.File, error) {
	if f, ok := m.files[id]; ok {
		return f, nil
	}
	return nil, errFileNotFound
}
func (m *memStorage) CreateFile(f *models.File) error { f.Rev = 1; m.files[f.ID] = f; return nil }
func (m *memStorage) UpdateFile(f *models.File) error {
	existing, ok := m.files[f.ID]
	if !ok {
		return errFileNotFound
	}
	// P2 optimistic concurrency: mirror the real store's rev compare-and-swap.
	if f.Rev > 0 && f.Rev != existing.Rev {
		return storage.ErrRevConflict
	}
	f.Rev = existing.Rev + 1
	m.files[f.ID] = f
	return nil
}
func (m *memStorage) DeleteFile(id string) error {
	if _, ok := m.files[id]; !ok {
		return errFileNotFound
	}
	delete(m.files, id)
	return nil
}
func (m *memStorage) UpdateFileMeta(id, parentID string, starred, trashed bool, trashedAt *time.Time) error {
	f, ok := m.files[id]
	if !ok {
		return errFileNotFound
	}
	f.ParentID = parentID
	f.Starred = starred
	f.Trashed = trashed
	f.TrashedAt = trashedAt
	return nil
}

// --- folders (parity) ---
func (m *memStorage) ListFolders() ([]*models.Folder, error) {
	out := make([]*models.Folder, 0, len(m.folders))
	for _, f := range m.folders {
		out = append(out, f)
	}
	return out, nil
}
func (m *memStorage) GetFolder(id string) (*models.Folder, error) {
	if f, ok := m.folders[id]; ok {
		return f, nil
	}
	return nil, errFile("folder not found")
}
func (m *memStorage) CreateFolder(f *models.Folder) error { m.folders[f.ID] = f; return nil }
func (m *memStorage) UpdateFolder(f *models.Folder) error {
	if _, ok := m.folders[f.ID]; !ok {
		return errFile("folder not found")
	}
	m.folders[f.ID] = f
	return nil
}
func (m *memStorage) DeleteFolder(id string) error {
	if _, ok := m.folders[id]; !ok {
		return errFile("folder not found")
	}
	delete(m.folders, id)
	return nil
}

// --- unused interface methods (panic if hit) ---
func (m *memStorage) ListVersions(string) ([]*models.FileVersion, error)       { panic("unused") }
func (m *memStorage) GetVersion(string, string) (*models.FileVersion, error)   { panic("unused") }
func (m *memStorage) CreateVersion(*models.FileVersion) error                  { panic("unused") }
func (m *memStorage) PruneVersions(string, int) error                          { panic("unused") }
func (m *memStorage) LabelVersion(string, string, string) error                { panic("unused") }
func (m *memStorage) CreateEnvelope(*models.Envelope) error                    { panic("unused") }
func (m *memStorage) GetEnvelope(string) (*models.Envelope, error)             { panic("unused") }
func (m *memStorage) ListEnvelopes() ([]*models.Envelope, error)               { panic("unused") }
func (m *memStorage) UpdateEnvelope(*models.Envelope) error                    { panic("unused") }
func (m *memStorage) DeleteEnvelope(string) error                              { panic("unused") }
func (m *memStorage) UpsertSigner(*models.Signer) error                        { panic("unused") }
func (m *memStorage) GetSigner(string) (*models.Signer, error)                 { panic("unused") }
func (m *memStorage) ListSignersByEnvelope(string) ([]*models.Signer, error)   { panic("unused") }
func (m *memStorage) AppendAuditEvent(*models.AuditEvent) error                { panic("unused") }
func (m *memStorage) ListAuditEvents(string) ([]*models.AuditEvent, error)     { panic("unused") }
func (m *memStorage) StoreSignerToken(string, string, string) error            { panic("unused") }
func (m *memStorage) ResolveToken(string) (string, string, error)              { panic("unused") }
func (m *memStorage) StoreSealedPDF(string, []byte) error                      { panic("unused") }
func (m *memStorage) GetSealedPDF(string) ([]byte, error)                      { panic("unused") }
func (m *memStorage) CreateComment(*models.Comment) error                      { panic("unused") }
func (m *memStorage) GetComment(string, string) (*models.Comment, error)       { panic("unused") }
func (m *memStorage) ListComments(string) ([]*models.Comment, error)           { panic("unused") }
func (m *memStorage) UpdateComment(*models.Comment) error                      { panic("unused") }
func (m *memStorage) DeleteComment(string, string) error                       { panic("unused") }
func (m *memStorage) CreateReply(*models.CommentReply) error                   { panic("unused") }
func (m *memStorage) GetReply(string, string) (*models.CommentReply, error)    { panic("unused") }
func (m *memStorage) ListReplies(string) ([]*models.CommentReply, error)       { panic("unused") }
func (m *memStorage) UpdateReply(*models.CommentReply) error                   { panic("unused") }
func (m *memStorage) CreateSuggestion(*models.Suggestion) error                { panic("unused") }
func (m *memStorage) GetSuggestion(string, string) (*models.Suggestion, error) { panic("unused") }
func (m *memStorage) ListSuggestions(string) ([]*models.Suggestion, error)     { panic("unused") }
func (m *memStorage) UpdateSuggestion(*models.Suggestion) error                { panic("unused") }
func (m *memStorage) DeleteSuggestion(string, string) error                    { panic("unused") }
func (m *memStorage) CreateShareLink(*models.ShareLink) error                  { panic("unused") }
func (m *memStorage) GetShareLinkByToken(string) (*models.ShareLink, error)    { panic("unused") }
func (m *memStorage) ListShareLinks(string) ([]*models.ShareLink, error)       { panic("unused") }
func (m *memStorage) RevokeShareLink(string, string) error                     { panic("unused") }

var _ storage.Storage = (*memStorage)(nil)

var errFileNotFound = errFile("file not found")

type errFile string

func (e errFile) Error() string { return string(e) }

// fileRouter wires the file routes with a verified identity injected.
func fileRouter(h *FileHandler, verifiedUser string, admin bool) *gin.Engine {
	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Set(middleware.CtxAuthenticated, true)
		c.Set(middleware.CtxUserID, verifiedUser)
		if admin {
			c.Set(middleware.CtxIsAdmin, true)
		}
		c.Next()
	})
	r.GET("/files", h.List)
	r.GET("/files/:id", h.Get)
	r.POST("/files", h.Create)
	r.PUT("/files/:id", h.Update)
	r.DELETE("/files/:id", h.Delete)
	r.POST("/files/:id/share", h.Share)
	return r
}

func doReq(r *gin.Engine, method, path string, body interface{}) *httptest.ResponseRecorder {
	var buf bytes.Buffer
	if body != nil {
		_ = json.NewEncoder(&buf).Encode(body)
	}
	req := httptest.NewRequest(method, path, &buf)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

// newAuthzFileHandler builds a FileHandler over the in-memory storage + an
// in-memory ACL store so tests never touch disk.
func newAuthzFileHandler() (*FileHandler, *memStorage, fileacl.Store) {
	st := newMemStorage()
	acl := fileacl.NewNullStore()
	h := NewFileHandlerWithAuthz(st, NewFileAuthz(acl))
	return h, st, acl
}

// createFileAs creates a file owned by `owner` and returns its id.
func createFileAs(t *testing.T, h *FileHandler, owner string) string {
	t.Helper()
	r := fileRouter(h, owner, false)
	w := doReq(r, http.MethodPost, "/files", models.CreateFileRequest{Name: "doc", Type: models.FileTypeDoc, Content: "secret"})
	if w.Code != http.StatusCreated {
		t.Fatalf("create as %s: expected 201, got %d (%s)", owner, w.Code, w.Body.String())
	}
	var f models.File
	if err := json.Unmarshal(w.Body.Bytes(), &f); err != nil {
		t.Fatalf("decode created file: %v", err)
	}
	return f.ID
}

// TestNonOwnerCannotAccessFile proves a non-owner gets 404 (no existence leak)
// on Get/Update/Delete of another user's file.
func TestNonOwnerCannotAccessFile(t *testing.T) {
	h, _, _ := newAuthzFileHandler()
	id := createFileAs(t, h, "alice")

	bob := fileRouter(h, "bob", false)

	if w := doReq(bob, http.MethodGet, "/files/"+id, nil); w.Code != http.StatusNotFound {
		t.Fatalf("Get as non-owner: expected 404, got %d (%s)", w.Code, w.Body.String())
	}
	if w := doReq(bob, http.MethodPut, "/files/"+id, models.UpdateFileRequest{Name: "hijacked"}); w.Code != http.StatusNotFound {
		t.Fatalf("Update as non-owner: expected 404, got %d", w.Code)
	}
	if w := doReq(bob, http.MethodDelete, "/files/"+id, nil); w.Code != http.StatusNotFound {
		t.Fatalf("Delete as non-owner: expected 404, got %d", w.Code)
	}

	// Owner still has access.
	alice := fileRouter(h, "alice", false)
	if w := doReq(alice, http.MethodGet, "/files/"+id, nil); w.Code != http.StatusOK {
		t.Fatalf("Get as owner: expected 200, got %d (%s)", w.Code, w.Body.String())
	}
}

// TestListReturnsOnlyAccessibleFiles proves List filters to the caller's files.
func TestListReturnsOnlyAccessibleFiles(t *testing.T) {
	h, _, _ := newAuthzFileHandler()
	aliceFile := createFileAs(t, h, "alice")
	bobFile := createFileAs(t, h, "bob")

	alice := fileRouter(h, "alice", false)
	w := doReq(alice, http.MethodGet, "/files", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("List: expected 200, got %d", w.Code)
	}
	var files []*models.File
	if err := json.Unmarshal(w.Body.Bytes(), &files); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(files) != 1 || files[0].ID != aliceFile {
		t.Fatalf("alice should see only her own file; got %d files: %+v", len(files), files)
	}
	for _, f := range files {
		if f.ID == bobFile {
			t.Fatal("alice's List leaked bob's file")
		}
	}
}

// TestShareGrantsAccess proves an explicit share lets another account read the file.
func TestShareGrantsAccess(t *testing.T) {
	h, _, _ := newAuthzFileHandler()
	id := createFileAs(t, h, "alice")

	bob := fileRouter(h, "bob", false)
	// Before sharing, bob is denied.
	if w := doReq(bob, http.MethodGet, "/files/"+id, nil); w.Code != http.StatusNotFound {
		t.Fatalf("pre-share Get: expected 404, got %d", w.Code)
	}

	// Alice shares with bob.
	alice := fileRouter(h, "alice", false)
	w := doReq(alice, http.MethodPost, "/files/"+id+"/share", map[string]interface{}{"account_id": "bob"})
	if w.Code != http.StatusOK {
		t.Fatalf("share: expected 200, got %d (%s)", w.Code, w.Body.String())
	}

	// Now bob can read it, and it shows up in his List.
	if w := doReq(bob, http.MethodGet, "/files/"+id, nil); w.Code != http.StatusOK {
		t.Fatalf("post-share Get: expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	w = doReq(bob, http.MethodGet, "/files", nil)
	var files []*models.File
	_ = json.Unmarshal(w.Body.Bytes(), &files)
	if len(files) != 1 || files[0].ID != id {
		t.Fatalf("shared file should appear in bob's List; got %+v", files)
	}

	// A non-shared third party (mallory) is still denied.
	mallory := fileRouter(h, "mallory", false)
	if w := doReq(mallory, http.MethodGet, "/files/"+id, nil); w.Code != http.StatusNotFound {
		t.Fatalf("mallory Get: expected 404, got %d", w.Code)
	}
}

// TestAdminBypassesFileACL proves an admin can reach any file.
func TestAdminBypassesFileACL(t *testing.T) {
	h, _, _ := newAuthzFileHandler()
	id := createFileAs(t, h, "alice")

	admin := fileRouter(h, "root", true)
	if w := doReq(admin, http.MethodGet, "/files/"+id, nil); w.Code != http.StatusOK {
		t.Fatalf("admin Get: expected 200, got %d (%s)", w.Code, w.Body.String())
	}
}

// TestUnownedLegacyFileIsAccessible proves the fail-safe: a file with no recorded
// owner (pre-ACL / local mode) remains readable so existing data is not orphaned.
func TestUnownedLegacyFileIsAccessible(t *testing.T) {
	h, st, _ := newAuthzFileHandler()
	// Inject a file directly into storage WITHOUT recording an owner.
	st.files["legacy"] = &models.File{ID: "legacy", Name: "old", Type: models.FileTypeDoc}

	anyUser := fileRouter(h, "whoever", false)
	if w := doReq(anyUser, http.MethodGet, "/files/legacy", nil); w.Code != http.StatusOK {
		t.Fatalf("legacy unowned file should be accessible; got %d", w.Code)
	}
}

// keep config import referenced (used by other auth tests in package); ensure
// this file compiles standalone if reordered.
var _ = config.Default
