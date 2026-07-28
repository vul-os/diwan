package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"diwan/backend/config"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
)

func init() { gin.SetMode(gin.TestMode) }

// withEnv sets env vars for the duration of the test and resets the cached
// secret so JWTSecret re-reads them.
func withEnv(t *testing.T, kv map[string]string) {
	t.Helper()
	for k, v := range kv {
		t.Setenv(k, v)
	}
	resetSecretCacheForTest()
	t.Cleanup(resetSecretCacheForTest)
}

func TestJWTSecretFailsClosedWhenUnset(t *testing.T) {
	// Neither the secret nor dev mode is set → must fail closed.
	withEnv(t, map[string]string{EnvJWTSecret: "", EnvDevMode: ""})
	if _, err := JWTSecret(); err == nil {
		t.Fatal("expected JWTSecret to return an error when unset in production mode")
	}
	if JWTSecretConfigured() {
		t.Fatal("expected JWTSecretConfigured() == false when unset")
	}
}

func TestJWTSecretDevFallback(t *testing.T) {
	withEnv(t, map[string]string{EnvJWTSecret: "", EnvDevMode: "1"})
	got, err := JWTSecret()
	if err != nil {
		t.Fatalf("expected dev fallback secret, got error: %v", err)
	}
	if string(got) != devSecret {
		t.Fatalf("expected dev secret, got %q", got)
	}
}

func TestJWTSecretFromEnv(t *testing.T) {
	withEnv(t, map[string]string{EnvJWTSecret: "super-secret-value"})
	got, err := JWTSecret()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if string(got) != "super-secret-value" {
		t.Fatalf("got %q", got)
	}
}

// mintToken signs a token with the given secret and subject.
func mintToken(t *testing.T, secret, subject string, audience ...string) string {
	t.Helper()
	claims := jwt.RegisteredClaims{
		Subject:   subject,
		Audience:  audience,
		ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
		IssuedAt:  jwt.NewNumericDate(time.Now()),
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := tok.SignedString([]byte(secret))
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return signed
}

// runAuth runs the Auth middleware against a request carrying the given bearer
// token and returns the recorded status plus the captured userID/isAdmin.
func runAuth(secretEnv, devEnv, bearer string) (int, string, bool) {
	cfg := &config.Config{}
	cfg.Auth.Enabled = true

	var capturedUID string
	var capturedAdmin bool

	r := gin.New()
	r.Use(Auth(cfg))
	r.GET("/x", func(c *gin.Context) {
		capturedUID = c.GetString(CtxUserID)
		capturedAdmin = c.GetBool(CtxIsAdmin)
		c.Status(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w.Code, capturedUID, capturedAdmin
}

func TestAuthRejectsTokensWhenSecretUnset(t *testing.T) {
	// Mint a token with some key, then run Auth with NO secret configured.
	bearer := mintToken(t, "any-key", "alice")
	withEnv(t, map[string]string{EnvJWTSecret: "", EnvDevMode: ""})
	code, uid, _ := runAuth("", "", bearer)
	if code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 when secret unset, got %d", code)
	}
	if uid != "" {
		t.Fatalf("expected no identity set, got %q", uid)
	}
}

func TestAuthSetsIdentityFromJWTSubject(t *testing.T) {
	withEnv(t, map[string]string{EnvJWTSecret: "test-secret"})
	bearer := mintToken(t, "test-secret", "alice")
	code, uid, admin := runAuth("test-secret", "", bearer)
	if code != http.StatusOK {
		t.Fatalf("expected 200, got %d", code)
	}
	if uid != "alice" {
		t.Fatalf("expected userID 'alice' from JWT subject, got %q", uid)
	}
	if admin {
		t.Fatal("expected non-admin")
	}
}

func TestAuthRejectsTokenSignedWithWrongSecret(t *testing.T) {
	withEnv(t, map[string]string{EnvJWTSecret: "the-real-secret"})
	bearer := mintToken(t, "attacker-secret", "mallory")
	code, _, _ := runAuth("the-real-secret", "", bearer)
	if code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for wrong-secret token, got %d", code)
	}
}

func TestAuthAdminScopeFromAudience(t *testing.T) {
	withEnv(t, map[string]string{EnvJWTSecret: "test-secret"})
	bearer := mintToken(t, "test-secret", "root", "vulos:admin")
	code, uid, admin := runAuth("test-secret", "", bearer)
	if code != http.StatusOK {
		t.Fatalf("expected 200, got %d", code)
	}
	if uid != "root" || !admin {
		t.Fatalf("expected admin root, got uid=%q admin=%v", uid, admin)
	}
}
