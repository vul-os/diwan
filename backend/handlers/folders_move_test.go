package handlers

import (
	"encoding/json"
	"net/http"
	"testing"

	"diwan/backend/fileacl"
	"diwan/backend/middleware"
	"diwan/backend/models"

	"github.com/gin-gonic/gin"
)

// --- test wiring (multi-tenant / auth-enabled so ACL ownership is enforced) ---

func newOrgHandlers() (*FileHandler, *FolderHandler, *memStorage) {
	st := newMemStorage()
	authz := NewFileAuthzWithAuth(fileacl.NewNullStore(), true)
	fh := NewFileHandlerWithAuthz(st, authz)
	folderH := NewFolderHandlerWithAuthz(st, authz)
	return fh, folderH, st
}

func orgRouter(fh *FileHandler, folderH *FolderHandler, user string) *gin.Engine {
	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Set(middleware.CtxAuthenticated, true)
		c.Set(middleware.CtxUserID, user)
		c.Next()
	})
	r.POST("/files", fh.Create)
	r.GET("/files", fh.List)
	r.GET("/files/:id", fh.Get)
	r.POST("/files/:id/move", fh.Move)
	r.DELETE("/files/:id", fh.Delete)
	r.GET("/folders", folderH.List)
	r.POST("/folders", folderH.Create)
	r.PUT("/folders/:id", folderH.Update)
	r.POST("/folders/:id/trash", folderH.Trash)
	r.DELETE("/folders/:id", folderH.Delete)
	return r
}

func mustCreateFolder(t *testing.T, r *gin.Engine, name, parent string) models.Folder {
	t.Helper()
	w := doReq(r, http.MethodPost, "/folders", models.CreateFolderRequest{Name: name, ParentID: parent})
	if w.Code != http.StatusCreated {
		t.Fatalf("create folder: expected 201, got %d (%s)", w.Code, w.Body.String())
	}
	var f models.Folder
	if err := json.Unmarshal(w.Body.Bytes(), &f); err != nil {
		t.Fatalf("decode folder: %v", err)
	}
	return f
}

func mustCreateOrgFile(t *testing.T, r *gin.Engine, name string) models.File {
	t.Helper()
	w := doReq(r, http.MethodPost, "/files", models.CreateFileRequest{Name: name, Type: models.FileTypeDoc, Content: "x"})
	if w.Code != http.StatusCreated {
		t.Fatalf("create file: expected 201, got %d (%s)", w.Code, w.Body.String())
	}
	var f models.File
	_ = json.Unmarshal(w.Body.Bytes(), &f)
	return f
}

// TestFolderCreateAndListIsolation: alice's folders never appear in bob's list.
func TestFolderCreateAndListIsolation(t *testing.T) {
	fh, folderH, _ := newOrgHandlers()
	alice := orgRouter(fh, folderH, "alice")
	bob := orgRouter(fh, folderH, "bob")

	f := mustCreateFolder(t, alice, "Work", "")

	w := doReq(bob, http.MethodGet, "/folders", nil)
	var bobFolders []*models.Folder
	_ = json.Unmarshal(w.Body.Bytes(), &bobFolders)
	for _, bf := range bobFolders {
		if bf.ID == f.ID {
			t.Fatal("bob's folder list leaked alice's folder")
		}
	}

	w = doReq(alice, http.MethodGet, "/folders", nil)
	var aliceFolders []*models.Folder
	_ = json.Unmarshal(w.Body.Bytes(), &aliceFolders)
	if len(aliceFolders) != 1 || aliceFolders[0].ID != f.ID {
		t.Fatalf("alice should see her one folder, got %d", len(aliceFolders))
	}
}

