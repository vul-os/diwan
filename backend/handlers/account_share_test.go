package handlers

// account_share_test.go — end-to-end coverage for the ACCOUNT-SHARE feature
// exposed by the /api file handlers:
//
//   1. Commenter role — the /api Share handler now accepts "commenter" (it
//      previously rejected anything but editor/viewer). A commenter can read the
//      document and add comments, but CANNOT edit the document body.
//   2. "Shared with me" (GET /shared-files) — returns files shared TO the caller
//      by another account, never the caller's own files, and never leaks another
//      account's grants (ACL isolation).
//   3. Owner-only controls + revoke — a non-owner cannot grant/change/revoke, and
//      an owner's revoke removes the collaborator's access.
//
// All of these run with auth ENABLED (NewFileAuthzWithAuth(acl, true)) so the
// role/ownership enforcement is live — mirroring multi-tenant production.

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"diwan/backend/audit"
	"diwan/backend/fileacl"
	"diwan/backend/middleware"
	"diwan/backend/models"

	"github.com/gin-gonic/gin"
)

// accountShareStack wires the file + comment handlers over shared storage +
// an auth-enabled ACL so role enforcement is exercised for real.
type accountShareStack struct {
	store    *collabStorage
	authz    *FileAuthz
	files    *FileHandler
	comments *CommentHandler
}

func newAccountShareStack() *accountShareStack {
	st := newCollabStorage()
	acl := fileacl.NewNullStore()
	az := NewFileAuthzWithAuth(acl, true) // auth enabled → real ownership/role checks
	aud := audit.NewNullStore()
	return &accountShareStack{
		store:    st,
		authz:    az,
		files:    NewFileHandlerWithAudit(st, az, aud),
		comments: &CommentHandler{store: st, authz: az},
	}
}

// router builds an engine with the given verified identity and the routes the
// account-share flow touches (CRUD, share, shared-with-me, comments).
func (s *accountShareStack) router(user string, admin bool) *gin.Engine {
	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Set(middleware.CtxAuthenticated, true)
		c.Set(middleware.CtxUserID, user)
		if admin {
			c.Set(middleware.CtxIsAdmin, true)
		}
		c.Next()
	})
	r.GET("/files", s.files.List)
	r.GET("/shared-files", s.files.SharedWithMe)
	r.GET("/files/:id", s.files.Get)
	r.POST("/files", s.files.Create)
	r.PUT("/files/:id", s.files.Update)
	r.DELETE("/files/:id", s.files.Delete)
	r.POST("/files/:id/share", s.files.Share)
	r.GET("/files/:id/collaborators", s.files.Collaborators)
	r.GET("/files/:id/comments", s.comments.List)
	r.POST("/files/:id/comments", s.comments.Create)
	return r
}

func (s *accountShareStack) createFile(t *testing.T, owner string) string {
	t.Helper()
	r := s.router(owner, false)
	w := doReq(r, http.MethodPost, "/files",
		models.CreateFileRequest{Name: "doc", Type: models.FileTypeDoc, Content: "hello"})
	if w.Code != http.StatusCreated {
		t.Fatalf("create as %s: expected 201, got %d (%s)", owner, w.Code, w.Body.String())
	}
	var f models.File
	mustDecode(t, w, &f)
	return f.ID
}

func (s *accountShareStack) share(t *testing.T, owner, fileID, grantee, role string) *httptest.ResponseRecorder {
	t.Helper()
	r := s.router(owner, false)
	body := map[string]interface{}{"account_id": grantee}
	if role != "" {
		body["role"] = role
	}
	return doReq(r, http.MethodPost, "/files/"+fileID+"/share", body)
}

// ---------------------------------------------------------------------------
// 1. Commenter role
// ---------------------------------------------------------------------------

// TestShare_AcceptsCommenterRole verifies the /api Share handler now grants the
// commenter role (it previously 400'd on anything but editor/viewer).
func TestShare_AcceptsCommenterRole(t *testing.T) {
	s := newAccountShareStack()
	id := s.createFile(t, "alice")

	alice := s.router("alice", false)
	w := doReq(alice, http.MethodPost, "/files/"+id+"/share", map[string]interface{}{
		"account_id": "bob", "role": "commenter",
	})
	if w.Code != http.StatusOK {
		t.Fatalf("share commenter: expected 200, got %d (%s)", w.Code, w.Body.String())
	}

	// The stored role must be exactly "commenter".
	role, ok, _ := s.authz.Store().GetRole(id, "bob")
	if !ok || role != fileacl.RoleCommenter {
		t.Fatalf("expected bob role=commenter, got ok=%v role=%q", ok, role)
	}

	// The collaborator roster surfaces the commenter role.
	cw := doReq(alice, http.MethodGet, "/files/"+id+"/collaborators", nil)
	if cw.Code != http.StatusOK {
		t.Fatalf("collaborators: expected 200, got %d", cw.Code)
	}
	if body := cw.Body.String(); !contains(body, "commenter") {
		t.Fatalf("roster should list the commenter role; got %s", body)
	}
}

