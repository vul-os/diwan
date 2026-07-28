package storage

// local_sharelinks_test.go — persistence coverage for anonymous read-only share
// links: the bcrypt hash MUST survive a round-trip on disk (it is the gate),
// while models.ShareLink keeps it json:"-" for the API projection. Also covers
// list-by-file and revoke.

import (
	"testing"
	"time"

	"diwan/backend/models"
)

func TestLocalShareLinks_RoundTripAndHashPersisted(t *testing.T) {
	s := newOrgStore(t)
	exp := time.Now().Add(time.Hour)
	in := &models.ShareLink{
		ID:           "link1",
		FileID:       "fileA",
		Token:        "tok-abc123",
		CreatedBy:    "alice",
		PasswordHash: "$2a$10$fakehashfakehashfakehashfakehashfakehashfakehashfa",
		ExpiresAt:    &exp,
		CreatedAt:    time.Now(),
	}
	if err := s.CreateShareLink(in); err != nil {
		t.Fatalf("CreateShareLink: %v", err)
	}

	got, err := s.GetShareLinkByToken("tok-abc123")
	if err != nil {
		t.Fatalf("GetShareLinkByToken: %v", err)
	}
	// The hash MUST have persisted (otherwise the password gate is a no-op).
	if got.PasswordHash != in.PasswordHash {
		t.Fatalf("password hash did not persist: got %q", got.PasswordHash)
	}
	if !got.HasPassword {
		t.Fatal("HasPassword should be derived true when a hash is stored")
	}
	if got.ExpiresAt == nil {
		t.Fatal("expiry should persist")
	}
	if got.FileID != "fileA" {
		t.Fatalf("file id round-trip wrong: %q", got.FileID)
	}
}

func TestLocalShareLinks_ListAndRevoke(t *testing.T) {
	s := newOrgStore(t)
	for _, tok := range []string{"tokA", "tokB"} {
		if err := s.CreateShareLink(&models.ShareLink{
			ID: "id-" + tok, FileID: "f1", Token: tok, CreatedBy: "alice", CreatedAt: time.Now(),
		}); err != nil {
			t.Fatalf("create %s: %v", tok, err)
		}
	}
	// A link on a different file must NOT appear in f1's list.
	_ = s.CreateShareLink(&models.ShareLink{ID: "other", FileID: "f2", Token: "tokC", CreatedAt: time.Now()})

	links, err := s.ListShareLinks("f1")
	if err != nil {
		t.Fatalf("ListShareLinks: %v", err)
	}
	if len(links) != 2 {
		t.Fatalf("expected 2 links for f1, got %d", len(links))
	}

	if err := s.RevokeShareLink("f1", "id-tokA"); err != nil {
		t.Fatalf("RevokeShareLink: %v", err)
	}
	got, _ := s.GetShareLinkByToken("tokA")
	if got == nil || !got.Revoked {
		t.Fatalf("link should be revoked after RevokeShareLink: %+v", got)
	}
	// Revoking a non-existent link errors.
	if err := s.RevokeShareLink("f1", "nope"); err == nil {
		t.Fatal("revoking a missing link should error")
	}
}
