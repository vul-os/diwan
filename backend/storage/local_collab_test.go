package storage

// local_collab_test.go — WAVE32 coverage. The comment / reply / suggestion CRUD
// (OFFICE-26/27) was entirely untested (0% on Get/List/Update/Delete for all
// three), as were the version LabelVersion/PruneVersions edge cases and the
// sealed-PDF not-found path. These are correctness-critical: authorship
// preservation on update, ordering, tombstone handling, and traversal-safety on
// the reply/suggestion path builders.

import (
	"testing"
	"time"

	"diwan/backend/config"
	"diwan/backend/models"
)

func newCollabStore(t *testing.T) *LocalStorage {
	t.Helper()
	cfg := config.Default()
	cfg.Server.DataDir = t.TempDir()
	store, err := NewLocalStorage(cfg)
	if err != nil {
		t.Fatalf("NewLocalStorage: %v", err)
	}
	return store
}

// TestCommentLifecycle exercises the full comment CRUD and proves UpdateComment
// preserves CreatedAt (authorship/audit correctness) while bumping UpdatedAt.
func TestCommentLifecycle(t *testing.T) {
	s := newCollabStore(t)

	// Get on a missing comment must be a clean not-found, not a panic/empty.
	if _, err := s.GetComment("file1", "missing"); err == nil {
		t.Fatal("GetComment(missing): expected error")
	}
	// List on a file with no comments returns nil, no error.
	if got, err := s.ListComments("file1"); err != nil || got != nil {
		t.Fatalf("ListComments(empty) = %v, %v; want nil, nil", got, err)
	}

	c := &models.Comment{ID: "c1", FileID: "file1", AuthorID: "alice", Body: "hello"}
	if err := s.CreateComment(c); err != nil {
		t.Fatalf("CreateComment: %v", err)
	}
	created := c.CreatedAt
	if created.IsZero() {
		t.Fatal("CreateComment did not stamp CreatedAt")
	}

	got, err := s.GetComment("file1", "c1")
	if err != nil {
		t.Fatalf("GetComment: %v", err)
	}
	if got.Body != "hello" || got.AuthorID != "alice" {
		t.Fatalf("GetComment mismatch: %+v", got)
	}

	// Update body; CreatedAt must be preserved, UpdatedAt must advance.
	time.Sleep(2 * time.Millisecond)
	upd := &models.Comment{ID: "c1", FileID: "file1", AuthorID: "alice", Body: "edited"}
	if err := s.UpdateComment(upd); err != nil {
		t.Fatalf("UpdateComment: %v", err)
	}
	if !upd.CreatedAt.Equal(created) {
		t.Errorf("UpdateComment clobbered CreatedAt: got %v want %v", upd.CreatedAt, created)
	}
	if !upd.UpdatedAt.After(created) {
		t.Errorf("UpdateComment did not advance UpdatedAt: %v", upd.UpdatedAt)
	}
	if reread, _ := s.GetComment("file1", "c1"); reread.Body != "edited" {
		t.Errorf("update not persisted: %q", reread.Body)
	}

	// Update on a non-existent comment must error (can't preserve unknown CreatedAt).
	if err := s.UpdateComment(&models.Comment{ID: "ghost", FileID: "file1"}); err == nil {
		t.Error("UpdateComment(ghost): expected error")
	}

	// List returns the created-order-sorted set.
	if err := s.CreateComment(&models.Comment{ID: "c2", FileID: "file1", AuthorID: "bob", Body: "second"}); err != nil {
		t.Fatalf("CreateComment c2: %v", err)
	}
	list, err := s.ListComments("file1")
	if err != nil {
		t.Fatalf("ListComments: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("ListComments len = %d; want 2", len(list))
	}
	if !list[0].CreatedAt.Before(list[1].CreatedAt) && !list[0].CreatedAt.Equal(list[1].CreatedAt) {
		t.Error("ListComments not sorted oldest-first")
	}

	// Delete then confirm gone; second delete is a clean not-found.
	if err := s.DeleteComment("file1", "c1"); err != nil {
		t.Fatalf("DeleteComment: %v", err)
	}
	if _, err := s.GetComment("file1", "c1"); err == nil {
		t.Error("GetComment after delete: expected error")
	}
	if err := s.DeleteComment("file1", "c1"); err == nil {
		t.Error("DeleteComment(twice): expected not-found error")
	}
}

// TestReplyLifecycle exercises reply CRUD, CreatedAt preservation on update, and
// the traversal guard on replyPath (via a crafted commentID).
func TestReplyLifecycle(t *testing.T) {
	s := newCollabStore(t)

	if got, err := s.ListReplies("c1"); err != nil || got != nil {
		t.Fatalf("ListReplies(empty) = %v,%v; want nil,nil", got, err)
	}
	if _, err := s.GetReply("c1", "missing"); err == nil {
		t.Fatal("GetReply(missing): expected error")
	}

	r := &models.CommentReply{ID: "r1", CommentID: "c1", FileID: "f1", AuthorID: "alice", Body: "re"}
	if err := s.CreateReply(r); err != nil {
		t.Fatalf("CreateReply: %v", err)
	}
	created := r.CreatedAt

	time.Sleep(2 * time.Millisecond)
	upd := &models.CommentReply{ID: "r1", CommentID: "c1", FileID: "f1", AuthorID: "alice", Body: "re-edited", Deleted: true}
	if err := s.UpdateReply(upd); err != nil {
		t.Fatalf("UpdateReply: %v", err)
	}
	if !upd.CreatedAt.Equal(created) {
		t.Errorf("UpdateReply clobbered CreatedAt")
	}
	got, _ := s.GetReply("c1", "r1")
	if got.Body != "re-edited" || !got.Deleted {
		t.Errorf("UpdateReply not persisted (tombstone): %+v", got)
	}

	if err := s.UpdateReply(&models.CommentReply{ID: "ghost", CommentID: "c1"}); err == nil {
		t.Error("UpdateReply(ghost): expected error")
	}

	// Two replies list oldest-first.
	_ = s.CreateReply(&models.CommentReply{ID: "r2", CommentID: "c1", FileID: "f1", Body: "two"})
	list, _ := s.ListReplies("c1")
	if len(list) != 2 {
		t.Fatalf("ListReplies len = %d; want 2", len(list))
	}

	// Traversal: a crafted commentID must be refused by CreateReply, never written.
	if err := s.CreateReply(&models.CommentReply{ID: "x", CommentID: "../../evil"}); err == nil {
		t.Error("CreateReply with traversal commentID: expected error")
	}
	if _, err := s.GetReply("../../evil", "x"); err == nil {
		t.Error("GetReply with traversal commentID: expected error")
	}
}

// TestSuggestionLifecycle exercises suggestion CRUD, CreatedAt preservation,
// reviewer stamping on accept, and the traversal guard.
func TestSuggestionLifecycle(t *testing.T) {
	s := newCollabStore(t)

	if got, err := s.ListSuggestions("f1"); err != nil || got != nil {
		t.Fatalf("ListSuggestions(empty) = %v,%v", got, err)
	}
	if _, err := s.GetSuggestion("f1", "missing"); err == nil {
		t.Fatal("GetSuggestion(missing): expected error")
	}

	sg := &models.Suggestion{ID: "s1", FileID: "f1", AuthorID: "alice", Kind: models.SuggestionInsert, Text: "add", From: 3, To: 3}
	if err := s.CreateSuggestion(sg); err != nil {
		t.Fatalf("CreateSuggestion: %v", err)
	}
	created := sg.CreatedAt

	// Accept: reviewer stamps a distinct account; CreatedAt preserved.
	time.Sleep(2 * time.Millisecond)
	upd := &models.Suggestion{ID: "s1", FileID: "f1", AuthorID: "alice", Kind: models.SuggestionInsert, Text: "add", From: 3, To: 3, ReviewerID: "carol", State: models.SuggestionAccepted}
	if err := s.UpdateSuggestion(upd); err != nil {
		t.Fatalf("UpdateSuggestion: %v", err)
	}
	if !upd.CreatedAt.Equal(created) {
		t.Errorf("UpdateSuggestion clobbered CreatedAt")
	}
	got, _ := s.GetSuggestion("f1", "s1")
	if got.ReviewerID != "carol" || got.State != models.SuggestionAccepted {
		t.Errorf("accept not persisted: %+v", got)
	}

	if err := s.UpdateSuggestion(&models.Suggestion{ID: "ghost", FileID: "f1"}); err == nil {
		t.Error("UpdateSuggestion(ghost): expected error")
	}

	_ = s.CreateSuggestion(&models.Suggestion{ID: "s2", FileID: "f1", AuthorID: "bob"})
	list, _ := s.ListSuggestions("f1")
	if len(list) != 2 {
		t.Fatalf("ListSuggestions len = %d; want 2", len(list))
	}

	if err := s.DeleteSuggestion("f1", "s1"); err != nil {
		t.Fatalf("DeleteSuggestion: %v", err)
	}
	if _, err := s.GetSuggestion("f1", "s1"); err == nil {
		t.Error("GetSuggestion after delete: expected error")
	}
	if err := s.DeleteSuggestion("f1", "s1"); err == nil {
		t.Error("DeleteSuggestion(twice): expected not-found")
	}

	// Traversal guard on the suggestion path builder.
	if err := s.CreateSuggestion(&models.Suggestion{ID: "../../evil", FileID: "f1"}); err == nil {
		t.Error("CreateSuggestion with traversal id: expected error")
	}
	if err := s.DeleteSuggestion("../../evil", "s"); err == nil {
		t.Error("DeleteSuggestion with traversal id: expected error")
	}
}
