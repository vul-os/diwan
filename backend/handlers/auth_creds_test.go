package handlers

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"diwan/backend/config"
	"diwan/backend/middleware"
	"diwan/backend/userauth"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
)

// credsTestCfg returns an auth-enabled config with a shared password fallback.
func credsTestCfg() *config.Config {
	cfg := config.Default()
	cfg.Auth.Enabled = true
	cfg.Auth.Password = "shared-secret"
	cfg.Auth.MaxAttempts = 5
	cfg.Auth.LockoutMinutes = 15
	cfg.Auth.SessionHours = 24
	return cfg
}

// loginAndExtractSubject performs a login and returns (status, jwtSubject). The
// JWT lands in the session cookie; we verify + decode it to read the subject.
func loginAndExtractSubject(t *testing.T, h *AuthHandler, body map[string]string) (int, string) {
	t.Helper()
	r := gin.New()
	r.POST("/auth/login", h.Login)
	w := doReq(r, http.MethodPost, "/auth/login", body)

	if w.Code != http.StatusOK {
		return w.Code, ""
	}
	// Extract the session cookie.
	var token string
	for _, c := range w.Result().Cookies() {
		if c.Name == "session" {
			token = c.Value
		}
	}
	if token == "" {
		t.Fatal("login succeeded but no session cookie was set")
	}
	secret, err := middleware.JWTSecret()
	if err != nil {
		t.Fatalf("jwt secret: %v", err)
	}
	claims := &jwt.RegisteredClaims{}
	parsed, err := jwt.ParseWithClaims(token, claims, func(tok *jwt.Token) (interface{}, error) {
		return secret, nil
	})
	if err != nil || !parsed.Valid {
		t.Fatalf("parse jwt: %v", err)
	}
	return w.Code, claims.Subject
}

func registerUser(t *testing.T, h *AuthHandler, accountID, password string) {
	t.Helper()
	r := gin.New()
	r.POST("/auth/register", h.Register)
	w := doReq(r, http.MethodPost, "/auth/register", map[string]string{"account_id": accountID, "password": password})
	if w.Code != http.StatusCreated {
		t.Fatalf("register %s: expected 201, got %d (%s)", accountID, w.Code, w.Body.String())
	}
}

// TestPerUserLoginBindsSubjectToVerifiedUser proves that, once a user is
// registered, the JWT subject is the canonical account id from the credential
// store — NOT a self-asserted account id from the request body.
func TestPerUserLoginBindsSubjectToVerifiedUser(t *testing.T) {
	t.Setenv(middleware.EnvDevMode, "1") // give JWTSecret a usable dev key
	h := NewAuthHandlerWithCreds(credsTestCfg(), userauth.NewNullStore())
	registerUser(t, h, "alice@vulos.org", "correct-horse")

	// Correct credentials: subject must be the registered (normalized) account.
	code, sub := loginAndExtractSubject(t, h, map[string]string{
		"account_id": "Alice@Vulos.org", // different case — should normalize
		"password":   "correct-horse",
	})
	if code != http.StatusOK {
		t.Fatalf("login with correct creds: expected 200, got %d", code)
	}
	if sub != "alice@vulos.org" {
		t.Fatalf("JWT subject should be the verified account; got %q", sub)
	}
}

// TestPerUserLoginRejectsWrongPassword proves wrong credentials are rejected and
// cannot mint a session.
func TestPerUserLoginRejectsWrongPassword(t *testing.T) {
	t.Setenv(middleware.EnvDevMode, "1")
	h := NewAuthHandlerWithCreds(credsTestCfg(), userauth.NewNullStore())
	registerUser(t, h, "alice@vulos.org", "correct-horse")

	r := gin.New()
	r.POST("/auth/login", h.Login)

	// Wrong password for a real account.
	if w := doReq(r, http.MethodPost, "/auth/login", map[string]string{
		"account_id": "alice@vulos.org", "password": "guess",
	}); w.Code != http.StatusUnauthorized {
		t.Fatalf("wrong password: expected 401, got %d (%s)", w.Code, w.Body.String())
	}
}

