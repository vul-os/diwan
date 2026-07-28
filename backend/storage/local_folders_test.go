package storage

// local_folders_test.go — parity file-organization storage coverage: folder
// CRUD, file org-metadata persistence (UpdateFileMeta), and the guarantee that a
// content-PUT (UpdateFile) preserves folder/star/trash placement.

import (
	"testing"
	"time"

	"diwan/backend/config"
	"diwan/backend/models"
)

func newOrgStore(t *testing.T) *LocalStorage {
	t.Helper()
	cfg := config.Default()
	cfg.Server.DataDir = t.TempDir()
	store, err := NewLocalStorage(cfg)
	if err != nil {
		t.Fatalf("NewLocalStorage: %v", err)
	}
	return store
}

func TestFolderCRUD(t *testing.T) {
	s := newOrgStore(t)
	f := &models.Folder{ID: "fold1", Name: "Work"}
	if err := s.CreateFolder(f); err != nil {
		t.Fatalf("CreateFolder: %v", err)
	}
	got, err := s.GetFolder("fold1")
	if err != nil || got.Name != "Work" {
		t.Fatalf("GetFolder: %v got=%+v", err, got)
	}
	got.Name = "Renamed"
	got.Starred = true
	if err := s.UpdateFolder(got); err != nil {
		t.Fatalf("UpdateFolder: %v", err)
	}
	got2, _ := s.GetFolder("fold1")
	if got2.Name != "Renamed" || !got2.Starred {
		t.Fatalf("update not persisted: %+v", got2)
	}
	list, _ := s.ListFolders()
	if len(list) != 1 {
		t.Fatalf("ListFolders = %d, want 1", len(list))
	}
	if err := s.DeleteFolder("fold1"); err != nil {
		t.Fatalf("DeleteFolder: %v", err)
	}
	if _, err := s.GetFolder("fold1"); err == nil {
		t.Fatal("folder should be gone")
	}
}

func TestUpdateFileMetaPersists(t *testing.T) {
	s := newOrgStore(t)
	if err := s.CreateFile(&models.File{ID: "file1", Name: "Doc", Type: models.FileTypeDoc, Content: "x"}); err != nil {
		t.Fatalf("CreateFile: %v", err)
	}
	now := time.Now()
	if err := s.UpdateFileMeta("file1", "fold1", true, true, &now); err != nil {
		t.Fatalf("UpdateFileMeta: %v", err)
	}
	got, _ := s.GetFile("file1")
	if got.ParentID != "fold1" || !got.Starred || !got.Trashed || got.TrashedAt == nil {
		t.Fatalf("meta not persisted: %+v", got)
	}
	// Meta update must NOT snapshot a version or bump rev.
	if got.Rev != 1 {
		t.Fatalf("meta update bumped rev to %d (want 1)", got.Rev)
	}
}

// A content PUT (UpdateFile) must PRESERVE folder/star/trash placement — the
// content path only carries Name/Content/Rev.
func TestUpdateFilePreservesOrgMeta(t *testing.T) {
	s := newOrgStore(t)
	_ = s.CreateFile(&models.File{ID: "file1", Name: "Doc", Type: models.FileTypeDoc, Content: "x"})
	now := time.Now()
	_ = s.UpdateFileMeta("file1", "fold1", true, false, &now)

	// Now do a content update as the handler would (no org fields set).
	if err := s.UpdateFile(&models.File{ID: "file1", Name: "Doc v2", Content: "y", Rev: 1}); err != nil {
		t.Fatalf("UpdateFile: %v", err)
	}
	got, _ := s.GetFile("file1")
	if got.ParentID != "fold1" || !got.Starred {
		t.Fatalf("content PUT wiped org placement: %+v", got)
	}
	if got.Content != "y" || got.Rev != 2 {
		t.Fatalf("content PUT did not apply: %+v", got)
	}
}
