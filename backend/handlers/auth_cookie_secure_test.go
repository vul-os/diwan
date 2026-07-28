package handlers

// auth_cookie_secure_test.go — LOW regression guard: the session cookie set by
// Login/Logout previously never set Secure, so it could be sent over a
// downgraded plain-HTTP connection. requestIsHTTPS now drives Secure: true
// when the connection terminated TLS directly, or a trusted reverse proxy
// forwarded X-Forwarded-Proto: https.

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"diwan/backend/middleware"
	"diwan/backend/userauth"

	"github.com/gin-gonic/gin"
)

func TestRequestIsHTTPS_PlainHTTPNoHeader(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	if requestIsHTTPS(r) {
		t.Error("plain HTTP request with no forwarded-proto header must not be treated as HTTPS")
	}
}

func TestRequestIsHTTPS_DirectTLS(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.TLS = &tls.ConnectionState{}
	if !requestIsHTTPS(r) {
		t.Error("a request with a non-nil TLS connection state must be treated as HTTPS")
	}
}

func TestRequestIsHTTPS_ForwardedProtoHTTPS(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("X-Forwarded-Proto", "https")
	if !requestIsHTTPS(r) {
		t.Error("X-Forwarded-Proto: https must be treated as HTTPS")
	}
	// Case-insensitive / whitespace-tolerant.
	r2 := httptest.NewRequest(http.MethodGet, "/", nil)
	r2.Header.Set("X-Forwarded-Proto", " HTTPS ")
	if !requestIsHTTPS(r2) {
		t.Error("X-Forwarded-Proto matching should be case/whitespace tolerant")
	}
}

func TestRequestIsHTTPS_ForwardedProtoHTTP(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("X-Forwarded-Proto", "http")
	if requestIsHTTPS(r) {
		t.Error("X-Forwarded-Proto: http must NOT be treated as HTTPS")
	}
}

func TestRequestIsHTTPS_NilRequest(t *testing.T) {
	if requestIsHTTPS(nil) {
		t.Error("nil request must not be treated as HTTPS")
	}
}

// --- HTTP-level: the actual cookie written by Login/Logout -----------------

func sessionCookieFromRecorder(w *httptest.ResponseRecorder) *http.Cookie {
	for _, c := range w.Result().Cookies() {
		if c.Name == "session" {
			return c
		}
	}
	return nil
}

func TestLogin_CookieNotSecureOverPlainHTTP(t *testing.T) {
	t.Setenv(middleware.EnvDevMode, "1")
	cfg := credsTestCfg()
	h := NewAuthHandlerWithCreds(cfg, userauth.NewNullStore())

	r := gin.New()
	r.POST("/auth/login", h.Login)
	w := doReq(r, http.MethodPost, "/auth/login", map[string]string{
		"account_id": "solo", "password": cfg.Auth.Password,
	})
	if w.Code != http.StatusOK {
		t.Fatalf("login: expected 200, got %d", w.Code)
	}
	ck := sessionCookieFromRecorder(w)
	if ck == nil {
		t.Fatal("expected a session cookie")
	}
	if ck.Secure {
		t.Error("session cookie must not be Secure over a plain-HTTP request (no TLS, no X-Forwarded-Proto)")
	}
	if !ck.HttpOnly {
		t.Error("session cookie must remain HttpOnly")
	}
}

func TestLogin_CookieSecureBehindHTTPSProxy(t *testing.T) {
	t.Setenv(middleware.EnvDevMode, "1")
	cfg := credsTestCfg()
	h := NewAuthHandlerWithCreds(cfg, userauth.NewNullStore())

	r := gin.New()
	r.POST("/auth/login", h.Login)

	var buf bytes.Buffer
	_ = json.NewEncoder(&buf).Encode(map[string]string{
		"account_id": "solo", "password": cfg.Auth.Password,
	})
	req := httptest.NewRequest(http.MethodPost, "/auth/login", &buf)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Forwarded-Proto", "https")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("login: expected 200, got %d", w.Code)
	}
	ck := sessionCookieFromRecorder(w)
	if ck == nil {
		t.Fatal("expected a session cookie")
	}
	if !ck.Secure {
		t.Error("session cookie must be Secure when the request arrived via X-Forwarded-Proto: https")
	}
}

func TestLogout_CookieSecureMatchesRequest(t *testing.T) {
	h := NewAuthHandlerWithCreds(credsTestCfg(), userauth.NewNullStore())
	r := gin.New()
	r.POST("/auth/logout", h.Logout)

	req := httptest.NewRequest(http.MethodPost, "/auth/logout", nil)
	req.Header.Set("X-Forwarded-Proto", "https")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	ck := sessionCookieFromRecorder(w)
	if ck == nil {
		t.Fatal("expected a cleared session cookie")
	}
	if !ck.Secure {
		t.Error("logout's clearing cookie should also be Secure behind an HTTPS proxy")
	}
}