// TestSelfAssertedIdentityRejectedOnceUsersExist is the core P1 proof: when a
// credential store has users, an attacker cannot log in as someone else by
// asserting their account id with the legacy shared password.
func TestSelfAssertedIdentityRejectedOnceUsersExist(t *testing.T) {
	t.Setenv(middleware.EnvDevMode, "1")
	cfg := credsTestCfg()
	h := NewAuthHandlerWithCreds(cfg, userauth.NewNullStore())
	registerUser(t, h, "alice@vulos.org", "correct-horse")

	r := gin.New()
	r.POST("/auth/login", h.Login)

	// Mallory claims to be alice but supplies the SHARED password (which used to
	// work) instead of alice's real credential. This MUST be rejected now.
	if w := doReq(r, http.MethodPost, "/auth/login", map[string]string{
		"account_id": "alice@vulos.org", "password": cfg.Auth.Password,
	}); w.Code == http.StatusOK {
		t.Fatal("shared password must NOT authenticate a registered account — self-asserted identity hole still open")
	}
}

// TestSharedPasswordFallbackWhenNoUsers proves OSS single-user mode still works:
// with no registered users, the shared password authenticates and the subject is
// the supplied account id (acceptable — no multi-user store to protect).
func TestSharedPasswordFallbackWhenNoUsers(t *testing.T) {
	t.Setenv(middleware.EnvDevMode, "1")
	cfg := credsTestCfg()
	h := NewAuthHandlerWithCreds(cfg, userauth.NewNullStore())

	code, sub := loginAndExtractSubject(t, h, map[string]string{
		"account_id": "solo", "password": cfg.Auth.Password,
	})
	if code != http.StatusOK {
		t.Fatalf("shared-password fallback: expected 200, got %d", code)
	}
	if sub != "solo" {
		t.Fatalf("fallback subject should be the supplied account id; got %q", sub)
	}
}

// TestRegisterRejectsDuplicateAndShortPassword covers registration validation.
func TestRegisterRejectsDuplicateAndShortPassword(t *testing.T) {
	// Configure an invite token so the post-bootstrap duplicate attempt reaches
	// the credential layer (otherwise a bootstrapped instance with no token is
	// CLOSED — see TestPentest_Creds_RegistrationClosedOnceBootstrapped).
	t.Setenv(EnvRegistrationToken, "invite-secret")
	h := NewAuthHandlerWithCreds(credsTestCfg(), userauth.NewNullStore())
	r := gin.New()
	r.POST("/auth/register", h.Register)

	// Short password rejected (policy is checked before any auth/bootstrap gate).
	if w := doReq(r, http.MethodPost, "/auth/register", map[string]string{
		"account_id": "x@vulos.org", "password": "short",
	}); w.Code != http.StatusBadRequest {
		t.Fatalf("short password: expected 400, got %d", w.Code)
	}

	// First real registration succeeds via atomic bootstrap (password meets the
	// policy: ≥10 chars, ≥2 character classes).
	if w := doReq(r, http.MethodPost, "/auth/register", map[string]string{
		"account_id": "x@vulos.org", "password": "Long-Enough-1",
	}); w.Code != http.StatusCreated {
		t.Fatalf("first register: expected 201, got %d", w.Code)
	}
	// Duplicate rejected: re-register the same id WITH a valid invite token so
	// the request reaches the duplicate check and returns 409 (no takeover).
	req := httptest.NewRequest(http.MethodPost, "/auth/register",
		strings.NewReader(`{"account_id":"x@vulos.org","password":"Long-Enough-2"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Registration-Token", "invite-secret")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusConflict {
		t.Fatalf("duplicate register: expected 409, got %d (%s)", w.Code, w.Body.String())
	}
}

// sanity: ensure httptest + strings stay imported across refactors.
var _ = httptest.NewRecorder
var _ = strings.TrimSpace
