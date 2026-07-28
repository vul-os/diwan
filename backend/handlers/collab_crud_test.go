package handlers

// collab_crud_test.go — handler-level tests for the collaborative-edit surface:
// doc / sheet / slide CRUD paths, comment and suggestion lifecycles, and session-
// gating behaviour (unauthenticated context falls back to the "self" identity
// rather than crashing or elevating to an arbitrary account).
//
// All tests are hermetic (in-memory storage, null ACL store, no filesystem I/O).
//
// Coverage added here:
//   • Doc CRUD — create / get / update / delete with authz gating
//   • Sheets authz — non-owner is denied export (404, non-enumerable)
//   • Slides authz — non-owner is denied export (404, non-enumerable)
//   • Comment lifecycle — owner can list / create / update / delete comments and replies
//   • Comment authz — non-owner is denied every comment operation (404)
//   • Suggestion lifecycle — owner can list / create / accept / delete suggestions
//   • Suggestion authz — non-owner is denied every suggestion operation (404)
//   • Reviewer binding — reviewer_id on suggestion.Update is always the verified
//     context identity, never the caller-supplied body field

import (
	"net/http"
	"sync"
	"testing"

	"diwan/backend/billing"
	"diwan/backend/fileacl"
	"diwan/backend/middleware"
	"diwan/backend/models"
	"diwan/backend/seam"

	"github.com/gin-gonic/gin"
)

func init() {
	gin.SetMode(gin.TestMode)
	// Ensure billing is always the unlimited standalone provider so GateOffice
	// and GateStorage are no-ops throughout these tests.
	billing.Configure(seam.NewStandaloneProvider(func() ([]byte, error) { return nil, nil }, false))
}

// ── collabStorage ─────────────────────────────────────────────────────────────
// Extends pentestStorage (which already covers files + comments + versions) with
// in-memory suggestion support so the suggestion handler tests don't hit the
// embedded memStorage panic stubs.

type collabStorage struct {
	*pentestStorage
	sgMu        sync.Mutex
	suggestions map[string][]*models.Suggestion // fileID → []Suggestion
}

func newCollabStorage() *collabStorage {
	return &collabStorage{
		pentestStorage: newPentestStorage(),
		suggestions:    make(map[string][]*models.Suggestion),
	}
}

func (s *collabStorage) CreateSuggestion(sg *models.Suggestion) error {
	s.sgMu.Lock()
	defer s.sgMu.Unlock()
	s.suggestions[sg.FileID] = append(s.suggestions[sg.FileID], sg)
	return nil
}

func (s *collabStorage) GetSuggestion(fileID, sgID string) (*models.Suggestion, error) {
	s.sgMu.Lock()
	defer s.sgMu.Unlock()
	for _, sg := range s.suggestions[fileID] {
		if sg.ID == sgID {
			return sg, nil
		}
	}
	return nil, errFileNotFound
}

func (s *collabStorage) ListSuggestions(fileID string) ([]*models.Suggestion, error) {
	s.sgMu.Lock()
	defer s.sgMu.Unlock()
	if s.suggestions[fileID] == nil {
		return []*models.Suggestion{}, nil
	}
	return s.suggestions[fileID], nil
}

func (s *collabStorage) UpdateSuggestion(sg *models.Suggestion) error {
	s.sgMu.Lock()
	defer s.sgMu.Unlock()
	for i, existing := range s.suggestions[sg.FileID] {
		if existing.ID == sg.ID {
			s.suggestions[sg.FileID][i] = sg
			return nil
		}
	}
	return errFileNotFound
}

func (s *collabStorage) DeleteSuggestion(fileID, sgID string) error {
	s.sgMu.Lock()
	defer s.sgMu.Unlock()
	list := s.suggestions[fileID]
	out := list[:0]
	found := false
	for _, sg := range list {
		if sg.ID != sgID {
			out = append(out, sg)
		} else {
			found = true
		}
	}
	s.suggestions[fileID] = out
	if !found {
		return errFileNotFound
	}
	return nil
}

