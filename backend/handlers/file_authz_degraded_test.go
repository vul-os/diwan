package handlers

// file_authz_degraded_test.go — regression test for the file-ACL fail-open hole.
// Previously a degraded/nil ACL store made canAccess return true (and an unowned
// file was globally readable), which leaked documents when auth was enabled.
// Now: with auth ENABLED a nil/degraded store denies, and an unowned file is not
// globally readable.

import (
	"net/http"
	"testing"

	"diwan/backend/fileacl"
	"diwan/backend/middleware"
	"diwan/backend/models"

	"github.com/gin-gonic/gin"
)

// authzRouter wires file Get over a caller-supplied authorizer with a verified
// (authenticated) identity injected.
func authzRouter(h *FileHandler, user string) *gin.Engine {
	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Set(middleware.CtxAuthenticated, true)
		c.Set(middleware.CtxUserID, user)
		c.Next()
	})
	r.GET("/files/:id", h.Get)
	return r
}

// A degraded (nil) ACL store with auth ENABLED must NOT grant access.
func TestFileAuthz_NilStore_AuthEnabled_Denies(t *testing.T) {
	st := newMemStorage()
	st.files["f1"] = &models.File{ID: "f1", Name: "secret", Content: "x"}

	h := NewFileHandlerWithAuthz(st, NewFileAuthzWithAuth(nil, true))
	r := authzRouter(h, "mallory")

	if w := doReq(r, http.MethodGet, "/files/f1", nil); w.Code == http.StatusOK {
		t.Fatalf("VULN: degraded ACL store granted access under auth (%d %s)", w.Code, w.Body.String())
	}
}

// An UNOWNED (no recorded owner) file must NOT be globally readable when auth is
// enabled — the fail-safe "unowned ⇒ allow" applies only to single-user mode.
func TestFileAuthz_UnownedFile_AuthEnabled_Denies(t *testing.T) {
	st := newMemStorage()
	st.files["f1"] = &models.File{ID: "f1", Name: "secret", Content: "x"}

	// Real store, but no owner recorded for f1 → unowned/legacy.
	acl := fileacl.NewNullStore()
	h := NewFileHandlerWithAuthz(st, NewFileAuthzWithAuth(acl, true))
	r := authzRouter(h, "mallory")

	if w := doReq(r, http.MethodGet, "/files/f1", nil); w.Code == http.StatusOK {
		t.Fatalf("VULN: unowned file globally readable under auth (%d %s)", w.Code, w.Body.String())
	}
}

// Sanity: with auth DISABLED a degraded store still fails OPEN so a single-user
// operator is not locked out (preserves OSS local-mode behaviour).
func TestFileAuthz_NilStore_AuthDisabled_Allows(t *testing.T) {
	st := newMemStorage()
	st.files["f1"] = &models.File{ID: "f1", Name: "doc", Content: "x"}

	h := NewFileHandlerWithAuthz(st, NewFileAuthzWithAuth(nil, false))
	r := authzRouter(h, "self")

	if w := doReq(r, http.MethodGet, "/files/f1", nil); w.Code != http.StatusOK {
		t.Fatalf("single-user mode should fail open, got %d (%s)", w.Code, w.Body.String())
	}
}