// TestMoveFileIntoOwnFolder: owner can file their file under their folder.
func TestMoveFileIntoOwnFolder(t *testing.T) {
	fh, folderH, _ := newOrgHandlers()
	alice := orgRouter(fh, folderH, "alice")

	folder := mustCreateFolder(t, alice, "Work", "")
	file := mustCreateOrgFile(t, alice, "doc")

	parent := folder.ID
	w := doReq(alice, http.MethodPost, "/files/"+file.ID+"/move", models.MoveFileRequest{ParentID: &parent})
	if w.Code != http.StatusOK {
		t.Fatalf("move: expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	var moved models.File
	_ = json.Unmarshal(w.Body.Bytes(), &moved)
	if moved.ParentID != folder.ID {
		t.Fatalf("file parent = %q, want %q", moved.ParentID, folder.ID)
	}
}

// TestMoveFileIntoForeignFolderDenied: alice cannot file her file into bob's
// folder (cross-account tree write blocked).
func TestMoveFileIntoForeignFolderDenied(t *testing.T) {
	fh, folderH, _ := newOrgHandlers()
	alice := orgRouter(fh, folderH, "alice")
	bob := orgRouter(fh, folderH, "bob")

	bobFolder := mustCreateFolder(t, bob, "BobWork", "")
	aliceFile := mustCreateOrgFile(t, alice, "doc")

	parent := bobFolder.ID
	w := doReq(alice, http.MethodPost, "/files/"+aliceFile.ID+"/move", models.MoveFileRequest{ParentID: &parent})
	// require owner on bob's folder → alice has no access → 404 (no leak).
	if w.Code != http.StatusNotFound {
		t.Fatalf("move into foreign folder: expected 404, got %d (%s)", w.Code, w.Body.String())
	}
}

// TestMoveForeignFileDenied: bob cannot move/trash alice's file.
func TestMoveForeignFileDenied(t *testing.T) {
	fh, folderH, _ := newOrgHandlers()
	alice := orgRouter(fh, folderH, "alice")
	bob := orgRouter(fh, folderH, "bob")

	aliceFile := mustCreateOrgFile(t, alice, "doc")

	trash := true
	w := doReq(bob, http.MethodPost, "/files/"+aliceFile.ID+"/move", models.MoveFileRequest{Trashed: &trash})
	if w.Code != http.StatusNotFound {
		t.Fatalf("bob moving alice's file: expected 404, got %d", w.Code)
	}
}

// TestTrashAndRestore: trash hides a file (flag set), restore clears it.
func TestTrashAndRestore(t *testing.T) {
	fh, folderH, st := newOrgHandlers()
	alice := orgRouter(fh, folderH, "alice")
	file := mustCreateOrgFile(t, alice, "doc")

	trash := true
	w := doReq(alice, http.MethodPost, "/files/"+file.ID+"/move", models.MoveFileRequest{Trashed: &trash})
	if w.Code != http.StatusOK {
		t.Fatalf("trash: expected 200, got %d", w.Code)
	}
	got, _ := st.GetFile(file.ID)
	if !got.Trashed || got.TrashedAt == nil {
		t.Fatalf("file should be trashed with a timestamp; got trashed=%v ts=%v", got.Trashed, got.TrashedAt)
	}

	restore := false
	w = doReq(alice, http.MethodPost, "/files/"+file.ID+"/move", models.MoveFileRequest{Trashed: &restore})
	if w.Code != http.StatusOK {
		t.Fatalf("restore: expected 200, got %d", w.Code)
	}
	got, _ = st.GetFile(file.ID)
	if got.Trashed || got.TrashedAt != nil {
		t.Fatalf("file should be restored; got trashed=%v ts=%v", got.Trashed, got.TrashedAt)
	}
}

// TestStarToggle: star flag flips without touching content/rev.
func TestStarToggle(t *testing.T) {
	fh, folderH, st := newOrgHandlers()
	alice := orgRouter(fh, folderH, "alice")
	file := mustCreateOrgFile(t, alice, "doc")
	revBefore := file.Rev

	star := true
	w := doReq(alice, http.MethodPost, "/files/"+file.ID+"/move", models.MoveFileRequest{Starred: &star})
	if w.Code != http.StatusOK {
		t.Fatalf("star: expected 200, got %d", w.Code)
	}
	got, _ := st.GetFile(file.ID)
	if !got.Starred {
		t.Fatal("file should be starred")
	}
	if got.Rev != revBefore {
		t.Fatalf("star must not bump content rev: before=%d after=%d", revBefore, got.Rev)
	}
}

// TestFolderCycleRejected: reparenting a folder under its own descendant fails.
func TestFolderCycleRejected(t *testing.T) {
	fh, folderH, _ := newOrgHandlers()
	alice := orgRouter(fh, folderH, "alice")

	parent := mustCreateFolder(t, alice, "Parent", "")
	child := mustCreateFolder(t, alice, "Child", parent.ID)

	// Try to move Parent under Child → cycle.
	target := child.ID
	w := doReq(alice, http.MethodPut, "/folders/"+parent.ID, models.UpdateFolderRequest{ParentID: &target})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("cycle reparent: expected 400, got %d (%s)", w.Code, w.Body.String())
	}
}

// TestPermanentDeleteFromTrash: DELETE removes the file permanently.
func TestPermanentDeleteFromTrash(t *testing.T) {
	fh, folderH, st := newOrgHandlers()
	alice := orgRouter(fh, folderH, "alice")
	file := mustCreateOrgFile(t, alice, "doc")

	trash := true
	_ = doReq(alice, http.MethodPost, "/files/"+file.ID+"/move", models.MoveFileRequest{Trashed: &trash})

	w := doReq(alice, http.MethodDelete, "/files/"+file.ID, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("permanent delete: expected 200, got %d", w.Code)
	}
	if _, err := st.GetFile(file.ID); err == nil {
		t.Fatal("file should be permanently deleted")
	}
}

// TestFolderDeleteReparentsChildFilesToRoot: deleting a folder frees its files.
func TestFolderDeleteReparentsChildFilesToRoot(t *testing.T) {
	fh, folderH, st := newOrgHandlers()
	alice := orgRouter(fh, folderH, "alice")

	folder := mustCreateFolder(t, alice, "Work", "")
	file := mustCreateOrgFile(t, alice, "doc")
	parent := folder.ID
	_ = doReq(alice, http.MethodPost, "/files/"+file.ID+"/move", models.MoveFileRequest{ParentID: &parent})

	w := doReq(alice, http.MethodDelete, "/folders/"+folder.ID, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("folder delete: expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	got, _ := st.GetFile(file.ID)
	if got.ParentID != "" {
		t.Fatalf("child file should fall back to root, got parent %q", got.ParentID)
	}
}