func (s *collabStorage) CreateShareLink(*models.ShareLink) error { return nil }
func (s *collabStorage) GetShareLinkByToken(string) (*models.ShareLink, error) {
	return nil, errFileNotFound
}
func (s *collabStorage) ListShareLinks(string) ([]*models.ShareLink, error) { return nil, nil }
func (s *collabStorage) RevokeShareLink(string, string) error               { return errFileNotFound }

// ── collabStack ───────────────────────────────────────────────────────────────
// All handlers share the same storage + authz instance, mirroring production.

type collabStack struct {
	store       *collabStorage
	authz       *FileAuthz
	files       *FileHandler
	comments    *CommentHandler
	suggestions *SuggestionHandler
	sheets      *SheetsHandler
	slides      *SlidesExportHandler
}

func newCollabStack() *collabStack {
	st := newCollabStorage()
	acl := fileacl.NewNullStore()
	az := NewFileAuthz(acl)
	return &collabStack{
		store:       st,
		authz:       az,
		files:       NewFileHandlerWithAuthz(st, az),
		comments:    &CommentHandler{store: st, authz: az},
		suggestions: &SuggestionHandler{store: st, authz: az},
		sheets:      &SheetsHandler{store: st, authz: az},
		slides:      &SlidesExportHandler{store: st, authz: az},
	}
}

func (s *collabStack) router(user string, admin bool) *gin.Engine {
	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Set(middleware.CtxAuthenticated, true)
		c.Set(middleware.CtxUserID, user)
		if admin {
			c.Set(middleware.CtxIsAdmin, true)
		}
		c.Next()
	})
	// File CRUD
	r.GET("/files", s.files.List)
	r.GET("/files/:id", s.files.Get)
	r.POST("/files", s.files.Create)
	r.PUT("/files/:id", s.files.Update)
	r.DELETE("/files/:id", s.files.Delete)
	r.POST("/files/:id/share", s.files.Share)
	// Comments
	r.GET("/files/:id/comments", s.comments.List)
	r.POST("/files/:id/comments", s.comments.Create)
	r.PUT("/files/:id/comments/:cid", s.comments.Update)
	r.DELETE("/files/:id/comments/:cid", s.comments.Delete)
	r.POST("/files/:id/comments/:cid/replies", s.comments.CreateReply)
	r.PUT("/files/:id/comments/:cid/replies/:rid", s.comments.UpdateReply)
	r.DELETE("/files/:id/comments/:cid/replies/:rid", s.comments.DeleteReply)
	// Suggestions
	r.GET("/files/:id/suggestions", s.suggestions.List)
	r.POST("/files/:id/suggestions", s.suggestions.Create)
	r.PUT("/files/:id/suggestions/:sid", s.suggestions.Update)
	r.DELETE("/files/:id/suggestions/:sid", s.suggestions.Delete)
	// Sheets + slides export
	r.GET("/sheets/:id/export", s.sheets.Export)
	r.GET("/slides/:id/export", s.slides.Export)
	return r
}

// ─────────────────────────────────────────────────────────────────────────────
// Doc CRUD tests
// ─────────────────────────────────────────────────────────────────────────────

