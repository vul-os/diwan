package storage

// local_optlock_test.go — P2 optimistic-concurrency (lost-update prevention)
// coverage for the LocalStorage rev compare-and-swap. CreateFile seeds rev 1;
// UpdateFile rejects a stale rev with ErrRevConflict and advances rev on every
// committed write. A rev-0 (legacy) write is unconditional.

import (
	"errors"
	"testing"

	"diwan/backend/models"
)

func TestLocalUpdateFileRevCAS(t *testing.T) {
	s := newCollabStore(t)

	f := &models.File{ID: "doc1", Name: "Doc", Type: models.FileTypeDoc, Content: "v1"}
	if err := s.CreateFile(f); err != nil {
		t.Fatalf("CreateFile: %v", err)
	}
	if f.Rev != 1 {
		t.Fatalf("CreateFile rev: expected 1, got %d", f.Rev)
	}

	// Two editors read rev 1.
	e1, _ := s.GetFile("doc1")
	e2, _ := s.GetFile("doc1")
	if e1.Rev != 1 || e2.Rev != 1 {
		t.Fatalf("both reads should see rev 1, got %d/%d", e1.Rev, e2.Rev)
	}

	// Editor 1 commits against rev 1 → succeeds, rev → 2.
	up1 := &models.File{ID: "doc1", Name: "Doc", Content: "editor1", Rev: e1.Rev}
	if err := s.UpdateFile(up1); err != nil {
		t.Fatalf("editor1 UpdateFile: %v", err)
	}
	if up1.Rev != 2 {
		t.Fatalf("rev after editor1: expected 2, got %d", up1.Rev)
	}

	// Editor 2 commits against the now-STALE rev 1 → ErrRevConflict.
	up2 := &models.File{ID: "doc1", Name: "Doc", Content: "editor2", Rev: e2.Rev}
	if err := s.UpdateFile(up2); !errors.Is(err, ErrRevConflict) {
		t.Fatalf("editor2 stale UpdateFile: expected ErrRevConflict, got %v", err)
	}

	// The stored content is editor1's — editor2 did NOT clobber it.
	cur, _ := s.GetFile("doc1")
	if cur.Content != "editor1" || cur.Rev != 2 {
		t.Fatalf("stored after conflict: expected editor1/rev2, got %v/rev%d", cur.Content, cur.Rev)
	}

	// Editor 2 reconciles against the current rev → succeeds, rev → 3.
	up2b := &models.File{ID: "doc1", Name: "Doc", Content: "editor2", Rev: cur.Rev}
	if err := s.UpdateFile(up2b); err != nil {
		t.Fatalf("editor2 reconcile UpdateFile: %v", err)
	}
	if up2b.Rev != 3 {
		t.Fatalf("rev after reconcile: expected 3, got %d", up2b.Rev)
	}

	// A rev-0 (legacy) write is unconditional and still advances the rev.
	up3 := &models.File{ID: "doc1", Name: "Doc", Content: "legacy", Rev: 0}
	if err := s.UpdateFile(up3); err != nil {
		t.Fatalf("legacy unconditional UpdateFile: %v", err)
	}
	if up3.Rev != 4 {
		t.Fatalf("rev after legacy write: expected 4, got %d", up3.Rev)
	}
}
