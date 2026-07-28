package handlers

// comments_suggestions_acl_test.go — HIGH regression guard: a viewer-shared
// user must NOT be able to create/update/delete comments or suggestions.
// fileacl.RoleViewer is read-only and fileacl.RoleCommenter is the minimum
// role that may comment/suggest, but until FileAuthz.requireCommenter existed
// every comment/suggestion mutation only checked h.authz.require() (plain read
// access), which any viewer satisfies — an ACL bypass. This file exercises the
// HTTP-level fix end to end for both comments.go and suggestions.go.

import (
	"net/http"
	"testing"

	"diwan/backend/fileacl"
	"diwan/backend/middleware"
	"diwan/backend/models"

	"github.com/gin-gonic/gin"
)

// memSuggestionStorage augments memStorage with suggestion persistence (the
// base mock panics on suggestion methods).
type memSuggestionStorage struct {
	*memStorage
	suggestions map[string]*models.Suggestion
}

func newMemSuggestionStorage() *memSuggestionStorage {
	return &memSuggestionStorage{
		memStorage:  newMemStorage(),
		suggestions: make(map[string]*models.Suggestion),
	}
}

func (m *memSuggestionStorage) CreateSuggestion(s *models.Suggestion) error {
	m.suggestions[s.ID] = s
	return nil
}
func (m *memSuggestionStorage) GetSuggestion(fileID, id string) (*models.Suggestion, error) {
	if s, ok := m.suggestions[id]; ok && s.FileID == fileID {
		return s, nil
	}
	return nil, errFile("suggestion not found")
}
func (m *memSuggestionStorage) ListSuggestions(fileID string) ([]*models.Suggestion, error) {
	var out []*models.Suggestion
	for _, s := range m.suggestions {
		if s.FileID == fileID {
			out = append(out, s)
		}
	}
	return out, nil
}
func (m *memSuggestionStorage) UpdateSuggestion(s *models.Suggestion) error {
	m.suggestions[s.ID] = s
	return nil
}
func (m *memSuggestionStorage) DeleteSuggestion(fileID, id string) error {
	if _, ok := m.suggestions[id]; !ok {
		return errFile("suggestion not found")
	}
	delete(m.suggestions, id)
	return nil
}

// aclRouter injects a verified identity and wires only the routes the ACL
// bypass tests need.
func aclCommentRouter(ch *CommentHandler, user string) *gin.Engine {
	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Set(middleware.CtxAuthenticated, true)
		c.Set(middleware.CtxUserID, user)
		c.Next()
	})
	r.GET("/files/:id/comments", ch.List)
	r.POST("/files/:id/comments", ch.Create)
	r.PUT("/files/:id/comments/:cid", ch.Update)
	r.DELETE("/files/:id/comments/:cid", ch.Delete)
	r.POST("/files/:id/comments/:cid/replies", ch.CreateReply)
	r.PUT("/files/:id/comments/:cid/replies/:rid", ch.UpdateReply)
	r.DELETE("/files/:id/comments/:cid/replies/:rid", ch.DeleteReply)
	return r
}

func aclSuggestionRouter(sh *SuggestionHandler, user string) *gin.Engine {
	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Set(middleware.CtxAuthenticated, true)
		c.Set(middleware.CtxUserID, user)
		c.Next()
	})
	r.GET("/files/:id/suggestions", sh.List)
	r.POST("/files/:id/suggestions", sh.Create)
	r.PUT("/files/:id/suggestions/:sid", sh.Update)
	r.DELETE("/files/:id/suggestions/:sid", sh.Delete)
	return r
}

// setupCommentACL builds a file owned by alice, shared with vic (viewer), com
// (commenter), and ed (editor).
func setupCommentACL(t *testing.T) (*CommentHandler, *memCommentStorage, fileacl.Store, string) {
	t.Helper()
	st := newMemCommentStorage()
	acl := fileacl.NewNullStore()
	authz := NewFileAuthzWithAuth(acl, true)
	ch := NewCommentHandlerWith(st, authz, nil)

	fileID := "doc1"
	st.files[fileID] = &models.File{ID: fileID, Name: "Doc", Type: models.FileTypeDoc, Rev: 1}
	_ = acl.SetOwner(fileID, "alice")
	_ = acl.ShareWithRole(fileID, "vic", fileacl.RoleViewer)
	_ = acl.ShareWithRole(fileID, "com", fileacl.RoleCommenter)
	_ = acl.ShareWithRole(fileID, "ed", fileacl.RoleEditor)
	return ch, st, acl, fileID
}