// TestShare_CommenterCanReadAndComment verifies a commenter may GET the file and
// POST a comment, but is denied a content edit (PUT → 403).
func TestShare_CommenterCanReadAndComment(t *testing.T) {
	s := newAccountShareStack()
	id := s.createFile(t, "alice")
	if w := s.share(t, "alice", id, "bob", "commenter"); w.Code != http.StatusOK {
		t.Fatalf("share commenter failed: %d", w.Code)
	}

	bob := s.router("bob", false)

	// Read → allowed.
	if w := doReq(bob, http.MethodGet, "/files/"+id, nil); w.Code != http.StatusOK {
		t.Fatalf("commenter Get: expected 200, got %d (%s)", w.Code, w.Body.String())
	}

	// Comment → allowed (comments require access, not editor).
	cw := doReq(bob, http.MethodPost, "/files/"+id+"/comments",
		models.CreateCommentRequest{
			Anchor: models.CommentAnchor{Type: models.AnchorTextRange, From: 0, To: 3},
			Body:   "a suggestion from the commenter",
		})
	if cw.Code != http.StatusCreated {
		t.Fatalf("commenter Comment: expected 201, got %d (%s)", cw.Code, cw.Body.String())
	}

	// Content edit → denied (403). commenter is read-only for the body.
	uw := doReq(bob, http.MethodPut, "/files/"+id, models.UpdateFileRequest{Name: "pwned by commenter"})
	if uw.Code != http.StatusForbidden {
		t.Fatalf("VULN: commenter Update not blocked — expected 403, got %d (%s)", uw.Code, uw.Body.String())
	}
}

// TestShare_RejectsUnknownRole verifies a bogus role is rejected (fail closed).
func TestShare_RejectsUnknownRole(t *testing.T) {
	s := newAccountShareStack()
	id := s.createFile(t, "alice")

	alice := s.router("alice", false)
	w := doReq(alice, http.MethodPost, "/files/"+id+"/share", map[string]interface{}{
		"account_id": "bob", "role": "superuser",
	})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("bogus role: expected 400, got %d (%s)", w.Code, w.Body.String())
	}
	// bob must NOT have gained any access.
	bob := s.router("bob", false)
	if gw := doReq(bob, http.MethodGet, "/files/"+id, nil); gw.Code != http.StatusNotFound {
		t.Fatalf("VULN: bob gained access via bogus role — got %d", gw.Code)
	}
}

// TestShare_CannotChangeOwnerAccess verifies the owner cannot be re-shared as a
// lesser collaborator role (which would clobber ownership).
func TestShare_CannotChangeOwnerAccess(t *testing.T) {
	s := newAccountShareStack()
	id := s.createFile(t, "alice")

	alice := s.router("alice", false)
	w := doReq(alice, http.MethodPost, "/files/"+id+"/share", map[string]interface{}{
		"account_id": "alice", "role": "viewer",
	})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("self-share: expected 400, got %d (%s)", w.Code, w.Body.String())
	}
	// alice must still be the owner.
	role, ok, _ := s.authz.Store().GetRole(id, "alice")
	if !ok || role != fileacl.RoleOwner {
		t.Fatalf("owner clobbered: ok=%v role=%q", ok, role)
	}
}

// ---------------------------------------------------------------------------
// 2. Shared with me
// ---------------------------------------------------------------------------

