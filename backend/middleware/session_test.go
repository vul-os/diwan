package middleware

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"diwan/backend/config"
	"diwan/backend/session"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
)

// stubSession is a mocked session.Introspector for middleware tests. It counts
// calls so cache/precedence behavior can be asserted.
type stubSession struct {
	res   session.Result
	err   error
	calls int
}

func (s *stubSession) Introspect(_ context.Context, _ string) (session.Result, error) {
	s.calls++
	return s.res, s.err
}

// ssoRouter mounts a route guarded by AuthWithSSO that echoes the resolved
// identity + tenant so tests can assert scoping.
func ssoRouter(cfg *config.Config, sess session.Introspector) *gin.Engine {
	r := gin.New()
	g := r.Group("/api")
	g.Use(AuthWithSSO(cfg, sess))
	g.GET("/ping", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"user":   c.GetString(CtxUserID),
			"tenant": c.GetString(CtxTenantID),
			"method": c.GetString(CtxAuthMethod),
			"admin":  c.GetBool(CtxIsAdmin),
		})
	})
	return r
}

func reqWithCookie(cookieVal string) *http.Request {
	req := httptest.NewRequest(http.MethodGet, "/api/ping", nil)
	if cookieVal != "" {
		req.AddCookie(&http.Cookie{Name: session.CookieName, Value: cookieVal})
	}
	return req
}

func serve(r *gin.Engine, req *http.Request) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

// mintJWT signs a product-JWT with the given subject using the dev secret.
func mintJWT(t *testing.T, subject string, admin bool) string {
	t.Helper()
	t.Setenv(EnvDevMode, "1")
	resetSecretCacheForTest()
	secret, err := JWTSecret()
	if err != nil {
		t.Fatalf("secret: %v", err)
	}
	claims := jwt.RegisteredClaims{Subject: subject, ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour))}
	if admin {
		claims.Audience = jwt.ClaimStrings{"vulos:admin"}
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := tok.SignedString(secret)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return signed
}

// ── IDENTITY_URL unset → unchanged local behavior ────────────────────────────

func TestAuthWithSSO_Disabled_LocalMode(t *testing.T) {
	// Auth disabled + no introspector → passthrough (self-host single-user).
	cfg := &config.Config{Auth: config.AuthConfig{Enabled: false}}
	r := ssoRouter(cfg, nil)
	w := serve(r, reqWithCookie(""))
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 local passthrough, got %d (%s)", w.Code, w.Body.String())
	}
	if contains(w.Body.String(), "\"admin\":true") {
		t.Fatalf("local caller must not be admin: %s", w.Body.String())
	}
}

