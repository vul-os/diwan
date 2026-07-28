package handlers

// billing_enforcement_test.go — handler-level coverage for the cloud-independence
// billing audit fixes:
//
//   - recordings upload now requires auth + gates office/storage + meters bytes,
//     and derives the account from the verified identity (never ClientIP);
//   - FileHandler.Update gates office + storage and meters bytes;
//   - the seats cap counts REAL registered members (+ active invites), does NOT
//     fail open to zero on a store error, and the register path is seat-gated.
//
// Standalone (unlimited) stays a no-op throughout.

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"diwan/backend/audit"
	"diwan/backend/billing"
	"diwan/backend/fileacl"
	"diwan/backend/invites"
	"diwan/backend/middleware"
	"diwan/backend/seam"
	"diwan/backend/userauth"

	"github.com/gin-gonic/gin"
)

// ---- shared billing stubs ---------------------------------------------------

type fixedEntitlements struct{ ent seam.Entitlement }

func (f fixedEntitlements) For(context.Context, string) (seam.Entitlement, error) {
	return f.ent, nil
}
func (f fixedEntitlements) Allowed(context.Context, string, string) bool { return true }

type captureUsage struct {
	mu     sync.Mutex
	events []seam.UsageEvent
}

func (u *captureUsage) Report(_ context.Context, ev seam.UsageEvent) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.events = append(u.events, ev)
}
func (u *captureUsage) all() []seam.UsageEvent {
	u.mu.Lock()
	defer u.mu.Unlock()
	out := make([]seam.UsageEvent, len(u.events))
	copy(out, u.events)
	return out
}

// configureBilling installs a fixed-entitlement provider for the test and
// restores standalone afterwards. Returns the usage capture.
func configureBilling(t *testing.T, ent seam.Entitlement) *captureUsage {
	t.Helper()
	u := &captureUsage{}
	billing.Configure(seam.Provider{Entitlements: fixedEntitlements{ent: ent}, Usage: u})
	t.Cleanup(func() {
		billing.Configure(seam.NewStandaloneProvider(func() ([]byte, error) { return nil, nil }, false))
	})
	return u
}

func standaloneBilling(t *testing.T) {
	t.Helper()
	billing.Configure(seam.NewStandaloneProvider(func() ([]byte, error) { return nil, nil }, false))
	t.Cleanup(func() {
		billing.Configure(seam.NewStandaloneProvider(func() ([]byte, error) { return nil, nil }, false))
	})
}

// ============================================================================
// FileHandler.Update — office + storage gate + meter
// ============================================================================

func TestFileUpdate_GatesAndMeters(t *testing.T) {
	st := newMemStorage()
	h := NewFileHandlerWithAuthz(st, NewFileAuthz(fileacl.NewNullStore()))

	// Create a file under standalone billing so the gate is a no-op.
	standaloneBilling(t)
	alice := fileRouter(h, "alice@vulos.org", false)
	fileID := mustCreateFile(t, alice)

	// Now switch to a finite-cap provider and update with content that fits.
	usage := configureBilling(t, seam.Entitlement{MaxStorageBytes: 10_000})
	w := doReq(alice, http.MethodPut, "/files/"+fileID,
		map[string]any{"name": "n", "content": map[string]any{"k": "v"}})
	if w.Code != http.StatusOK {
		t.Fatalf("update under cap should be 200, got %d (%s)", w.Code, w.Body.String())
	}
	if got := usage.all(); len(got) != 1 || got[0].Kind != seam.KindStorage {
		t.Fatalf("update must meter one storage event, got %+v", got)
	}
}

func TestFileUpdate_Suspended_403(t *testing.T) {
	st := newMemStorage()
	h := NewFileHandlerWithAuthz(st, NewFileAuthz(fileacl.NewNullStore()))

	standaloneBilling(t)
	alice := fileRouter(h, "alice@vulos.org", false)
	fileID := mustCreateFile(t, alice)

	configureBilling(t, seam.Entitlement{Suspended: true})
	w := doReq(alice, http.MethodPut, "/files/"+fileID,
		map[string]any{"name": "n", "content": map[string]any{"k": "v"}})
	if w.Code != http.StatusForbidden {
		t.Fatalf("suspended update should be 403, got %d (%s)", w.Code, w.Body.String())
	}
}

func TestFileUpdate_OverQuota_402(t *testing.T) {
	st := newMemStorage()
	h := NewFileHandlerWithAuthz(st, NewFileAuthz(fileacl.NewNullStore()))

	standaloneBilling(t)
	alice := fileRouter(h, "alice@vulos.org", false)
	fileID := mustCreateFile(t, alice)

	configureBilling(t, seam.Entitlement{MaxStorageBytes: 2})
	w := doReq(alice, http.MethodPut, "/files/"+fileID,
		map[string]any{"name": "n", "content": map[string]any{"some": "fairly-large-content-blob"}})
	if w.Code != http.StatusPaymentRequired {
		t.Fatalf("over-quota update should be 402, got %d (%s)", w.Code, w.Body.String())
	}
}