// TestSharedWithMe_ReturnsSharedNotOwned verifies that GET /shared-files lists a
// file shared TO the caller but never the caller's own files.
func TestSharedWithMe_ReturnsSharedNotOwned(t *testing.T) {
	s := newAccountShareStack()
	// alice owns "aliceDoc" and shares it with bob (editor).
	aliceDoc := s.createFile(t, "alice")
	if w := s.share(t, "alice", aliceDoc, "bob", "editor"); w.Code != http.StatusOK {
		t.Fatalf("share failed: %d", w.Code)
	}
	// bob owns his own doc (must NOT appear in his shared-with-me).
	bobDoc := s.createFile(t, "bob")

	bob := s.router("bob", false)
	w := doReq(bob, http.MethodGet, "/shared-files", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("shared-files: expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	body := w.Body.String()
	if !contains(body, aliceDoc) {
		t.Fatalf("shared-with-me should contain alice's shared doc; got %s", body)
	}
	if contains(body, bobDoc) {
		t.Fatalf("shared-with-me leaked bob's OWN doc; got %s", body)
	}
	// The owner attribution must be present.
	if !contains(body, "alice") {
		t.Fatalf("shared-with-me should attribute the owner; got %s", body)
	}
}

// TestSharedWithMe_Isolation verifies one account's shared-with-me never leaks
// another account's grants. carol is not a collaborator on alice→bob's share, so
// carol's shared-with-me must be empty.
func TestSharedWithMe_Isolation(t *testing.T) {
	s := newAccountShareStack()
	aliceDoc := s.createFile(t, "alice")
	if w := s.share(t, "alice", aliceDoc, "bob", "viewer"); w.Code != http.StatusOK {
		t.Fatalf("share failed: %d", w.Code)
	}

	carol := s.router("carol", false)
	w := doReq(carol, http.MethodGet, "/shared-files", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("shared-files as carol: expected 200, got %d", w.Code)
	}
	if contains(w.Body.String(), aliceDoc) {
		t.Fatalf("VULN: carol's shared-with-me leaked alice→bob's share; got %s", w.Body.String())
	}
}

// TestSharedWithMe_RevokeRemoves verifies a revoked collaborator no longer sees
// the file in shared-with-me.
func TestSharedWithMe_RevokeRemoves(t *testing.T) {
	s := newAccountShareStack()
	aliceDoc := s.createFile(t, "alice")
	if w := s.share(t, "alice", aliceDoc, "bob", "editor"); w.Code != http.StatusOK {
		t.Fatalf("share failed: %d", w.Code)
	}

	bob := s.router("bob", false)
	if w := doReq(bob, http.MethodGet, "/shared-files", nil); !contains(w.Body.String(), aliceDoc) {
		t.Fatalf("precondition: bob should see the shared doc; got %s", w.Body.String())
	}

	// alice revokes bob.
	alice := s.router("alice", false)
	if w := doReq(alice, http.MethodPost, "/files/"+aliceDoc+"/share", map[string]interface{}{
		"account_id": "bob", "revoke": true,
	}); w.Code != http.StatusOK {
		t.Fatalf("revoke: expected 200, got %d (%s)", w.Code, w.Body.String())
	}

	// bob's shared-with-me is now empty AND direct access is gone (404).
	if w := doReq(bob, http.MethodGet, "/shared-files", nil); contains(w.Body.String(), aliceDoc) {
		t.Fatalf("revoked collaborator still sees doc in shared-with-me; got %s", w.Body.String())
	}
	if w := doReq(bob, http.MethodGet, "/files/"+aliceDoc, nil); w.Code != http.StatusNotFound {
		t.Fatalf("revoked collaborator still has access — got %d", w.Code)
	}
}

// ---------------------------------------------------------------------------
// 3. Owner-only controls
// ---------------------------------------------------------------------------

// TestShare_OwnerOnlyControls verifies a non-owner (even an editor) cannot grant
// or change a role, and cannot revoke another collaborator.
func TestShare_OwnerOnlyControls(t *testing.T) {
	s := newAccountShareStack()
	id := s.createFile(t, "alice")
	if w := s.share(t, "alice", id, "bob", "editor"); w.Code != http.StatusOK {
		t.Fatalf("seed editor share failed: %d", w.Code)
	}
	if w := s.share(t, "alice", id, "carol", "viewer"); w.Code != http.StatusOK {
		t.Fatalf("seed viewer share failed: %d", w.Code)
	}

	bob := s.router("bob", false)
	// editor bob cannot grant to mallory.
	if w := doReq(bob, http.MethodPost, "/files/"+id+"/share", map[string]interface{}{
		"account_id": "mallory", "role": "editor",
	}); w.Code != http.StatusForbidden {
		t.Fatalf("VULN: editor grant not blocked — expected 403, got %d (%s)", w.Code, w.Body.String())
	}
	// editor bob cannot change carol's role.
	if w := doReq(bob, http.MethodPost, "/files/"+id+"/share", map[string]interface{}{
		"account_id": "carol", "role": "editor",
	}); w.Code != http.StatusForbidden {
		t.Fatalf("VULN: editor role-change not blocked — expected 403, got %d", w.Code)
	}
	// editor bob cannot revoke carol.
	if w := doReq(bob, http.MethodPost, "/files/"+id+"/share", map[string]interface{}{
		"account_id": "carol", "revoke": true,
	}); w.Code != http.StatusForbidden {
		t.Fatalf("VULN: editor revoke not blocked — expected 403, got %d", w.Code)
	}
	// mallory gained nothing.
	mallory := s.router("mallory", false)
	if w := doReq(mallory, http.MethodGet, "/files/"+id, nil); w.Code != http.StatusNotFound {
		t.Fatalf("VULN: mallory gained access — got %d", w.Code)
	}
	// carol still has access (role unchanged, not revoked).
	carol := s.router("carol", false)
	if w := doReq(carol, http.MethodGet, "/files/"+id, nil); w.Code != http.StatusOK {
		t.Fatalf("carol lost access after non-owner meddling — got %d", w.Code)
	}
}

// contains is a tiny substring helper (avoids importing strings for one call).
func contains(haystack, needle string) bool {
	return len(needle) == 0 || indexOf(haystack, needle) >= 0
}

func indexOf(h, n string) int {
	for i := 0; i+len(n) <= len(h); i++ {
		if h[i:i+len(n)] == n {
			return i
		}
	}
	return -1
}