// TestDocCRUD_BasicLifecycle proves the full create → get → update → delete path.
func TestDocCRUD_BasicLifecycle(t *testing.T) {
	s := newCollabStack()
	r := s.router("alice", false)

	// Create
	w := doReq(r, http.MethodPost, "/files",
		models.CreateFileRequest{Name: "My Doc", Type: models.FileTypeDoc, Content: "hello"})
	if w.Code != http.StatusCreated {
		t.Fatalf("create: expected 201, got %d (%s)", w.Code, w.Body.String())
	}
	var f models.File
	mustDecode(t, w, &f)
	if f.ID == "" {
		t.Fatal("create: no ID in response")
	}
	if f.Name != "My Doc" {
		t.Fatalf("create: expected name='My Doc', got %q", f.Name)
	}

	// Get
	w = doReq(r, http.MethodGet, "/files/"+f.ID, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("get: expected 200, got %d", w.Code)
	}

	// Update
	w = doReq(r, http.MethodPut, "/files/"+f.ID,
		models.UpdateFileRequest{Name: "Renamed Doc", Content: "updated"})
	if w.Code != http.StatusOK {
		t.Fatalf("update: expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	var updated models.File
	mustDecode(t, w, &updated)
	if updated.Name != "Renamed Doc" {
		t.Fatalf("update: expected name='Renamed Doc', got %q", updated.Name)
	}

	// Delete
	w = doReq(r, http.MethodDelete, "/files/"+f.ID, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("delete: expected 200, got %d (%s)", w.Code, w.Body.String())
	}

	// Confirm gone
	w = doReq(r, http.MethodGet, "/files/"+f.ID, nil)
	if w.Code != http.StatusNotFound {
		t.Fatalf("get after delete: expected 404, got %d", w.Code)
	}
}

// TestDocCRUD_NonOwnerDenied proves that a non-owner cannot read, update, or
// delete another user's document, and the response is 404 (non-enumerable).
func TestDocCRUD_NonOwnerDenied(t *testing.T) {
	s := newCollabStack()
	alice := s.router("alice", false)
	bob := s.router("bob", false)

	id := mustCreateFile(t, alice)

	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/files/" + id},
		{http.MethodPut, "/files/" + id},
		{http.MethodDelete, "/files/" + id},
	} {
		w := doReq(bob, tc.method, tc.path, nil)
		if w.Code != http.StatusNotFound {
			t.Fatalf("VULN: %s %s by non-owner returned %d (expected 404)", tc.method, tc.path, w.Code)
		}
	}
}

// TestDocCRUD_SessionGating_UnauthenticatedFallback verifies that when no
// verified identity is in the context (auth disabled / local mode), the file is
// created and owned by the local "self" identity rather than panicking or
// attributing ownership to a forged header.
func TestDocCRUD_SessionGating_UnauthenticatedFallback(t *testing.T) {
	s := newCollabStack()
	// Router with NO identity in context — simulates auth-disabled single-user mode.
	r := gin.New()
	r.POST("/files", s.files.Create)
	r.GET("/files/:id", s.files.Get)

	w := doReq(r, http.MethodPost, "/files",
		models.CreateFileRequest{Name: "local doc", Type: models.FileTypeDoc, Content: nil})
	if w.Code != http.StatusCreated {
		t.Fatalf("create without auth context: expected 201, got %d (%s)", w.Code, w.Body.String())
	}
	var f models.File
	mustDecode(t, w, &f)

	// The owner should be the "self" fallback, not an empty string that would
	// make the file globally readable to any authenticated user.
	rec, ok, err := s.authz.Store().Get(f.ID)
	if err != nil || !ok {
		t.Fatalf("expected an ACL owner record, got ok=%v err=%v", ok, err)
	}
	if rec.Owner == "" {
		t.Fatal("owner is empty; file would be globally readable in multi-tenant mode")
	}
}

// TestDocCRUD_SheetAndSlide_CreateAndGet verifies that sheet and slide file
// types round-trip correctly through the same file handler.
func TestDocCRUD_SheetAndSlide_CreateAndGet(t *testing.T) {
	s := newCollabStack()
	r := s.router("alice", false)

	for _, ft := range []models.FileType{models.FileTypeSheet, models.FileTypeSlide} {
		w := doReq(r, http.MethodPost, "/files",
			models.CreateFileRequest{Name: "test", Type: ft, Content: map[string]any{"cells": []any{}}})
		if w.Code != http.StatusCreated {
			t.Fatalf("create %s: expected 201, got %d (%s)", ft, w.Code, w.Body.String())
		}
		var f models.File
		mustDecode(t, w, &f)
		if f.Type != ft {
			t.Fatalf("create %s: type mismatch got %q", ft, f.Type)
		}

		w = doReq(r, http.MethodGet, "/files/"+f.ID, nil)
		if w.Code != http.StatusOK {
			t.Fatalf("get %s: expected 200, got %d", ft, w.Code)
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Sheets / Slides authz tests
// ─────────────────────────────────────────────────────────────────────────────

// TestSheetAuthz_NonOwnerExportDenied proves the sheet export endpoint enforces
// file-level ACLs — a non-owner gets 404 (non-enumerable).
func TestSheetAuthz_NonOwnerExportDenied(t *testing.T) {
	s := newCollabStack()
	alice := s.router("alice", false)
	bob := s.router("bob", false)

	// Create a sheet as alice.
	id := mustCreateFile(t, alice)

	// Bob tries to export alice's sheet.
	w := doReq(bob, http.MethodGet, "/sheets/"+id+"/export", nil)
	if w.Code != http.StatusNotFound {
		t.Fatalf("VULN: non-owner sheet export returned %d (expected 404)", w.Code)
	}
}

// TestSlideAuthz_NonOwnerExportDenied proves the slides export endpoint
// enforces file-level ACLs.
func TestSlideAuthz_NonOwnerExportDenied(t *testing.T) {
	s := newCollabStack()
	alice := s.router("alice", false)
	bob := s.router("bob", false)

	id := mustCreateFile(t, alice)

	w := doReq(bob, http.MethodGet, "/slides/"+id+"/export?format=pdf", nil)
	if w.Code != http.StatusNotFound {
		t.Fatalf("VULN: non-owner slide export returned %d (expected 404)", w.Code)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Comment CRUD tests
// ─────────────────────────────────────────────────────────────────────────────

// TestCommentCRUD_OwnerLifecycle proves the full create / list / update /
// delete comment lifecycle, including threaded replies.
func TestCommentCRUD_OwnerLifecycle(t *testing.T) {
	s := newCollabStack()
	r := s.router("alice", false)

	fileID := mustCreateFile(t, r)

	// List — initially empty.
	w := doReq(r, http.MethodGet, "/files/"+fileID+"/comments", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("list empty: expected 200, got %d", w.Code)
	}

	// Create comment.
	w = doReq(r, http.MethodPost, "/files/"+fileID+"/comments",
		models.CreateCommentRequest{
			Anchor: models.CommentAnchor{Type: models.AnchorTextRange, From: 0, To: 5},
			Body:   "first comment",
		})
	if w.Code != http.StatusCreated {
		t.Fatalf("create: expected 201, got %d (%s)", w.Code, w.Body.String())
	}
	var cm models.Comment
	mustDecode(t, w, &cm)
	if cm.ID == "" || cm.Body != "first comment" {
		t.Fatalf("create: unexpected comment %+v", cm)
	}

	// List — one comment.
	w = doReq(r, http.MethodGet, "/files/"+fileID+"/comments", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("list after create: expected 200, got %d", w.Code)
	}

	// Update (resolve).
	w = doReq(r, http.MethodPut, "/files/"+fileID+"/comments/"+cm.ID,
		models.UpdateCommentRequest{State: models.CommentResolved})
	if w.Code != http.StatusOK {
		t.Fatalf("update: expected 200, got %d (%s)", w.Code, w.Body.String())
	}

	// Add a reply.
	w = doReq(r, http.MethodPost, "/files/"+fileID+"/comments/"+cm.ID+"/replies",
		models.CreateReplyRequest{Body: "agree"})
	if w.Code != http.StatusCreated {
		t.Fatalf("create reply: expected 201, got %d (%s)", w.Code, w.Body.String())
	}
	var reply models.CommentReply
	mustDecode(t, w, &reply)
	if reply.ID == "" {
		t.Fatal("create reply: no ID in response")
	}

	// Edit the reply.
	w = doReq(r, http.MethodPut, "/files/"+fileID+"/comments/"+cm.ID+"/replies/"+reply.ID,
		models.UpdateReplyRequest{Body: "updated reply"})
	if w.Code != http.StatusOK {
		t.Fatalf("update reply: expected 200, got %d (%s)", w.Code, w.Body.String())
	}

	// Tombstone the reply.
	w = doReq(r, http.MethodDelete, "/files/"+fileID+"/comments/"+cm.ID+"/replies/"+reply.ID, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("delete reply: expected 200, got %d (%s)", w.Code, w.Body.String())
	}

	// Delete comment.
	w = doReq(r, http.MethodDelete, "/files/"+fileID+"/comments/"+cm.ID, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("delete: expected 200, got %d (%s)", w.Code, w.Body.String())
	}
}

// TestCommentCRUD_NonOwnerDenied404 proves every comment operation returns 404
// for a user who does not own (or have share access to) the file.
func TestCommentCRUD_NonOwnerDenied404(t *testing.T) {
	s := newCollabStack()
	alice := s.router("alice", false)
	bob := s.router("bob", false)

	fileID := mustCreateFile(t, alice)

	// First, alice creates a comment so bob can try to act on a real ID.
	w := doReq(alice, http.MethodPost, "/files/"+fileID+"/comments",
		models.CreateCommentRequest{
			Anchor: models.CommentAnchor{Type: models.AnchorTextRange},
			Body:   "alice's comment",
		})
	if w.Code != http.StatusCreated {
		t.Fatalf("alice create comment: expected 201, got %d", w.Code)
	}
	var cm models.Comment
	mustDecode(t, w, &cm)

	cases := []struct {
		name, method, path string
		body               interface{}
	}{
		{"list", http.MethodGet, "/files/" + fileID + "/comments", nil},
		{"create", http.MethodPost, "/files/" + fileID + "/comments",
			models.CreateCommentRequest{
				Anchor: models.CommentAnchor{Type: models.AnchorTextRange},
				Body:   "pwned",
			}},
		{"update", http.MethodPut, "/files/" + fileID + "/comments/" + cm.ID,
			models.UpdateCommentRequest{Body: "hacked"}},
		{"delete", http.MethodDelete, "/files/" + fileID + "/comments/" + cm.ID, nil},
		{"reply", http.MethodPost, "/files/" + fileID + "/comments/" + cm.ID + "/replies",
			models.CreateReplyRequest{Body: "reply"}},
	}
	for _, tc := range cases {
		w := doReq(bob, tc.method, tc.path, tc.body)
		if w.Code != http.StatusNotFound {
			t.Fatalf("VULN: comment.%s by non-owner returned %d (expected 404)", tc.name, w.Code)
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Suggestion CRUD tests
// ─────────────────────────────────────────────────────────────────────────────

// TestSuggestionCRUD_OwnerLifecycle proves the full create / list / accept /
// delete suggestion lifecycle.
func TestSuggestionCRUD_OwnerLifecycle(t *testing.T) {
	s := newCollabStack()
	r := s.router("alice", false)

	fileID := mustCreateFile(t, r)

	// List — initially empty.
	w := doReq(r, http.MethodGet, "/files/"+fileID+"/suggestions", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("list empty: expected 200, got %d", w.Code)
	}

	// Create suggestion.
	w = doReq(r, http.MethodPost, "/files/"+fileID+"/suggestions",
		models.CreateSuggestionRequest{
			Kind: models.SuggestionInsert,
			From: 10,
			To:   10,
			Text: "proposed text",
		})
	if w.Code != http.StatusCreated {
		t.Fatalf("create: expected 201, got %d (%s)", w.Code, w.Body.String())
	}
	var sg models.Suggestion
	mustDecode(t, w, &sg)
	if sg.ID == "" {
		t.Fatal("create: no ID in response")
	}
	if sg.State != models.SuggestionPending {
		t.Fatalf("create: expected state=pending, got %q", sg.State)
	}

	// List — one suggestion.
	w = doReq(r, http.MethodGet, "/files/"+fileID+"/suggestions", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("list after create: expected 200, got %d", w.Code)
	}

	// Accept.
	w = doReq(r, http.MethodPut, "/files/"+fileID+"/suggestions/"+sg.ID,
		models.UpdateSuggestionRequest{State: models.SuggestionAccepted})
	if w.Code != http.StatusOK {
		t.Fatalf("accept: expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	var accepted models.Suggestion
	mustDecode(t, w, &accepted)
	if accepted.State != models.SuggestionAccepted {
		t.Fatalf("accept: expected state=accepted, got %q", accepted.State)
	}

	// Delete.
	w = doReq(r, http.MethodDelete, "/files/"+fileID+"/suggestions/"+sg.ID, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("delete: expected 200, got %d (%s)", w.Code, w.Body.String())
	}
}

// TestSuggestionCRUD_NonOwnerDenied404 proves every suggestion operation returns
// 404 for a non-owner (non-enumerable response).
func TestSuggestionCRUD_NonOwnerDenied404(t *testing.T) {
	s := newCollabStack()
	alice := s.router("alice", false)
	bob := s.router("bob", false)

	fileID := mustCreateFile(t, alice)

	// Alice creates a suggestion so bob can try known IDs.
	w := doReq(alice, http.MethodPost, "/files/"+fileID+"/suggestions",
		models.CreateSuggestionRequest{Kind: models.SuggestionDelete, From: 0, To: 3})
	if w.Code != http.StatusCreated {
		t.Fatalf("alice create suggestion: expected 201, got %d", w.Code)
	}
	var sg models.Suggestion
	mustDecode(t, w, &sg)

	cases := []struct {
		name, method, path string
		body               interface{}
	}{
		{"list", http.MethodGet, "/files/" + fileID + "/suggestions", nil},
		{"create", http.MethodPost, "/files/" + fileID + "/suggestions",
			models.CreateSuggestionRequest{Kind: models.SuggestionInsert, Text: "pwn"}},
		{"update", http.MethodPut, "/files/" + fileID + "/suggestions/" + sg.ID,
			models.UpdateSuggestionRequest{State: models.SuggestionAccepted}},
		{"delete", http.MethodDelete, "/files/" + fileID + "/suggestions/" + sg.ID, nil},
	}
	for _, tc := range cases {
		w := doReq(bob, tc.method, tc.path, tc.body)
		if w.Code != http.StatusNotFound {
			t.Fatalf("VULN: suggestion.%s by non-owner returned %d (expected 404)", tc.name, w.Code)
		}
	}
}

// TestSuggestion_ReviewerIDFromContextNotBody proves that when a reviewer
// accepts/rejects a suggestion, the stored reviewer_id is derived from the
// VERIFIED context identity — not from the caller-supplied body field. This
// closes the authorship-forgery vector on the suggestion path.
func TestSuggestion_ReviewerIDFromContextNotBody(t *testing.T) {
	s := newCollabStack()
	alice := s.router("alice", false)

	fileID := mustCreateFile(t, alice)

	// Create as alice.
	w := doReq(alice, http.MethodPost, "/files/"+fileID+"/suggestions",
		models.CreateSuggestionRequest{Kind: models.SuggestionInsert, From: 0, To: 0, Text: "hi"})
	if w.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", w.Code, w.Body.String())
	}
	var sg models.Suggestion
	mustDecode(t, w, &sg)

	// Accept: supply a forged reviewer_id in the body.
	w = doReq(alice, http.MethodPut, "/files/"+fileID+"/suggestions/"+sg.ID,
		models.UpdateSuggestionRequest{
			State:      models.SuggestionAccepted,
			ReviewerID: "forged-admin",
		})
	if w.Code != http.StatusOK {
		t.Fatalf("accept: %d %s", w.Code, w.Body.String())
	}
	var accepted models.Suggestion
	mustDecode(t, w, &accepted)

	if accepted.ReviewerID == "forged-admin" {
		t.Fatal("VULN: reviewer_id from request body was trusted; must always come from context")
	}
	if accepted.ReviewerID != "alice" {
		t.Fatalf("reviewer_id should be 'alice' (context user), got %q", accepted.ReviewerID)
	}
}