func TestAuthWithSSO_ProductJWT_StillWorks(t *testing.T) {
	// Auth enabled, no SSO: the existing product-JWT session must still authenticate.
	cfg := &config.Config{Auth: config.AuthConfig{Enabled: true}}
	tok := mintJWT(t, "bob@vulos.org", false)
	r := ssoRouter(cfg, nil)
	req := httptest.NewRequest(http.MethodGet, "/api/ping", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	w := serve(r, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 product-JWT, got %d (%s)", w.Code, w.Body.String())
	}
	if !contains(w.Body.String(), "bob@vulos.org") {
		t.Fatalf("expected product-JWT subject, got %s", w.Body.String())
	}
}

func TestAuthWithSSO_SSOOnly_AuthDisabled_EnforcesSSO(t *testing.T) {
	// Native auth OFF but an SSO provider IS configured (SSO-only cloud): the
	// disabled-mode "self" passthrough must NOT apply — SSO is enforced.
	cfg := &config.Config{Auth: config.AuthConfig{Enabled: false}}
	sess := &stubSession{res: session.Result{Valid: true, UserID: "erin@vulos.org", TenantID: "tE"}}
	r := ssoRouter(cfg, sess)

	// No cookie → 401 (does NOT fall open to "self").
	if w := serve(r, reqWithCookie("")); w.Code != http.StatusUnauthorized {
		t.Fatalf("SSO-only + no cookie must 401, got %d (%s)", w.Code, w.Body.String())
	}
	// Valid cookie → resolved via SSO.
	w := serve(r, reqWithCookie("vc"))
	if w.Code != http.StatusOK || !contains(w.Body.String(), "erin@vulos.org") {
		t.Fatalf("SSO-only valid cookie must resolve, got %d (%s)", w.Code, w.Body.String())
	}
}

// ── IDENTITY_URL set + valid session → user/tenant resolved + scoped ─────────

func TestAuthWithSSO_ValidSession_ResolvesTenant(t *testing.T) {
	cfg := &config.Config{Auth: config.AuthConfig{Enabled: true}}
	sess := &stubSession{res: session.Result{Valid: true, UserID: "carol@vulos.org", TenantID: "acct_42"}}
	r := ssoRouter(cfg, sess)
	w := serve(r, reqWithCookie("vc-good"))
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	body := w.Body.String()
	if !contains(body, "carol@vulos.org") || !contains(body, "acct_42") || !contains(body, CtxAuthMethodSession) {
		t.Fatalf("expected resolved user+tenant, got %s", body)
	}
	// SSO users are never implicitly admin.
	if contains(body, "\"admin\":true") {
		t.Fatalf("SSO session must not be admin: %s", body)
	}
}

// ── IDENTITY_URL set + invalid/expired session → 401 (no fall-open) ──────────

func TestAuthWithSSO_InvalidSession_401(t *testing.T) {
	cfg := &config.Config{Auth: config.AuthConfig{Enabled: true}}
	sess := &stubSession{res: session.Result{Valid: false}}
	r := ssoRouter(cfg, sess)
	w := serve(r, reqWithCookie("vc-bad"))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for invalid session, got %d (%s)", w.Code, w.Body.String())
	}
}

// ── IDENTITY_URL set + CP unreachable → 401 fail-closed (never fall open) ─────

func TestAuthWithSSO_ProviderUnreachable_FailsClosed(t *testing.T) {
	cfg := &config.Config{Auth: config.AuthConfig{Enabled: true}}
	sess := &stubSession{err: errors.New("cp down")}
	r := ssoRouter(cfg, sess)
	w := serve(r, reqWithCookie("vc-whatever"))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 fail-closed when provider unreachable, got %d (%s)", w.Code, w.Body.String())
	}
}

// ── IDENTITY_URL set + NO cookie → 401 (never falls open to shared identity) ──

func TestAuthWithSSO_NoCookie_FailsClosed(t *testing.T) {
	cfg := &config.Config{Auth: config.AuthConfig{Enabled: true}}
	sess := &stubSession{res: session.Result{Valid: true, UserID: "x", TenantID: "t"}}
	r := ssoRouter(cfg, sess)
	w := serve(r, reqWithCookie("")) // no vc_session cookie, no JWT
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 when no credential in multi-user mode, got %d (%s)", w.Code, w.Body.String())
	}
	if sess.calls != 0 {
		t.Fatalf("introspector must not be called with no cookie, got %d calls", sess.calls)
	}
}

// ── Precedence: product-JWT wins over SSO when both present ───────────────────

