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

// memCommentStorage augments memStorage with comment/reply persistence for the
// mention tests (the base mock panics on comment methods).
type memCommentStorage struct {
	*memStorage
	comments map[string]*models.Comment
	replies  map[string]*models.CommentReply
}

func newMemCommentStorage() *memCommentStorage {
	return &memCommentStorage{
		memStorage: newMemStorage(),
		comments:   make(map[string]*models.Comment),
		replies:    make(map[string]*models.CommentReply),
	}
}

func (m *memCommentStorage) CreateComment(c *models.Comment) error { m.comments[c.ID] = c; return nil }
func (m *memCommentStorage) GetComment(fileID, id string) (*models.Comment, error) {
	if c, ok := m.comments[id]; ok {
		return c, nil
	}
	return nil, errFile("comment not found")
}
func (m *memCommentStorage) ListComments(fileID string) ([]*models.Comment, error) {
	var out []*models.Comment
	for _, c := range m.comments {
		if c.FileID == fileID {
			out = append(out, c)
		}
	}
	return out, nil
}
func (m *memCommentStorage) UpdateComment(c *models.Comment) error { m.comments[c.ID] = c; return nil }
func (m *memCommentStorage) DeleteComment(fileID, id string) error {
	delete(m.comments, id)
	return nil
}
func (m *memCommentStorage) CreateReply(r *models.CommentReply) error {
	m.replies[r.ID] = r
	return nil
}
func (m *memCommentStorage) GetReply(commentID, id string) (*models.CommentReply, error) {
	if r, ok := m.replies[id]; ok {
		return r, nil
	}
	return nil, errFile("reply not found")
}
func (m *memCommentStorage) ListReplies(commentID string) ([]*models.CommentReply, error) {
	var out []*models.CommentReply
	for _, r := range m.replies {
		if r.CommentID == commentID {
			out = append(out, r)
		}
	}
	return out, nil
}
func (m *memCommentStorage) UpdateReply(r *models.CommentReply) error {
	m.replies[r.ID] = r
	return nil
}

func mentionRouter(ch *CommentHandler, nh *NotificationHandler, user string) *gin.Engine {
	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Set(middleware.CtxAuthenticated, true)
		c.Set(middleware.CtxUserID, user)
		c.Next()
	})
	r.POST("/files/:id/comments", ch.Create)
	r.POST("/files/:id/comments/:cid/replies", ch.CreateReply)
	r.GET("/notifications", nh.List)
	r.POST("/notifications/:id/read", nh.MarkRead)
	return r
}

// setup: alice owns a file shared with bob (editor). carol is a stranger.
func setupMentions(t *testing.T) (*CommentHandler, *NotificationHandler, notify.Store, string) {
	t.Helper()
	st := newMemCommentStorage()
	acl := fileacl.NewNullStore()
	authz := NewFileAuthzWithAuth(acl, true)
	nf := notify.NewNullStore()
	ch := NewCommentHandlerWith(st, authz, nf)
	nh := NewNotificationHandlerWith(nf)

	fileID := "file1"
	st.files[fileID] = &models.File{ID: fileID, Name: "Plan", Type: models.FileTypeDoc, Rev: 1}
	_ = acl.SetOwner(fileID, "alice")
	_ = acl.ShareWithRole(fileID, "bob", fileacl.RoleEditor)
	return ch, nh, nf, fileID
}

// TestMentionNotifiesCollaborator: mentioning bob (a collaborator) creates a
// notification addressed to bob.
func TestMentionNotifiesCollaborator(t *testing.T) {
	ch, nh, nf, fileID := setupMentions(t)
	alice := mentionRouter(ch, nh, "alice")

	body := models.CreateCommentRequest{
		Anchor:   models.CommentAnchor{Type: models.AnchorTextRange, From: 0, To: 1},
		Body:     "hey @bob look at this",
		Mentions: []string{"bob"},
	}
	w := doReq(alice, http.MethodPost, "/files/"+fileID+"/comments", body)
	if w.Code != http.StatusCreated {
		t.Fatalf("create comment: expected 201, got %d (%s)", w.Code, w.Body.String())
	}
	var cm models.Comment
	_ = json.Unmarshal(w.Body.Bytes(), &cm)
	if len(cm.Mentions) != 1 || cm.Mentions[0] != "bob" {
		t.Fatalf("comment should record mention of bob, got %+v", cm.Mentions)
	}

	bobNotifs, _ := nf.ListForAccount("bob")
	if len(bobNotifs) != 1 {
		t.Fatalf("bob should have 1 notification, got %d", len(bobNotifs))
	}
	if bobNotifs[0].Kind != models.NotifyMention || bobNotifs[0].Actor != "alice" || bobNotifs[0].FileID != fileID {
		t.Fatalf("unexpected notification: %+v", bobNotifs[0])
	}
}