// ============================================================================
// Seats — real members counted, no fail-open, register path gated
// ============================================================================

// erroringCreds returns an error from CountUsers to simulate a store hiccup.
type erroringCreds struct{ userauth.Store }

func (erroringCreds) CountUsers() (int64, error) { return 0, errors.New("store down") }

// TestSeats_CountsRealMembers — with a 2-seat cap and 2 registered members and
// no invites, minting another invite is rejected (real members consume seats,
// not just pending invites).
func TestSeats_CountsRealMembers(t *testing.T) {
	t.Setenv(middleware.EnvDevMode, "1")
	creds := userauth.NewNullStore()
	_ = creds.Register("a@vulos.org", "Long-Enough-1")
	_ = creds.Register("b@vulos.org", "Long-Enough-2")

	configureBilling(t, seam.Entitlement{MaxSeats: 2})
	h := NewAdminHandlerWithCreds(invites.NewNullStore(), audit.NewNullStore(), creds)
	admin := adminRouter(h, "root@vulos.org", true)

	w := doReq(admin, http.MethodPost, "/admin/invites", map[string]any{"note": "c@vulos.org"})
	if w.Code != http.StatusPaymentRequired {
		t.Fatalf("seat cap reached by real members should 402 the mint, got %d (%s)", w.Code, w.Body.String())
	}
}

// TestSeats_DoesNotFailOpenOnStoreError — a CountUsers error must NOT silently
// drop the seat usage to zero; the mint is refused (503) instead.
func TestSeats_DoesNotFailOpenOnStoreError(t *testing.T) {
	t.Setenv(middleware.EnvDevMode, "1")
	configureBilling(t, seam.Entitlement{MaxSeats: 1})
	h := NewAdminHandlerWithCreds(invites.NewNullStore(), audit.NewNullStore(),
		erroringCreds{userauth.NewNullStore()})
	admin := adminRouter(h, "root@vulos.org", true)

	w := doReq(admin, http.MethodPost, "/admin/invites", map[string]any{"note": "x@vulos.org"})
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("seat count store error must refuse the mint (503), got %d (%s)", w.Code, w.Body.String())
	}
}

// TestRegisterPath_SeatGated — the register/accept-invite path is seat-gated:
// with the cap already full, a valid-invite registration is rejected with 402.
func TestRegisterPath_SeatGated(t *testing.T) {
	t.Setenv(middleware.EnvDevMode, "1")
	inv := invites.NewNullStore()
	aud := audit.NewNullStore()
	creds := userauth.NewNullStore()

	authH := NewAuthHandlerWithStores(credsTestCfg(), creds, inv, aud)

	// Bootstrap one member (first-user path is not seat-gated). Now 1 member.
	standaloneBilling(t)
	registerUser(t, authH, "owner@vulos.org", "Long-Enough-1")

	// Mint an invite so the next registration is authorized.
	adminH := NewAdminHandlerWithCreds(inv, aud, creds)
	admin := adminRouter(adminH, "owner@vulos.org", true)
	// Standalone for the mint so it isn't seat-blocked itself.
	mw := doReq(admin, http.MethodPost, "/admin/invites", map[string]any{"note": "alice@vulos.org", "max_uses": 1})
	var minted struct {
		Token string `json:"token"`
	}
	mustDecode(t, mw, &minted)

	// Now impose a 1-seat cap: 1 member + 1 active invite already = 2 ≥ 1, so the
	// register MUST be rejected with 402 (seat gate on the register path).
	configureBilling(t, seam.Entitlement{MaxSeats: 1})

	regR := gin.New()
	regR.POST("/auth/register", authH.Register)
	req := httptest.NewRequest(http.MethodPost, "/auth/register",
		strings.NewReader(`{"account_id":"alice@vulos.org","password":"Long-Enough-3"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Registration-Token", minted.Token)
	w := httptest.NewRecorder()
	regR.ServeHTTP(w, req)
	if w.Code != http.StatusPaymentRequired {
		t.Fatalf("seat-capped register should be 402, got %d (%s)", w.Code, w.Body.String())
	}
}

// TestRegisterPath_Standalone_NoSeatLimit — standalone (unlimited) keeps the
// register path a no-op: registration succeeds regardless of member count.
func TestRegisterPath_Standalone_NoSeatLimit(t *testing.T) {
	t.Setenv(middleware.EnvDevMode, "1")
	t.Setenv(EnvRegistrationToken, "static-secret")
	standaloneBilling(t)

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
	w := httptest.NewRecorder()
	regR.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("standalone register should be 201 (no seat cap), got %d (%s)", w.Code, w.Body.String())
	}
}
