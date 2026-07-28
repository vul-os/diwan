package storage

// local_versions_test.go — WAVE32 coverage. The wave-14 version snapshot /
// restore / label path (LabelVersion, PruneVersions, GetVersion not-found) and
// the sealed-PDF not-found path were thinly/never covered. Version pruning is
// correctness-critical: an off-by-one keeps too few or too many snapshots, and
// LabelVersion must not mutate any other field of the snapshot.

import (
	"testing"
	"time"

	"diwan/backend/models"
)

// TestVersionSnapshotAndLabel proves a labelled snapshot round-trips and that
// LabelVersion mutates ONLY the label (name/content preserved).
func TestVersionSnapshotAndLabel(t *testing.T) {
	s := newCollabStore(t)

	v := &models.FileVersion{ID: "v1", FileID: "doc", Name: "Draft", Content: map[string]any{"body": "text"}, CreatedAt: time.Now()}
	if err := s.CreateVersion(v); err != nil {
		t.Fatalf("CreateVersion: %v", err)
	}

	// GetVersion on a missing version is a clean not-found.
	if _, err := s.GetVersion("doc", "nope"); err == nil {
		t.Fatal("GetVersion(missing): expected error")
	}

	if err := s.LabelVersion("doc", "v1", "final draft"); err != nil {
		t.Fatalf("LabelVersion: %v", err)
	}
	got, err := s.GetVersion("doc", "v1")
	if err != nil {
		t.Fatalf("GetVersion: %v", err)
	}
	if got.Label != "final draft" {
		t.Errorf("label not persisted: %q", got.Label)
	}
	if got.Name != "Draft" {
		t.Errorf("LabelVersion clobbered Name: %q", got.Name)
	}

	// LabelVersion on a missing version must error, not create a stub.
	if err := s.LabelVersion("doc", "ghost", "x"); err == nil {
		t.Error("LabelVersion(ghost): expected error")
	}

	// Traversal guard on the version path builder.
	if err := s.CreateVersion(&models.FileVersion{ID: "../../evil", FileID: "doc"}); err == nil {
		t.Error("CreateVersion with traversal versionID: expected error")
	}
	if err := s.LabelVersion("../../evil", "v", "x"); err == nil {
		t.Error("LabelVersion with traversal fileID: expected error")
	}
}

// TestVersionListOrderAndPrune proves ListVersions is newest-first and
// PruneVersions retains exactly `cap` newest snapshots.
func TestVersionListOrderAndPrune(t *testing.T) {
	s := newCollabStore(t)

	base := time.Now()
	for i := 0; i < 5; i++ {
		v := &models.FileVersion{
			ID:        string(rune('a' + i)),
			FileID:    "doc",
			CreatedAt: base.Add(time.Duration(i) * time.Minute),
		}
		if err := s.CreateVersion(v); err != nil {
			t.Fatalf("CreateVersion %d: %v", i, err)
		}
	}

	list, err := s.ListVersions("doc")
	if err != nil {
		t.Fatalf("ListVersions: %v", err)
	}
	if len(list) != 5 {
		t.Fatalf("ListVersions len = %d; want 5", len(list))
	}
	// Newest-first: each entry's CreatedAt >= the next.
	for i := 1; i < len(list); i++ {
		if list[i-1].CreatedAt.Before(list[i].CreatedAt) {
			t.Fatalf("ListVersions not newest-first at %d", i)
		}
	}

	// Prune to 2 → the 2 newest survive, the 3 oldest are removed.
	if err := s.PruneVersions("doc", 2); err != nil {
		t.Fatalf("PruneVersions: %v", err)
	}
	after, _ := s.ListVersions("doc")
	if len(after) != 2 {
		t.Fatalf("after prune len = %d; want 2", len(after))
	}
	// The surviving two are the newest (ids 'd','e' with the largest CreatedAt).
	if after[0].ID != "e" || after[1].ID != "d" {
		t.Errorf("prune kept the wrong versions: %s,%s (want e,d)", after[0].ID, after[1].ID)
	}

	// Prune with cap >= len is a no-op (no panic, nothing removed).
	if err := s.PruneVersions("doc", 100); err != nil {
		t.Fatalf("PruneVersions(large cap): %v", err)
	}
	if got, _ := s.ListVersions("doc"); len(got) != 2 {
		t.Errorf("prune with large cap removed versions: len=%d", len(got))
	}
}

// TestGetSealedPDFNotFound covers the not-found branch of the sealed-PDF read
// and proves store→read round-trips.
func TestGetSealedPDFNotFound(t *testing.T) {
	s := newCollabStore(t)

	if _, err := s.GetSealedPDF("no-such-envelope"); err == nil {
		t.Fatal("GetSealedPDF(missing): expected error")
	}

	if err := s.StoreSealedPDF("env1", []byte("%PDF-1.7 sealed")); err != nil {
		t.Fatalf("StoreSealedPDF: %v", err)
	}
	got, err := s.GetSealedPDF("env1")
	if err != nil {
		t.Fatalf("GetSealedPDF: %v", err)
	}
	if string(got) != "%PDF-1.7 sealed" {
		t.Errorf("sealed PDF round-trip mismatch: %q", got)
	}

	// Traversal: a crafted envelope id must be refused on read too.
	if _, err := s.GetSealedPDF("../../etc/passwd"); err == nil {
		t.Error("GetSealedPDF with traversal id: expected error")
	}
}