// TestMentionNonCollaboratorDropped: mentioning carol (no access) records NO
// mention and produces NO notification — prevents cross-account probe/spam.
func TestMentionNonCollaboratorDropped(t *testing.T) {
	ch, nh, nf, fileID := setupMentions(t)
	alice := mentionRouter(ch, nh, "alice")

	body := models.CreateCommentRequest{
		Anchor:   models.CommentAnchor{Type: models.AnchorTextRange, From: 0, To: 1},
		Body:     "@carol secret",
		Mentions: []string{"carol"},
	}
	w := doReq(alice, http.MethodPost, "/files/"+fileID+"/comments", body)
	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d", w.Code)
	}
	var cm models.Comment
	_ = json.Unmarshal(w.Body.Bytes(), &cm)
	if len(cm.Mentions) != 0 {
		t.Fatalf("carol is not a collaborator; mention must be dropped, got %+v", cm.Mentions)
	}
	carolNotifs, _ := nf.ListForAccount("carol")
	if len(carolNotifs) != 0 {
		t.Fatalf("carol must not be notified, got %d", len(carolNotifs))
	}
}

// TestSelfMentionNotNotified: mentioning yourself creates no notification.
func TestSelfMentionNotNotified(t *testing.T) {
	ch, nh, nf, fileID := setupMentions(t)
	alice := mentionRouter(ch, nh, "alice")

	body := models.CreateCommentRequest{
		Anchor:   models.CommentAnchor{Type: models.AnchorTextRange, From: 0, To: 1},
		Body:     "note to self @alice",
		Mentions: []string{"alice"},
	}
	_ = doReq(alice, http.MethodPost, "/files/"+fileID+"/comments", body)
	aliceNotifs, _ := nf.ListForAccount("alice")
	if len(aliceNotifs) != 0 {
		t.Fatalf("self-mention should not notify, got %d", len(aliceNotifs))
	}
}

// TestNotificationsAreAccountScoped: bob cannot mark alice's notification read.
func TestNotificationsAreAccountScoped(t *testing.T) {
	ch, nh, nf, fileID := setupMentions(t)
	// alice mentions bob → bob gets a notification.
	alice := mentionRouter(ch, nh, "alice")
	_ = doReq(alice, http.MethodPost, "/files/"+fileID+"/comments", models.CreateCommentRequest{
		Anchor:   models.CommentAnchor{Type: models.AnchorTextRange, From: 0, To: 1},
		Body:     "@bob",
		Mentions: []string{"bob"},
	})
	bobNotifs, _ := nf.ListForAccount("bob")
	if len(bobNotifs) != 1 {
		t.Fatalf("setup: bob should have 1 notif, got %d", len(bobNotifs))
	}
	nid := bobNotifs[0].ID

	// carol (different account) tries to mark bob's notification read → 404.
	carol := mentionRouter(ch, nh, "carol")
	w := doReq(carol, http.MethodPost, "/notifications/"+nid+"/read", nil)
	if w.Code != http.StatusNotFound {
		t.Fatalf("cross-account mark-read: expected 404, got %d", w.Code)
	}
	// bob can list + mark his own.
	bob := mentionRouter(ch, nh, "bob")
	w = doReq(bob, http.MethodGet, "/notifications", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("bob list notifs: expected 200, got %d", w.Code)
	}
	w = doReq(bob, http.MethodPost, "/notifications/"+nid+"/read", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("bob mark own read: expected 200, got %d", w.Code)
	}
}

// TestReplyMentionNotifies: an @-mention on a reply also notifies.
func TestReplyMentionNotifies(t *testing.T) {
	ch, nh, nf, fileID := setupMentions(t)
	alice := mentionRouter(ch, nh, "alice")

	// First create a comment (no mention).
	w := doReq(alice, http.MethodPost, "/files/"+fileID+"/comments", models.CreateCommentRequest{
		Anchor: models.CommentAnchor{Type: models.AnchorTextRange, From: 0, To: 1},
		Body:   "root",
	})
	var cm models.Comment
	_ = json.Unmarshal(w.Body.Bytes(), &cm)

	// Reply mentioning bob.
	w = doReq(alice, http.MethodPost, "/files/"+fileID+"/comments/"+cm.ID+"/replies", models.CreateReplyRequest{
		Body:     "@bob ping",
		Mentions: []string{"bob"},
	})
	if w.Code != http.StatusCreated {
		t.Fatalf("create reply: expected 201, got %d (%s)", w.Code, w.Body.String())
	}
	bobNotifs, _ := nf.ListForAccount("bob")
	if len(bobNotifs) != 1 {
		t.Fatalf("bob should be notified by reply mention, got %d", len(bobNotifs))
	}
}
