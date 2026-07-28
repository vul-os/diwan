package handlers

// file_authz_unit_test.go — WAVE32 coverage. Direct unit tests for the FileAuthz
// predicates that the HTTP-level pentests don't reach:
//
//   - requireOwner / requireEditor role-denial branches (403 for viewer/
//     commenter) and the GetRole storage-error branch (500, fail closed).
//   - canAccessEnvelopeACL fallback to the envelope id.

import (
	"net/http/httptest"
	"testing"

	"diwan/backend/fileacl"
	"diwan/backend/middleware"

	"github.com/gin-gonic/gin"
)

func init() { gin.SetMode(gin.TestMode) }

// ctxFor builds a gin context carrying a verified identity (and optional admin).
func ctxFor(user string, admin bool) *gin.Context {
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Set(middleware.CtxAuthenticated, true)
	c.Set(middleware.CtxUserID, user)
	if admin {
		c.Set(middleware.CtxIsAdmin, true)
	}
	return c
}

// errStore is a fileacl.Store whose reads fail, to exercise the fail-closed
// storage-error branches of the authorizer.
type errStore struct{ fileacl.Store }

func (errStore) CanAccess(string, string) (bool, bool, error) {
	return false, false, assertErr
}
func (errStore) GetRole(string, string) (fileacl.Role, bool, error) {
	return fileacl.RoleNone, false, assertErr
}

var assertErr = &fakeErr{}

type fakeErr struct{}

func (*fakeErr) Error() string { return "boom" }

// --- requireOwner / requireEditor role branches ---------------------------

func TestRequireOwner_DeniesNonOwnerCollaborator(t *testing.T) {
	acl := fileacl.NewNullStore()
	az := NewFileAuthzWithAuth(acl, true)
	_ = acl.SetOwner("doc", "alice")
	_ = acl.ShareWithRole("doc", "bob", fileacl.RoleEditor) // editor, not owner

	// bob has access (so no 404) but is not the owner → 403.
	c := ctxFor("bob", false)
	c.Params = gin.Params{{Key: "id", Value: "doc"}}
	if az.requireOwner(c, "doc") {
		t.Error("editor must NOT pass requireOwner")
	}
	if got := c.Writer.Status(); got != 403 {
		t.Errorf("requireOwner denial status = %d; want 403", got)
	}
}

func TestRequireOwner_OwnerAndAdminPass(t *testing.T) {
	acl := fileacl.NewNullStore()
	az := NewFileAuthzWithAuth(acl, true)
	_ = acl.SetOwner("doc", "alice")

	if !az.requireOwner(ctxFor("alice", false), "doc") {
		t.Error("owner must pass requireOwner")
	}
	// Admin bypasses ownership even on someone else's file.
	if !az.requireOwner(ctxFor("root", true), "doc") {
		t.Error("admin must pass requireOwner")
	}
}

func TestRequireEditor_DeniesViewerAndCommenter(t *testing.T) {
	acl := fileacl.NewNullStore()
	az := NewFileAuthzWithAuth(acl, true)
	_ = acl.SetOwner("doc", "alice")
	_ = acl.ShareWithRole("doc", "vic", fileacl.RoleViewer)
	_ = acl.ShareWithRole("doc", "com", fileacl.RoleCommenter)

	for _, u := range []string{"vic", "com"} {
		c := ctxFor(u, false)
		if az.requireEditor(c, "doc") {
			t.Errorf("%s (read-only role) must NOT pass requireEditor", u)
		}
		if got := c.Writer.Status(); got != 403 {
			t.Errorf("%s requireEditor denial status = %d; want 403", u, got)
		}
	}

	// Editor and owner pass.
	_ = acl.ShareWithRole("doc", "ed", fileacl.RoleEditor)
	if !az.requireEditor(ctxFor("ed", false), "doc") {
		t.Error("editor must pass requireEditor")
	}
	if !az.requireEditor(ctxFor("alice", false), "doc") {
		t.Error("owner must pass requireEditor")
	}
}