func setupSuggestionACL(t *testing.T) (*SuggestionHandler, *memSuggestionStorage, fileacl.Store, string) {
	t.Helper()
	st := newMemSuggestionStorage()
	acl := fileacl.NewNullStore()
	authz := NewFileAuthzWithAuth(acl, true)
	sh := NewSuggestionHandlerWith(st, authz)

	fileID := "doc1"
	st.files[fileID] = &models.File{ID: fileID, Name: "Doc", Type: models.FileTypeDoc, Rev: 1}
	_ = acl.SetOwner(fileID, "alice")
	_ = acl.ShareWithRole(fileID, "vic", fileacl.RoleViewer)
	_ = acl.ShareWithRole(fileID, "com", fileacl.RoleCommenter)
	_ = acl.ShareWithRole(fileID, "ed", fileacl.RoleEditor)
	return sh, st, acl, fileID
}

// --- Comments ---------------------------------------------------------------

func TestComments_ViewerCannotCreate(t *testing.T) {
	ch, _, _, fileID := setupCommentACL(t)
	vic := aclCommentRouter(ch, "vic")

	w := doReq(vic, http.MethodPost, "/files/"+fileID+"/comments", models.CreateCommentRequest{
		Anchor: models.CommentAnchor{Type: models.AnchorTextRange, From: 0, To: 1},
		Body:   "should be denied",
	})
	if w.Code != http.StatusForbidden {
		t.Fatalf("VULN: viewer created a comment — got %d, want 403 (%s)", w.Code, w.Body.String())
	}
}

func TestComments_CommenterEditorOwnerCanCreate(t *testing.T) {
	for _, user := range []string{"com", "ed", "alice"} {
		ch, _, _, fileID := setupCommentACL(t)
		router := aclCommentRouter(ch, user)
		w := doReq(router, http.MethodPost, "/files/"+fileID+"/comments", models.CreateCommentRequest{
			Anchor: models.CommentAnchor{Type: models.AnchorTextRange, From: 0, To: 1},
			Body:   "ok",
		})
		if w.Code != http.StatusCreated {
			t.Fatalf("%s should be able to create a comment, got %d (%s)", user, w.Code, w.Body.String())
		}
	}
}

func TestComments_ViewerCannotUpdateOrDelete(t *testing.T) {
	ch, st, _, fileID := setupCommentACL(t)
	// Seed a comment authored by alice (so an authorship denial can't mask the
	// role denial we're testing).
	cm := &models.Comment{ID: "c1", FileID: fileID, AuthorID: "alice", Body: "hi", State: models.CommentOpen}
	st.comments[cm.ID] = cm

	vic := aclCommentRouter(ch, "vic")
	w := doReq(vic, http.MethodPut, "/files/"+fileID+"/comments/"+cm.ID, models.UpdateCommentRequest{State: models.CommentResolved})
	if w.Code != http.StatusForbidden {
		t.Fatalf("VULN: viewer updated (resolved) a comment — got %d, want 403 (%s)", w.Code, w.Body.String())
	}

	w = doReq(vic, http.MethodDelete, "/files/"+fileID+"/comments/"+cm.ID, nil)
	if w.Code != http.StatusForbidden {
		t.Fatalf("VULN: viewer deleted a comment — got %d, want 403 (%s)", w.Code, w.Body.String())
	}
}

func TestComments_ViewerCannotReply(t *testing.T) {
	ch, st, _, fileID := setupCommentACL(t)
	cm := &models.Comment{ID: "c1", FileID: fileID, AuthorID: "alice", Body: "hi", State: models.CommentOpen}
	st.comments[cm.ID] = cm

	vic := aclCommentRouter(ch, "vic")
	w := doReq(vic, http.MethodPost, "/files/"+fileID+"/comments/"+cm.ID+"/replies", models.CreateReplyRequest{Body: "denied"})
	if w.Code != http.StatusForbidden {
		t.Fatalf("VULN: viewer created a reply — got %d, want 403 (%s)", w.Code, w.Body.String())
	}

	// Seed a reply authored by alice so update/delete role-denial is isolated
	// from the (also-enforced) authorship check.
	r := &models.CommentReply{ID: "r1", CommentID: cm.ID, FileID: fileID, AuthorID: "alice", Body: "hi"}
	st.replies[r.ID] = r

	w = doReq(vic, http.MethodPut, "/files/"+fileID+"/comments/"+cm.ID+"/replies/"+r.ID, models.UpdateReplyRequest{Body: "denied"})
	if w.Code != http.StatusForbidden {
		t.Fatalf("VULN: viewer updated a reply — got %d, want 403 (%s)", w.Code, w.Body.String())
	}
	w = doReq(vic, http.MethodDelete, "/files/"+fileID+"/comments/"+cm.ID+"/replies/"+r.ID, nil)
	if w.Code != http.StatusForbidden {
		t.Fatalf("VULN: viewer deleted a reply — got %d, want 403 (%s)", w.Code, w.Body.String())
	}
}

