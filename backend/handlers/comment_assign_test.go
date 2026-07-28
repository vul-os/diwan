package handlers

import (
	"encoding/json"
	"net/http"
	"testing"

	"diwan/backend/fileacl"
	"diwan/backend/middleware"
	"diwan/backend/models"
	"diwan/backend/notify"

	"github.com/gin-gonic/gin"
)

// assignRouter wires create + update (assignment) with a verified identity.
func assignRouter(ch *CommentHandler, user string) *gin.Engine {
	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Set(middleware.CtxAuthenticated, true)
		c.Set(middleware.CtxUserID, user)
		c.Next()
	})
	r.POST("/files/:id/comments", ch.Create)
	r.PUT("/files/:id/comments/:cid", ch.Update)
	return r
}

// setupAssign: alice owns file1, shared with bob (editor). carol is a stranger.
func setupAssign(t *testing.T) (*CommentHandler, notify.Store, string) {
	t.Helper()
	st := newMemCommentStorage()
	acl := fileacl.NewNullStore()
	authz := NewFileAuthzWithAuth(acl, true)
	nf := notify.NewNullStore()
	ch := NewCommentHandlerWith(st, authz, nf)
	fileID := "file1"
	st.files[fileID] = &models.File{ID: fileID, Name: "Plan", Type: models.FileTypeDoc, Rev: 1}
	_ = acl.SetOwner(fileID, "alice")
	_ = acl.ShareWithRole(fileID, "bob", fileacl.RoleEditor)
	return ch, nf, fileID
}

func createComment(t *testing.T, r *gin.Engine, fileID string, body models.CreateCommentRequest) models.Comment {
	t.Helper()
	w := doReq(r, http.MethodPost, "/files/"+fileID+"/comments", body)
	if w.Code != http.StatusCreated {
		t.Fatalf("create comment: expected 201, got %d (%s)", w.Code, w.Body.String())
	}
	var cm models.Comment
	_ = json.Unmarshal(w.Body.Bytes(), &cm)
	return cm
}

// TestAssignNotifiesCollaborator: assigning a comment to bob (a collaborator)
// records the assignee AND notifies bob with a NotifyAssign notification.
func TestAssignNotifiesCollaborator(t *testing.T) {
	ch, nf, fileID := setupAssign(t)
	alice := assignRouter(ch, "alice")

	cm := createComment(t, alice, fileID, models.CreateCommentRequest{
		Anchor:   models.CommentAnchor{Type: models.AnchorTextRange, From: 0, To: 1},
		Body:     "please review",
		Assignee: "bob",
	})
	if cm.Assignee != "bob" {
		t.Fatalf("expected assignee bob, got %q", cm.Assignee)
	}
	bobN, _ := nf.ListForAccount("bob")
	if len(bobN) != 1 || bobN[0].Kind != models.NotifyAssign || bobN[0].Actor != "alice" || bobN[0].FileID != fileID {
		t.Fatalf("bob should have 1 assign notification from alice, got %+v", bobN)
	}
}

// TestAssignNonCollaboratorDropped: assigning to carol (no access) records NO
// assignee and produces NO notification — the same authz boundary as mentions.
func TestAssignNonCollaboratorDropped(t *testing.T) {
	ch, nf, fileID := setupAssign(t)
	alice := assignRouter(ch, "alice")

	cm := createComment(t, alice, fileID, models.CreateCommentRequest{
		Anchor:   models.CommentAnchor{Type: models.AnchorTextRange, From: 0, To: 1},
		Body:     "secret task",
		Assignee: "carol",
	})
	if cm.Assignee != "" {
		t.Fatalf("carol is not a collaborator; assignee must be dropped, got %q", cm.Assignee)
	}
	carolN, _ := nf.ListForAccount("carol")
	if len(carolN) != 0 {
		t.Fatalf("carol must not be notified, got %d", len(carolN))
	}
}