func TestAuthWithSSO_ProductJWT_TakesPrecedenceOverSSO(t *testing.T) {
	cfg := &config.Config{Auth: config.AuthConfig{Enabled: true}}
	tok := mintJWT(t, "jwtuser@vulos.org", false)
	sess := &stubSession{res: session.Result{Valid: true, UserID: "ssouser@vulos.org", TenantID: "t"}}
	r := ssoRouter(cfg, sess)
	req := httptest.NewRequest(http.MethodGet, "/api/ping", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	req.AddCookie(&http.Cookie{Name: session.CookieName, Value: "vc-good"})
	w := serve(r, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	if !contains(w.Body.String(), "jwtuser@vulos.org") {
		t.Fatalf("product-JWT must win over SSO, got %s", w.Body.String())
	}
	if sess.calls != 0 {
		t.Fatalf("SSO introspect must be skipped when product-JWT authenticates, got %d calls", sess.calls)
	}
}

// ── Tenant isolation: two users on different tenants get distinct scopes ──────

func TestAuthWithSSO_TenantScopingIsolation(t *testing.T) {
	cfg := &config.Config{Auth: config.AuthConfig{Enabled: true}}

	sessA := &stubSession{res: session.Result{Valid: true, UserID: "a@vulos.org", TenantID: "tenantA"}}
	wa := serve(ssoRouter(cfg, sessA), reqWithCookie("cookie-a"))
	if !contains(wa.Body.String(), "tenantA") {
		t.Fatalf("user A must be scoped to tenantA, got %s", wa.Body.String())
	}

	sessB := &stubSession{res: session.Result{Valid: true, UserID: "b@vulos.org", TenantID: "tenantB"}}
	wb := serve(ssoRouter(cfg, sessB), reqWithCookie("cookie-b"))
	if !contains(wb.Body.String(), "tenantB") {
		t.Fatalf("user B must be scoped to tenantB, got %s", wb.Body.String())
	}
	if contains(wb.Body.String(), "tenantA") {
		t.Fatalf("tenant leak: user B saw tenantA")
	}
}

// ── V1Auth SSO path ──────────────────────────────────────────────────────────

// v1SSORouter mounts a V1Auth-guarded route with an SSO introspector.
func v1SSORouter(cfg *config.Config, sess session.Introspector) *gin.Engine {
	r := gin.New()
	g := r.Group("/v1")
	g.Use(V1Auth(cfg, nil, sess)) // no apikey introspector; SSO only
	g.GET("/ping", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"user":   c.GetString(CtxUserID),
			"tenant": c.GetString(CtxTenantID),
			"method": c.GetString(CtxAuthMethod),
		})
	})
	return r
}

func TestV1Auth_SSO_ValidSession(t *testing.T) {
	cfg := &config.Config{Auth: config.AuthConfig{Enabled: true}}
	sess := &stubSession{res: session.Result{Valid: true, UserID: "dave@vulos.org", TenantID: "acct_9"}}
	r := v1SSORouter(cfg, sess)
	req := httptest.NewRequest(http.MethodGet, "/v1/ping", nil)
	req.AddCookie(&http.Cookie{Name: session.CookieName, Value: "vc"})
	w := serve(r, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	if !contains(w.Body.String(), "dave@vulos.org") || !contains(w.Body.String(), "acct_9") {
		t.Fatalf("expected SSO identity in /v1, got %s", w.Body.String())
	}
}

func TestV1Auth_SSO_InvalidSession_401(t *testing.T) {
	cfg := &config.Config{Auth: config.AuthConfig{Enabled: true}}
	sess := &stubSession{res: session.Result{Valid: false}}
	r := v1SSORouter(cfg, sess)
	req := httptest.NewRequest(http.MethodGet, "/v1/ping", nil)
	req.AddCookie(&http.Cookie{Name: session.CookieName, Value: "vc-bad"})
	w := serve(r, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d (%s)", w.Code, w.Body.String())
	}
}

func TestV1Auth_SSO_ProviderUnreachable_401(t *testing.T) {
	cfg := &config.Config{Auth: config.AuthConfig{Enabled: true}}
	sess := &stubSession{err: errors.New("down")}
	r := v1SSORouter(cfg, sess)
	req := httptest.NewRequest(http.MethodGet, "/v1/ping", nil)
	req.AddCookie(&http.Cookie{Name: session.CookieName, Value: "vc"})
	w := serve(r, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 fail-closed, got %d (%s)", w.Code, w.Body.String())
	}
}