func TestComments_ViewerCanStillList(t *testing.T) {
	// List remains read-only access (viewer-permitted) — only mutation is
	// gated behind requireCommenter.
	ch, _, _, fileID := setupCommentACL(t)
	vic := aclCommentRouter(ch, "vic")
	w := doReq(vic, http.MethodGet, "/files/"+fileID+"/comments", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("viewer should still be able to list comments, got %d", w.Code)
	}
}

// --- Suggestions -------------------------------------------------------------

func TestSuggestions_ViewerCannotCreate(t *testing.T) {
	sh, _, _, fileID := setupSuggestionACL(t)
	vic := aclSuggestionRouter(sh, "vic")

	w := doReq(vic, http.MethodPost, "/files/"+fileID+"/suggestions", models.CreateSuggestionRequest{
		Kind: models.SuggestionInsert, From: 0, To: 0, Text: "denied",
	})
	if w.Code != http.StatusForbidden {
		t.Fatalf("VULN: viewer created a suggestion — got %d, want 403 (%s)", w.Code, w.Body.String())
	}
}

func TestSuggestions_CommenterEditorOwnerCanCreate(t *testing.T) {
	for _, user := range []string{"com", "ed", "alice"} {
		sh, _, _, fileID := setupSuggestionACL(t)
		router := aclSuggestionRouter(sh, user)
		w := doReq(router, http.MethodPost, "/files/"+fileID+"/suggestions", models.CreateSuggestionRequest{
			Kind: models.SuggestionInsert, From: 0, To: 0, Text: "ok",
		})
		if w.Code != http.StatusCreated {
			t.Fatalf("%s should be able to create a suggestion, got %d (%s)", user, w.Code, w.Body.String())
		}
	}
}

func TestSuggestions_ViewerCannotUpdateOrDelete(t *testing.T) {
	sh, st, _, fileID := setupSuggestionACL(t)
	sg := &models.Suggestion{ID: "s1", FileID: fileID, AuthorID: "alice", Kind: models.SuggestionInsert, State: models.SuggestionPending}
	st.suggestions[sg.ID] = sg

	vic := aclSuggestionRouter(sh, "vic")
	w := doReq(vic, http.MethodPut, "/files/"+fileID+"/suggestions/"+sg.ID, models.UpdateSuggestionRequest{State: models.SuggestionAccepted})
	if w.Code != http.StatusForbidden {
		t.Fatalf("VULN: viewer accepted a suggestion — got %d, want 403 (%s)", w.Code, w.Body.String())
	}
	w = doReq(vic, http.MethodDelete, "/files/"+fileID+"/suggestions/"+sg.ID, nil)
	if w.Code != http.StatusForbidden {
		t.Fatalf("VULN: viewer deleted a suggestion — got %d, want 403 (%s)", w.Code, w.Body.String())
	}
}

func TestSuggestions_CommenterCanUpdateAndDelete(t *testing.T) {
	sh, st, _, fileID := setupSuggestionACL(t)
	sg := &models.Suggestion{ID: "s1", FileID: fileID, AuthorID: "alice", Kind: models.SuggestionInsert, State: models.SuggestionPending}
	st.suggestions[sg.ID] = sg

	com := aclSuggestionRouter(sh, "com")
	w := doReq(com, http.MethodPut, "/files/"+fileID+"/suggestions/"+sg.ID, models.UpdateSuggestionRequest{State: models.SuggestionAccepted})
	if w.Code != http.StatusOK {
		t.Fatalf("commenter should be able to accept a suggestion, got %d (%s)", w.Code, w.Body.String())
	}
	w = doReq(com, http.MethodDelete, "/files/"+fileID+"/suggestions/"+sg.ID, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("commenter should be able to delete a suggestion, got %d (%s)", w.Code, w.Body.String())
	}
}

func TestSuggestions_ViewerCanStillList(t *testing.T) {
	sh, _, _, fileID := setupSuggestionACL(t)
	vic := aclSuggestionRouter(sh, "vic")
	w := doReq(vic, http.MethodGet, "/files/"+fileID+"/suggestions", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("viewer should still be able to list suggestions, got %d", w.Code)
	}
}
