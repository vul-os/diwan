package handlers

// invites_handler_test.go — admin invite issuance + registration consumption +
// audit-record coverage.

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"diwan/backend/audit"
	"diwan/backend/config"
	"diwan/backend/fileacl"
	"diwan/backend/invites"
	"diwan/backend/middleware"
	"diwan/backend/userauth"

	"github.com/gin-gonic/gin"
)

// adminRouter wires the admin endpoints with a verified identity + admin flag.
func adminRouter(h *AdminHandler, user string, admin bool) *gin.Engine {
	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Set(middleware.CtxAuthenticated, true)
		c.Set(middleware.CtxUserID, user)
		if admin {
			c.Set(middleware.CtxIsAdmin, true)
		}
		c.Next()
	})
	r.POST("/admin/invites", h.MintInvite)
	r.GET("/admin/invites", h.ListInvites)
	r.DELETE("/admin/invites/:id", h.RevokeInvite)
	r.GET("/admin/audit", h.ListAudit)
	return r
}

// TestAdminMintRequiresAdmin — a non-admin caller is 403 on every admin route.
func TestAdminMintRequiresAdmin(t *testing.T) {
	h := NewAdminHandlerWith(invites.NewNullStore(), audit.NewNullStore())
	nonAdmin := adminRouter(h, "bob@vulos.org", false)

	if w := doReq(nonAdmin, http.MethodPost, "/admin/invites", map[string]any{"note": "x"}); w.Code != http.StatusForbidden {
		t.Fatalf("non-admin mint: expected 403, got %d", w.Code)
	}
	if w := doReq(nonAdmin, http.MethodGet, "/admin/invites", nil); w.Code != http.StatusForbidden {
		t.Fatalf("non-admin list: expected 403, got %d", w.Code)
	}
	if w := doReq(nonAdmin, http.MethodGet, "/admin/audit", nil); w.Code != http.StatusForbidden {
		t.Fatalf("non-admin audit: expected 403, got %d", w.Code)
	}
}

// TestInviteSingleUseRegistrationFlow — admin mints an invite, a stranger
// registers with it once (success), and a SECOND registration with the same
// token is rejected (single-use). The audit log records the mint, the consume,
// and the registration.
func TestInviteSingleUseRegistrationFlow(t *testing.T) {
	t.Setenv(middleware.EnvDevMode, "1")
	inv := invites.NewNullStore()
	aud := audit.NewNullStore()

	admin := adminRouter(NewAdminHandlerWith(inv, aud), "root@vulos.org", true)
	w := doReq(admin, http.MethodPost, "/admin/invites", map[string]any{"note": "alice@vulos.org", "max_uses": 1, "ttl_hours": 24})
	if w.Code != http.StatusCreated {
		t.Fatalf("mint: got %d (%s)", w.Code, w.Body.String())
	}
	var minted struct {
		Token  string         `json:"token"`
		Invite invites.Invite `json:"invite"`
	}
	mustDecode(t, w, &minted)
	if minted.Token == "" {
		t.Fatal("mint returned empty token")
	}

	// Bootstrap a first user so the instance is no longer in first-user mode.
	creds := userauth.NewNullStore()
	authH := NewAuthHandlerWithStores(credsTestCfg(), creds, inv, aud)
	registerUser(t, authH, "owner@vulos.org", "Long-Enough-1")

	regR := gin.New()
	regR.POST("/auth/register", authH.Register)

	// Register WITH the invite token → success.
	reg := func(token, account string) int {
		req := httptest.NewRequest(http.MethodPost, "/auth/register",
			strings.NewReader(`{"account_id":"`+account+`","password":"Long-Enough-2"}`))
		req.Header.Set("Content-Type", "application/json")
		if token != "" {
			req.Header.Set("X-Registration-Token", token)
		}
		w := httptest.NewRecorder()
		regR.ServeHTTP(w, req)
		return w.Code
	}

	if code := reg(minted.Token, "alice@vulos.org"); code != http.StatusCreated {
		t.Fatalf("invite register: expected 201, got %d", code)
	}
	// Second use of the same single-use token → rejected (401, token spent).
	if code := reg(minted.Token, "carol@vulos.org"); code == http.StatusCreated {
		t.Fatal("VULN: single-use invite token was redeemable twice")
	}

	// Audit log must contain mint + consume + register events.
	entries, _ := aud.List(0)
	var sawMint, sawConsume, sawRegister bool
	for _, e := range entries {
		switch e.Action {
		case audit.ActionInviteMint:
			sawMint = true
		case audit.ActionInviteConsume:
			sawConsume = true
		case audit.ActionRegister:
			if e.Target == "alice@vulos.org" {
				sawRegister = true
			}
		}
	}
	if !sawMint || !sawConsume || !sawRegister {
		t.Fatalf("audit missing events: mint=%v consume=%v register=%v", sawMint, sawConsume, sawRegister)
	}
}