// TestReassignViaUpdateNotifies: assigning via PUT (update) validates + notifies,
// and a self-assignment is not notified.
func TestReassignViaUpdateNotifies(t *testing.T) {
	ch, nf, fileID := setupAssign(t)
	alice := assignRouter(ch, "alice")

	cm := createComment(t, alice, fileID, models.CreateCommentRequest{
		Anchor: models.CommentAnchor{Type: models.AnchorTextRange, From: 0, To: 1},
		Body:   "task",
	})
	bob := "bob"
	w := doReq(alice, http.MethodPut, "/files/"+fileID+"/comments/"+cm.ID, models.UpdateCommentRequest{Assignee: &bob})
	if w.Code != http.StatusOK {
		t.Fatalf("assign via update: expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	var updated models.Comment
	_ = json.Unmarshal(w.Body.Bytes(), &updated)
	if updated.Assignee != "bob" {
		t.Fatalf("expected assignee bob after update, got %q", updated.Assignee)
	}
	bobN, _ := nf.ListForAccount("bob")
	if len(bobN) != 1 || bobN[0].Kind != models.NotifyAssign {
		t.Fatalf("bob should have 1 assign notification, got %+v", bobN)
	}

	// Self-assignment (alice → alice) must not notify alice.
	me := "alice"
	_ = doReq(alice, http.MethodPut, "/files/"+fileID+"/comments/"+cm.ID, models.UpdateCommentRequest{Assignee: &me})
	aliceN, _ := nf.ListForAccount("alice")
	if len(aliceN) != 0 {
		t.Fatalf("self-assignment should not notify, got %d", len(aliceN))
	}
}

// TestResolveClearsAssignment: resolving the thread clears the assignee.
func TestResolveClearsAssignment(t *testing.T) {
	ch, _, fileID := setupAssign(t)
	alice := assignRouter(ch, "alice")

	cm := createComment(t, alice, fileID, models.CreateCommentRequest{
		Anchor:   models.CommentAnchor{Type: models.AnchorTextRange, From: 0, To: 1},
		Body:     "task",
		Assignee: "bob",
	})
	resolved := models.CommentResolved
	w := doReq(alice, http.MethodPut, "/files/"+fileID+"/comments/"+cm.ID, models.UpdateCommentRequest{State: resolved})
	if w.Code != http.StatusOK {
		t.Fatalf("resolve: expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	var updated models.Comment
	_ = json.Unmarshal(w.Body.Bytes(), &updated)
	if updated.State != models.CommentResolved {
		t.Fatalf("expected resolved state, got %q", updated.State)
	}
	if updated.Assignee != "" {
		t.Fatalf("resolving must clear the assignee, got %q", updated.Assignee)
	}
}

// TestViewerCannotAssign: a plain VIEWER may not create/assign a comment (the
// requireCommenter gate), so assignment cannot be used by a read-only account.
func TestViewerCannotAssign(t *testing.T) {
	st := newMemCommentStorage()
	acl := fileacl.NewNullStore()
	authz := NewFileAuthzWithAuth(acl, true)
	nf := notify.NewNullStore()
	ch := NewCommentHandlerWith(st, authz, nf)
	fileID := "file1"
	st.files[fileID] = &models.File{ID: fileID, Name: "Plan", Type: models.FileTypeDoc, Rev: 1}
	_ = acl.SetOwner(fileID, "alice")
	_ = acl.ShareWithRole(fileID, "dave", fileacl.RoleViewer)

	dave := assignRouter(ch, "dave")
	w := doReq(dave, http.MethodPost, "/files/"+fileID+"/comments", models.CreateCommentRequest{
		Anchor:   models.CommentAnchor{Type: models.AnchorTextRange, From: 0, To: 1},
		Body:     "sneaky",
		Assignee: "bob",
	})
	if w.Code != http.StatusForbidden {
		t.Fatalf("viewer creating/assigning a comment: expected 403, got %d (%s)", w.Code, w.Body.String())
	}
}