func TestRequireEditor_StorageErrorFailsClosed(t *testing.T) {
	// A GetRole storage error must 500 and deny (fail closed), never allow.
	// require() calls CanAccess (also errStore → false), so this actually hits
	// the 404 base-denial path; assert denial regardless of code.
	az := NewFileAuthzWithAuth(errStore{}, true)
	c := ctxFor("x", false)
	if az.requireEditor(c, "doc") {
		t.Error("requireEditor must fail closed on storage error")
	}
}

func TestRequireCommenter_DeniesViewerOnly(t *testing.T) {
	acl := fileacl.NewNullStore()
	az := NewFileAuthzWithAuth(acl, true)
	_ = acl.SetOwner("doc", "alice")
	_ = acl.ShareWithRole("doc", "vic", fileacl.RoleViewer)
	_ = acl.ShareWithRole("doc", "com", fileacl.RoleCommenter)
	_ = acl.ShareWithRole("doc", "ed", fileacl.RoleEditor)

	c := ctxFor("vic", false)
	if az.requireCommenter(c, "doc") {
		t.Error("VULN: viewer must NOT pass requireCommenter")
	}
	if got := c.Writer.Status(); got != 403 {
		t.Errorf("viewer requireCommenter denial status = %d; want 403", got)
	}

	for _, u := range []string{"com", "ed", "alice"} {
		if !az.requireCommenter(ctxFor(u, false), "doc") {
			t.Errorf("%s must pass requireCommenter", u)
		}
	}
	// Admin bypasses role checks entirely.
	if !az.requireCommenter(ctxFor("root", true), "doc") {
		t.Error("admin must pass requireCommenter")
	}
}

func TestRequireCommenter_StorageErrorFailsClosed(t *testing.T) {
	az := NewFileAuthzWithAuth(errStore{}, true)
	c := ctxFor("x", false)
	if az.requireCommenter(c, "doc") {
		t.Error("requireCommenter must fail closed on storage error")
	}
}

func TestRequireCommenter_DisabledAuthIsPermissive(t *testing.T) {
	az := NewFileAuthz(fileacl.NewNullStore()) // authEnabled=false
	if !az.requireCommenter(ctxFor("self", false), "anydoc") {
		t.Error("single-user mode requireCommenter should pass")
	}
}

func TestRequireEditor_DisabledAuthIsPermissive(t *testing.T) {
	// Single-user mode: role enforcement is a no-op beyond base access.
	az := NewFileAuthz(fileacl.NewNullStore()) // authEnabled=false
	if !az.requireEditor(ctxFor("self", false), "anydoc") {
		t.Error("single-user mode requireEditor should pass")
	}
}

// --- SSO-only multi-tenant posture (regression) ---------------------------
//
// Regression for the fail-OPEN bug where the per-file ACL ran in single-user
// posture in an "SSO-only" deployment: native product-JWT auth is DISABLED
// (cfg.Auth.Enabled == false) but a session introspector is wired, making the
// deployment first-class multi-user. The composition root now passes
//
//	cfg.Auth.Enabled || sessionIntrospector != nil
//
// as the FileAuthz posture flag, so FileAuthz.authEnabled == true even though
// native auth is off. These tests assert that with the flag true the
// isolation/role enforcement holds exactly as in native-auth multi-tenant mode
// (the value of the flag, not its source, is what matters to FileAuthz).

