package storage

// local_traversal_test.go — WAVE14 Finding 2/4 (HIGH).
//
// Every LocalStorage path helper validates its id(s) with validID so a crafted,
// body-supplied identifier such as "../../x" can never be joined into a
// filesystem path and escape the store. The helpers fail closed: they return
// errInvalidID and never write/read an out-of-tree file.

import (
	"os"
	"path/filepath"
	"testing"

	"diwan/backend/config"
	"diwan/backend/models"
)

func newTraversalStore(t *testing.T) (*LocalStorage, string) {
	t.Helper()
	dir := t.TempDir()
	cfg := config.Default()
	cfg.Server.DataDir = dir
	store, err := NewLocalStorage(cfg)
	if err != nil {
		t.Fatalf("NewLocalStorage: %v", err)
	}
	return store, dir
}

// TestValidID rejects traversal/empty/malformed ids and accepts uuid-shaped ids.
func TestValidID(t *testing.T) {
	bad := []string{
		"", ".", "..", "../../x", "../etc/passwd", "a/b", "a\\b",
		"foo.json", "with space", "a.b", "/abs", "x/../y",
	}
	for _, id := range bad {
		if validID(id) {
			t.Errorf("validID(%q) = true; want false", id)
		}
	}
	good := []string{
		"abc", "ABC123", "a-b_c",
		"550e8400-e29b-41d4-a716-446655440000", // uuid
		"1720000000000000000",                  // unix-nano version id
	}
	for _, id := range good {
		if !validID(id) {
			t.Errorf("validID(%q) = false; want true", id)
		}
	}
}

// TestTraversalRejectedByHelpers proves the CRUD entry points reject a traversal
// id and never create a file outside the store.
func TestTraversalRejectedByHelpers(t *testing.T) {
	store, dir := newTraversalStore(t)

	// A file whose id would escape the data dir must be refused, not written.
	if err := store.CreateFile(&models.File{ID: "../../pwned", Name: "x"}); err == nil {
		t.Fatal("CreateFile with traversal id: expected error, got nil")
	}
	if err := store.CreateEnvelope(&models.Envelope{ID: "../../pwned-env"}); err == nil {
		t.Fatal("CreateEnvelope with traversal id: expected error, got nil")
	}
	if _, err := store.GetFile("../../../etc/passwd"); err == nil {
		t.Fatal("GetFile with traversal id: expected error, got nil")
	}
	if _, err := store.GetEnvelope("../../secret"); err == nil {
		t.Fatal("GetEnvelope with traversal id: expected error, got nil")
	}
	if err := store.StoreSealedPDF("../../pwned", []byte("x")); err == nil {
		t.Fatal("StoreSealedPDF with traversal id: expected error, got nil")
	}
	if err := store.CreateComment(&models.Comment{ID: "../../c", FileID: "f"}); err == nil {
		t.Fatal("CreateComment with traversal id: expected error, got nil")
	}

	// No file was created anywhere outside the (empty) sub-dirs of the store.
	// Walk the parent of the data dir and assert nothing named *pwned* leaked out.
	parent := filepath.Dir(dir)
	_ = filepath.Walk(parent, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if info.IsDir() {
			return nil
		}
		if name := info.Name(); name == "pwned.json" || name == "pwned-env.json" ||
			name == "pwned.pdf" {
			t.Fatalf("traversal wrote a file outside the store: %s", p)
		}
		return nil
	})
}
