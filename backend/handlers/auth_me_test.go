package handlers

// auth_me_test.go — the shells' auth boundary must actually EXIST.
//
// RequireAuth.jsx has always called GET /api/auth/me and redirected to the CP
// login on 401. But the route was never registered: the call 404'd, which is not
// a 401, so the shell concluded "authed" and the client-side boundary silently
// never fired. Server-side enforcement (AuthWithSSO) still held, so this was a UX
// bug rather than an authz hole — the user got a broken app instead of a login
// redirect. These tests pin the route's existence and its two verdicts.

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"diwan/backend/config"
	"diwan/backend/middleware"

	"github.com/gin-gonic/gin"
)

// meRouter mounts /api/auth/me exactly as main.go does: inside the `protected`
// group, behind AuthWithSSO — so the endpoint's verdict is the same one the rest
// of the protected surface enforces.
func meRouter(cfg *config.Config) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	h := &AuthHandler{cfg: cfg}
	g := r.Group("/api")
	if cfg.Auth.Enabled {
		g.Use(middleware.AuthWithSSO(cfg, nil))
	}
	g.GET("/auth/me", h.Me)
	return r
}

// Unauthenticated → 401, which is what RequireAuth keys its login redirect off.
// (Before the route existed this was a 404, and the shell read that as "authed".)
func TestAuthMe_UnauthenticatedIs401(t *testing.T) {
	r := meRouter(&config.Config{Auth: config.AuthConfig{Enabled: true}})
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/auth/me", nil))

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("an unauthenticated /api/auth/me must 401 (so the shell redirects to login), got %d: %s",
			w.Code, w.Body.String())
	}
}

// Self-host single-user (auth disabled, no SSO): the protected group has no
// middleware, so the boundary passes through rather than bouncing a local user.
func TestAuthMe_LocalPassthrough(t *testing.T) {
	r := meRouter(&config.Config{Auth: config.AuthConfig{Enabled: false}})
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/auth/me", nil))

	if w.Code != http.StatusOK {
		t.Fatalf("self-host local mode must pass the auth boundary, got %d: %s", w.Code, w.Body.String())
	}
}