// TestSSOOnly_UnrecordedDocDeniedToNonOwner proves (a): under the SSO-only
// posture an UNRECORDED/legacy doc is NOT globally readable — a non-owner tenant
// is denied. Under the old single-user posture this fell OPEN and leaked the doc.
func TestSSOOnly_UnrecordedDocDeniedToNonOwner(t *testing.T) {
	acl := fileacl.NewNullStore()
	// authEnabled=true is the multi-tenant posture the SSO-only composition root
	// now produces via `cfg.Auth.Enabled || sessionIntrospector != nil`, even with
	// cfg.Auth.Enabled == false.
	az := NewFileAuthzWithAuth(acl, true)

	// No SetOwner: "unowned-legacy" has no ACL record at all.
	c := ctxFor("mallory", false)
	c.Params = gin.Params{{Key: "id", Value: "unowned-legacy"}}
	if az.canAccess(c, "unowned-legacy") {
		t.Error("VULN: unrecorded doc must be DENIED to a non-owner tenant in SSO-only posture")
	}
	// require() must translate that to a 404 (no existence leak) and return false.
	if az.require(c, "unowned-legacy") {
		t.Error("require() must deny an unrecorded doc in SSO-only posture")
	}
	if got := c.Writer.Status(); got != 404 {
		t.Errorf("require() denial status = %d; want 404", got)
	}
}

// TestSSOOnly_ViewerRefusedOwnerAndEditorOps proves (b): under the SSO-only
// posture a viewer-only collaborator is refused owner/editor/commenter
// operations (no viewer→editor/owner escalation). Under the old single-user
// posture every require* short-circuited to true.
func TestSSOOnly_ViewerRefusedOwnerAndEditorOps(t *testing.T) {
	acl := fileacl.NewNullStore()
	az := NewFileAuthzWithAuth(acl, true) // SSO-only multi-tenant posture
	_ = acl.SetOwner("doc", "alice")
	_ = acl.ShareWithRole("doc", "victor", fileacl.RoleViewer) // read-only

	// Owner op (transfer-owner / delete): viewer must be refused with 403.
	cOwner := ctxFor("victor", false)
	cOwner.Params = gin.Params{{Key: "id", Value: "doc"}}
	if az.requireOwner(cOwner, "doc") {
		t.Error("VULN: viewer must NOT pass requireOwner in SSO-only posture")
	}
	if got := cOwner.Writer.Status(); got != 403 {
		t.Errorf("requireOwner denial status = %d; want 403", got)
	}

	// Editor op (PATCH content): viewer must be refused with 403.
	cEdit := ctxFor("victor", false)
	cEdit.Params = gin.Params{{Key: "id", Value: "doc"}}
	if az.requireEditor(cEdit, "doc") {
		t.Error("VULN: viewer must NOT pass requireEditor in SSO-only posture")
	}
	if got := cEdit.Writer.Status(); got != 403 {
		t.Errorf("requireEditor denial status = %d; want 403", got)
	}

	// Commenter op: viewer must be refused with 403.
	cComment := ctxFor("victor", false)
	cComment.Params = gin.Params{{Key: "id", Value: "doc"}}
	if az.requireCommenter(cComment, "doc") {
		t.Error("VULN: viewer must NOT pass requireCommenter in SSO-only posture")
	}
	if got := cComment.Writer.Status(); got != 403 {
		t.Errorf("requireCommenter denial status = %d; want 403", got)
	}

	// Sanity: the owner still passes all three (enforcement is not over-broad).
	if !az.requireOwner(ctxFor("alice", false), "doc") {
		t.Error("owner must still pass requireOwner in SSO-only posture")
	}
	if !az.requireEditor(ctxFor("alice", false), "doc") {
		t.Error("owner must still pass requireEditor in SSO-only posture")
	}
}

// --- canAccessEnvelopeACL fallback ----------------------------------------

func TestCanAccessEnvelopeACL_FallsBackToEnvelopeID(t *testing.T) {
	acl := fileacl.NewNullStore()
	az := NewFileAuthzWithAuth(acl, true)
	// Envelope with an unowned source file, but the envelope id itself is owned.
	_ = acl.SetOwner("env-123", "alice")

	c := ctxFor("alice", false)
	if !az.canAccessEnvelopeACL(c, "" /*no source file*/, "env-123") {
		t.Error("owner of the envelope id must be granted access")
	}
	// A stranger owns neither the source file nor the envelope id → denied.
	if az.canAccessEnvelopeACL(ctxFor("mallory", false), "", "env-123") {
		t.Error("stranger must be denied envelope access")
	}
}
