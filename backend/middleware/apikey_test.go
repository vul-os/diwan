package middleware

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"diwan/backend/apikey"
	"diwan/backend/config"

	"github.com/gin-gonic/gin"
)

func init() { gin.SetMode(gin.TestMode) }

// stubIntrospector is a mocked apikey.Introspector for middleware tests.
type stubIntrospector struct {
	res apikey.Result
	err error
}

func (s stubIntrospector) Introspect(_ context.Context, _ string) (apikey.Result, error) {
	return s.res, s.err
}

// v1TestRouter mounts a single protected route guarded by V1Auth that echoes the
// resolved identity.
func v1TestRouter(cfg *config.Config, intro apikey.Introspector) *gin.Engine {
	r := gin.New()
	g := r.Group("/v1")
	g.Use(V1Auth(cfg, intro, nil))
	g.GET("/ping", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"user":   c.GetString(CtxUserID),
			"method": c.GetString(CtxAuthMethod),
			"admin":  c.GetBool(CtxIsAdmin),
		})
	})
	return r
}

func do(r *gin.Engine, authHeader string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "/v1/ping", nil)
	if authHeader != "" {
		req.Header.Set("Authorization", authHeader)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestV1Auth_ValidAPIKey(t *testing.T) {
	cfg := &config.Config{Auth: config.AuthConfig{Enabled: true}}
	intro := stubIntrospector{res: apikey.Result{Valid: true, Account: "alice@vulos.org", Products: []string{"office"}}}
	r := v1TestRouter(cfg, intro)

	w := do(r, "Bearer vk_live_good")
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	if body := w.Body.String(); body == "" || !contains(body, "alice@vulos.org") || !contains(body, "apikey") {
		t.Fatalf("expected identity from key, got %s", body)
	}
}

func TestV1Auth_InvalidAPIKey(t *testing.T) {
	cfg := &config.Config{Auth: config.AuthConfig{Enabled: true}}
	intro := stubIntrospector{res: apikey.Result{Valid: false}}
	r := v1TestRouter(cfg, intro)

	w := do(r, "Bearer vk_bad")
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d (%s)", w.Code, w.Body.String())
	}
}

func TestV1Auth_KeyMissingOfficeProduct(t *testing.T) {
	cfg := &config.Config{Auth: config.AuthConfig{Enabled: true}}
	intro := stubIntrospector{res: apikey.Result{Valid: true, Account: "x", Products: []string{"mail"}}}
	r := v1TestRouter(cfg, intro)

	w := do(r, "Bearer vk_wrongproduct")
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d (%s)", w.Code, w.Body.String())
	}
}

func TestV1Auth_IntrospectionUnavailable(t *testing.T) {
	cfg := &config.Config{Auth: config.AuthConfig{Enabled: true}}
	intro := stubIntrospector{err: errors.New("cp down")}
	r := v1TestRouter(cfg, intro)

	w := do(r, "Bearer vk_anything")
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d (%s)", w.Code, w.Body.String())
	}
}

func TestV1Auth_NoCredsAuthEnabled(t *testing.T) {
	cfg := &config.Config{Auth: config.AuthConfig{Enabled: true}}
	r := v1TestRouter(cfg, stubIntrospector{})

	w := do(r, "")
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d (%s)", w.Code, w.Body.String())
	}
}

func TestV1Auth_SelfHostAuthDisabled(t *testing.T) {
	cfg := &config.Config{Auth: config.AuthConfig{Enabled: false}}
	r := v1TestRouter(cfg, nil) // no introspector configured

	// No credentials, auth disabled → allowed as local "self" (not admin).
	w := do(r, "")
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 in self-host mode, got %d (%s)", w.Code, w.Body.String())
	}
	if contains(w.Body.String(), "\"admin\":true") {
		t.Fatalf("self-host caller must not be admin: %s", w.Body.String())
	}
}

func TestV1Auth_KeyIgnoredWhenIntrospectorNil(t *testing.T) {
	// vk_ key presented but introspection NOT configured + auth disabled →
	// falls through to the session path → allowed as self (key not honored).
	cfg := &config.Config{Auth: config.AuthConfig{Enabled: false}}
	r := v1TestRouter(cfg, nil)

	w := do(r, "Bearer vk_ignored")
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 (session fallback), got %d (%s)", w.Code, w.Body.String())
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (func() bool {
		for i := 0; i+len(sub) <= len(s); i++ {
			if s[i:i+len(sub)] == sub {
				return true
			}
		}
		return false
	})()
}