// TestInviteRevokeBlocksRegistration — a revoked invite cannot be redeemed.
func TestInviteRevokeBlocksRegistration(t *testing.T) {
	t.Setenv(middleware.EnvDevMode, "1")
	inv := invites.NewNullStore()
	aud := audit.NewNullStore()

	admin := adminRouter(NewAdminHandlerWith(inv, aud), "root@vulos.org", true)
	w := doReq(admin, http.MethodPost, "/admin/invites", map[string]any{"max_uses": 5})
	var minted struct {
		Token  string         `json:"token"`
		Invite invites.Invite `json:"invite"`
	}
	mustDecode(t, w, &minted)

	// Revoke it.
	if w := doReq(admin, http.MethodDelete, "/admin/invites/"+minted.Invite.ID, nil); w.Code != http.StatusOK {
		t.Fatalf("revoke: got %d (%s)", w.Code, w.Body.String())
	}

	creds := userauth.NewNullStore()
	authH := NewAuthHandlerWithStores(credsTestCfg(), creds, inv, aud)
	registerUser(t, authH, "owner@vulos.org", "Long-Enough-1")

	regR := gin.New()
	regR.POST("/auth/register", authH.Register)
	req := httptest.NewRequest(http.MethodPost, "/auth/register",
		strings.NewReader(`{"account_id":"mallory@vulos.org","password":"Long-Enough-9"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Registration-Token", minted.Token)
	rec := httptest.NewRecorder()
	regR.ServeHTTP(rec, req)
	if rec.Code == http.StatusCreated {
		t.Fatal("VULN: a revoked invite token was accepted for registration")
	}
}

// TestStaticTokenStillWorks — the legacy static DIWAN_REGISTRATION_TOKEN
// path is preserved alongside invite tokens.
func TestStaticTokenStillWorks(t *testing.T) {
	t.Setenv(middleware.EnvDevMode, "1")
	t.Setenv(EnvRegistrationToken, "static-secret")
	inv := invites.NewNullStore()
	aud := audit.NewNullStore()
	creds := userauth.NewNullStore()
	authH := NewAuthHandlerWithStores(credsTestCfg(), creds, inv, aud)
	registerUser(t, authH, "owner@vulos.org", "Long-Enough-1")

	regR := gin.New()
	regR.POST("/auth/register", authH.Register)
	req := httptest.NewRequest(http.MethodPost, "/auth/register",
		strings.NewReader(`{"account_id":"new@vulos.org","password":"Long-Enough-3"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Registration-Token", "static-secret")
	rec := httptest.NewRecorder()
	regR.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("static-token register: expected 201, got %d (%s)", rec.Code, rec.Body.String())
	}
}

// TestFileShareRecordsACLAudit — granting/revoking file access appends an
// append-only audit entry that the admin audit endpoint surfaces.
func TestFileShareRecordsACLAudit(t *testing.T) {
	aud := audit.NewNullStore()
	st := newMemStorage()
	authz := NewFileAuthz(fileacl.NewNullStore())
	h := NewFileHandlerWithAudit(st, authz, aud)

	// alice creates a file and shares it with bob.
	alice := fileRouter(h, "alice@vulos.org", false)
	fileID := mustCreateFile(t, alice)
	w := doReq(alice, http.MethodPost, "/files/"+fileID+"/share",
		map[string]any{"account_id": "bob@vulos.org"})
	if w.Code != http.StatusOK {
		t.Fatalf("share: got %d (%s)", w.Code, w.Body.String())
	}
	// Revoke too.
	w = doReq(alice, http.MethodPost, "/files/"+fileID+"/share",
		map[string]any{"account_id": "bob@vulos.org", "revoke": true})
	if w.Code != http.StatusOK {
		t.Fatalf("revoke: got %d (%s)", w.Code, w.Body.String())
	}

	// Audit endpoint (admin) must show the grant + revoke.
	admin := adminRouter(NewAdminHandlerWith(invites.NewNullStore(), aud), "root@vulos.org", true)
	aw := doReq(admin, http.MethodGet, "/admin/audit", nil)
	if aw.Code != http.StatusOK {
		t.Fatalf("audit list: got %d", aw.Code)
	}
	var entries []audit.Entry
	mustDecode(t, aw, &entries)
	var grant, revoke bool
	for _, e := range entries {
		if e.Target == fileID && e.Action == audit.ActionACLGrant {
			grant = true
		}
		if e.Target == fileID && e.Action == audit.ActionACLRevoke {
			revoke = true
		}
	}
	if !grant || !revoke {
		t.Fatalf("audit missing ACL events: grant=%v revoke=%v", grant, revoke)
	}
}

var _ = config.Default
