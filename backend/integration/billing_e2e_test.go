// Package integration_test holds cross-product integration tests that wire the
// REAL cloud adapter (backend/integration/cloud) into the billing enforcement
// layer (backend/billing) and drive the gate→meter→suspension chain through the
// actual office handler paths.
//
// These tests complement the per-side httptest unit tests in
// backend/billing/enforce_test.go and backend/integration/cloud/cloud_test.go.
// They prove the full chain:
//
//	cp stub → cloud.NewProvider → billing.Configure → GateStorage/GateSeats/GateOffice → handler
//	                                                                                      ↓
//	                                                                          stub records /api/usage POST
//
// Test matrix:
//
//  1. EntitlementAllows: storage within cap → HTTP 200 from upload handler,
//     stub receives a {product:"office",kind:"storage"} usage POST with
//     X-Relay-Auth.
//  2. StorageOverCap: upload over max_storage_bytes → 402.
//  3. SuspendedBlocked: suspended entitlement → upload 402, invite mint 402,
//     office gate 403.
//  4. SeatOverLimit: mint invite when at full seats → 402; a successful mint
//     (seats under limit) → {kind:"seats"} usage POST reaches stub.
package integration_test

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"diwan/backend/audit"
	"diwan/backend/billing"
	"diwan/backend/config"
	"diwan/backend/handlers"
	"diwan/backend/integration/cloud"
	"diwan/backend/invites"
	"diwan/backend/middleware"
	"diwan/backend/seam"
	"diwan/backend/userauth"

	"github.com/gin-gonic/gin"
)

// ---- CP stub -----------------------------------------------------------------

// cpRequest records a single call the real cloud adapter made to the stub.
type cpRequest struct {
	Method string
	Path   string
	Auth   string // X-Relay-Auth header value
	Body   []byte // raw body (for POSTs)
}

// cpStub serves a minimal control-plane API that the cloud adapter calls.
//
// The entitlement served is controlled per-test via the ent field. Usage POSTs
// are recorded in reqs so assertions can inspect them.
type cpStub struct {
	mu   sync.Mutex
	ent  map[string]interface{} // JSON-serialisable entitlement fields
	reqs []cpRequest
}

func newCPStub(ent map[string]interface{}) *cpStub {
	return &cpStub{ent: ent}
}

// recorded returns a snapshot of all requests the stub has received so far.
func (s *cpStub) recorded() []cpRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]cpRequest, len(s.reqs))
	copy(out, s.reqs)
	return out
}

// usagePosts returns only the /api/usage POST calls.
func (s *cpStub) usagePosts() []cpRequest {
	var out []cpRequest
	for _, r := range s.recorded() {
		if r.Method == http.MethodPost && r.Path == "/api/usage" {
			out = append(out, r)
		}
	}
	return out
}

func (s *cpStub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Record the request.
	body, _ := io.ReadAll(r.Body)
	s.mu.Lock()
	s.reqs = append(s.reqs, cpRequest{
		Method: r.Method,
		Path:   r.URL.Path,
		Auth:   r.Header.Get(cloud.HeaderRelayAuth),
		Body:   body,
	})
	s.mu.Unlock()

	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/api/entitlements":
		// GET /api/entitlements?account_id=...&product=office
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(s.ent)

	case r.Method == http.MethodPost && r.URL.Path == "/api/usage":
		w.WriteHeader(http.StatusAccepted)

	default:
		http.NotFound(w, r)
	}
}

// ---- provider wiring helpers -------------------------------------------------

const (
	cpToken   = "relay-secret-xyz"
	testAcct  = "alice@vulos.org"
	testAdmin = "admin@vulos.org"
)

// wireCloudProvider builds a real cloud.Provider pointed at stub and installs
// it via billing.Configure. Restores standalone billing on t.Cleanup.
func wireCloudProvider(t *testing.T, stub *httptest.Server) {
	t.Helper()
	cfg := cloud.Config{
		BaseURL: stub.URL,
		Token:   cpToken,
	}
	// Identity: local single-user (no real JWT needed for handler injection tests).
	identity := seam.NewLocalIdentity(func() ([]byte, error) { return nil, nil }, false)
	prov := cloud.NewProvider(cfg, identity)
	billing.Configure(prov)
	t.Cleanup(func() {
		billing.Configure(seam.NewStandaloneProvider(func() ([]byte, error) { return nil, nil }, false))
	})
}

// ---- upload handler helpers --------------------------------------------------

// uploadRouter builds a minimal gin router with the upload handler and an
// injected verified identity (mirrors the protected route group in main.go).
func uploadRouter(t *testing.T, user string) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	h := handlers.NewUploadHandler(&config.Config{
		Server: config.ServerConfig{UploadsDir: t.TempDir()},
	})
	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Set(middleware.CtxAuthenticated, true)
		c.Set(middleware.CtxUserID, user)
		c.Next()
	})
	r.POST("/upload", h.Upload)
	return r
}

// pngUpload builds an httptest.Request that uploads a PNG via multipart.
func pngUpload(t *testing.T, payload []byte) *http.Request {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	hdr := make(map[string][]string)
	hdr["Content-Disposition"] = []string{`form-data; name="file"; filename="img.png"`}
	hdr["Content-Type"] = []string{"image/png"}
	part, err := mw.CreatePart(hdr)
	if err != nil {
		t.Fatalf("pngUpload: CreatePart: %v", err)
	}
	// The upload handler sniffs the bytes (it no longer trusts the multipart
	// Content-Type header), so prepend the PNG signature to be classified as
	// image/png.
	pngMagic := []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A}
	_, _ = part.Write(append(append([]byte{}, pngMagic...), payload...))
	mw.Close()
	req := httptest.NewRequest(http.MethodPost, "/upload", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	return req
}

// ---- admin/invite handler helpers -------------------------------------------

// adminRouter wires the admin invite handler with a verified admin identity.
func adminRouter(h *handlers.AdminHandler, user string) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Set(middleware.CtxAuthenticated, true)
		c.Set(middleware.CtxUserID, user)
		c.Set(middleware.CtxIsAdmin, true)
		c.Next()
	})
	r.POST("/admin/invites", h.MintInvite)
	return r
}

// doJSON fires a POST with a JSON body and returns the recorded response.
func doJSON(router *gin.Engine, path string, body interface{}) *httptest.ResponseRecorder {
	raw, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	return w
}

// usageBodyDecoded parses a /api/usage POST body into a map.
func usageBodyDecoded(t *testing.T, req cpRequest) map[string]interface{} {
	t.Helper()
	var m map[string]interface{}
	if err := json.Unmarshal(req.Body, &m); err != nil {
		t.Fatalf("usage body decode: %v (body=%q)", err, req.Body)
	}
	return m
}

// waitForUsage polls the stub for at least n usage POSTs for up to ~250 ms.
// The cloud adapter fires usage fire-and-forget (no blocking), so we allow a
// brief window for the goroutine to complete.
func waitForUsage(stub *cpStub, n int) {
	deadline := time.Now().Add(250 * time.Millisecond)
	for time.Now().Before(deadline) {
		if len(stub.usagePosts()) >= n {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// ============================================================================
// Test 1 – EntitlementAllows
// max_storage_bytes set, max_seats set, features.office=true, NOT suspended →
// upload within cap succeeds (200) AND a {product:office,kind:storage} usage
// POST with X-Relay-Auth reaches the stub.
// ============================================================================

func TestBillingE2E_EntitlementAllows_UploadSucceeds(t *testing.T) {
	stub := newCPStub(map[string]interface{}{
		"tier":              "pro",
		"suspended":         false,
		"max_storage_bytes": 10_000_000, // 10 MB
		"max_seats":         10,
		"features":          map[string]bool{"office": true},
	})
	srv := httptest.NewServer(stub)
	defer srv.Close()
	wireCloudProvider(t, srv)

	router := uploadRouter(t, testAcct)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, pngUpload(t, []byte("hello-cloud-billing")))
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 from upload within cap, got %d (%s)", w.Code, w.Body.String())
	}

	// Wait for the fire-and-forget usage POST to arrive.
	waitForUsage(stub, 1)
	posts := stub.usagePosts()
	if len(posts) < 1 {
		t.Fatalf("expected at least 1 usage POST to stub, got %d", len(posts))
	}
	u := usageBodyDecoded(t, posts[0])
	if u["product"] != "office" {
		t.Errorf("usage product: want %q, got %q", "office", u["product"])
	}
	if u["kind"] != seam.KindStorage {
		t.Errorf("usage kind: want %q, got %q", seam.KindStorage, u["kind"])
	}
	if posts[0].Auth != cpToken {
		t.Errorf("X-Relay-Auth: want %q, got %q", cpToken, posts[0].Auth)
	}
	// Bytes must be positive (the actual payload size).
	if b, _ := u["bytes"].(float64); b <= 0 {
		t.Errorf("usage bytes should be positive, got %v", b)
	}
	// account_id must match the verified identity, NOT a forgeable header.
	if u["account_id"] != testAcct {
		t.Errorf("usage account_id: want %q, got %q", testAcct, u["account_id"])
	}
}

// ============================================================================
// Test 2 – StorageOverCap
// Upload over max_storage_bytes → 402, no usage POST.
// ============================================================================

func TestBillingE2E_StorageOverCap_402(t *testing.T) {
	stub := newCPStub(map[string]interface{}{
		"suspended":         false,
		"max_storage_bytes": 4, // 4 bytes — our payload will exceed this
		"max_seats":         10,
	})
	srv := httptest.NewServer(stub)
	defer srv.Close()
	wireCloudProvider(t, srv)

	router := uploadRouter(t, testAcct)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, pngUpload(t, []byte("this is definitely more than four bytes")))
	if w.Code != http.StatusPaymentRequired {
		t.Fatalf("expected 402 for over-cap upload, got %d (%s)", w.Code, w.Body.String())
	}

	// No usage POST should have been fired for a rejected write.
	// Give the fire-and-forget a brief window just in case.
	time.Sleep(30 * time.Millisecond)
	if got := len(stub.usagePosts()); got != 0 {
		t.Errorf("rejected upload must not emit any usage POST, got %d", got)
	}
}

// ============================================================================
// Test 3 – SuspendedBlocked
// Suspended entitlement → upload 402, invite mint 402, office gate 403.
// ============================================================================

func TestBillingE2E_SuspendedBlocked(t *testing.T) {
	stub := newCPStub(map[string]interface{}{
		"suspended":         true,
		"max_storage_bytes": 10_000_000,
		"max_seats":         10,
		"features":          map[string]bool{"office": true},
	})
	srv := httptest.NewServer(stub)
	defer srv.Close()
	wireCloudProvider(t, srv)

	// 3a. Storage gate (upload handler) → 402 (suspended).
	router := uploadRouter(t, testAcct)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, pngUpload(t, []byte("x")))
	if w.Code != http.StatusPaymentRequired {
		t.Fatalf("suspended upload should be 402, got %d (%s)", w.Code, w.Body.String())
	}

	// 3b. Seats gate (invite mint) → 402 (suspended).
	adminH := handlers.NewAdminHandlerWithCreds(
		invites.NewNullStore(),
		audit.NewNullStore(),
		userauth.NewNullStore(),
	)
	admin := adminRouter(adminH, testAdmin)
	wInvite := doJSON(admin, "/admin/invites", map[string]any{"note": "bob@vulos.org"})
	if wInvite.Code != http.StatusPaymentRequired {
		t.Fatalf("suspended invite mint should be 402, got %d (%s)", wInvite.Code, wInvite.Body.String())
	}

	// 3c. GateOffice directly → 403 (suspended).
	d := billing.GateOffice(t.Context(), testAcct)
	if d.Code != http.StatusForbidden {
		t.Fatalf("suspended GateOffice should be 403, got %+v", d)
	}
}

// ============================================================================
// Test 4 – SeatOverLimit / SeatAllowed
// 4a. Mint invite when at full seats → 402.
// 4b. Successful mint (under limit) → {kind:"seats"} usage POST reaches stub.
// ============================================================================

func TestBillingE2E_SeatOverLimit_402(t *testing.T) {
	// 2 seats capacity, 2 already registered → next invite must fail.
	stub := newCPStub(map[string]interface{}{
		"suspended":         false,
		"max_storage_bytes": 10_000_000,
		"max_seats":         2,
	})
	srv := httptest.NewServer(stub)
	defer srv.Close()
	wireCloudProvider(t, srv)

	creds := userauth.NewNullStore()
	_ = creds.Register("seat1@vulos.org", "Long-Enough-1")
	_ = creds.Register("seat2@vulos.org", "Long-Enough-2")

	adminH := handlers.NewAdminHandlerWithCreds(
		invites.NewNullStore(),
		audit.NewNullStore(),
		creds,
	)
	admin := adminRouter(adminH, testAdmin)
	w := doJSON(admin, "/admin/invites", map[string]any{"note": "seat3@vulos.org"})
	if w.Code != http.StatusPaymentRequired {
		t.Fatalf("seat-capped invite mint should be 402, got %d (%s)", w.Code, w.Body.String())
	}
}

func TestBillingE2E_SeatAllowed_MeterReachesStub(t *testing.T) {
	// 5 seats capacity, 0 registered → invite should succeed + emit seats usage.
	stub := newCPStub(map[string]interface{}{
		"suspended":         false,
		"max_storage_bytes": 10_000_000,
		"max_seats":         5,
	})
	srv := httptest.NewServer(stub)
	defer srv.Close()
	wireCloudProvider(t, srv)

	adminH := handlers.NewAdminHandlerWithCreds(
		invites.NewNullStore(),
		audit.NewNullStore(),
		userauth.NewNullStore(), // 0 registered members
	)
	admin := adminRouter(adminH, testAdmin)
	w := doJSON(admin, "/admin/invites", map[string]any{"note": "newbie@vulos.org"})
	if w.Code != http.StatusCreated {
		t.Fatalf("under-cap invite mint should be 201, got %d (%s)", w.Code, w.Body.String())
	}

	// Wait for the fire-and-forget seats usage POST.
	waitForUsage(stub, 1)
	posts := stub.usagePosts()
	if len(posts) < 1 {
		t.Fatalf("expected seats usage POST to stub, got %d", len(posts))
	}
	u := usageBodyDecoded(t, posts[0])
	if u["product"] != "office" {
		t.Errorf("seats usage product: want %q, got %q", "office", u["product"])
	}
	if u["kind"] != seam.KindSeats {
		t.Errorf("seats usage kind: want %q, got %q", seam.KindSeats, u["kind"])
	}
	if posts[0].Auth != cpToken {
		t.Errorf("X-Relay-Auth: want %q, got %q", cpToken, posts[0].Auth)
	}
	if cnt, _ := u["count"].(float64); cnt != 1 {
		t.Errorf("seats usage count should be 1, got %v", cnt)
	}
}

// ============================================================================
// Test 5 – CP contract: stub receives correct paths and auth header
// Prove the cloud adapter actually calls the stub at the right endpoints.
// ============================================================================

func TestBillingE2E_CloudAdapterCallsCorrectEndpoints(t *testing.T) {
	stub := newCPStub(map[string]interface{}{
		"suspended":         false,
		"max_storage_bytes": 1_000_000,
		"max_seats":         10,
	})
	srv := httptest.NewServer(stub)
	defer srv.Close()
	wireCloudProvider(t, srv)

	// Trigger an entitlement lookup + usage post by doing a successful upload.
	router := uploadRouter(t, testAcct)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, pngUpload(t, []byte("probe-bytes")))
	if w.Code != http.StatusOK {
		t.Fatalf("probe upload: expected 200, got %d (%s)", w.Code, w.Body.String())
	}

	// Entitlement lookup must have hit GET /api/entitlements.
	all := stub.recorded()
	var sawEnt bool
	for _, r := range all {
		if r.Method == http.MethodGet && r.Path == "/api/entitlements" {
			sawEnt = true
			if r.Auth != cpToken {
				t.Errorf("entitlements X-Relay-Auth: want %q, got %q", cpToken, r.Auth)
			}
		}
	}
	if !sawEnt {
		t.Error("cloud adapter never called GET /api/entitlements on the stub")
	}

	// Usage POST must have hit POST /api/usage.
	waitForUsage(stub, 1)
	if len(stub.usagePosts()) < 1 {
		t.Error("cloud adapter never posted to /api/usage on the stub")
	}
}

// ============================================================================
// Test 6 – EntCacheWarmThenSuspended
// Verifies that a suspension picked up AFTER a fresh resolve (not just at
// first call) is enforced by the billing layer, not just by the cloud adapter.
// ============================================================================

func TestBillingE2E_EntCacheWarmThenSuspended(t *testing.T) {
	// First serve an OK entitlement so the billing layer has a warm cache entry.
	stub := newCPStub(map[string]interface{}{
		"suspended":         false,
		"max_storage_bytes": 10_000_000,
		"max_seats":         10,
	})
	srv := httptest.NewServer(stub)
	defer srv.Close()
	wireCloudProvider(t, srv)

	router := uploadRouter(t, testAcct)

	// First upload succeeds and warms the entitlement cache.
	w1 := httptest.NewRecorder()
	router.ServeHTTP(w1, pngUpload(t, []byte("first-upload")))
	if w1.Code != http.StatusOK {
		t.Fatalf("first upload should succeed, got %d (%s)", w1.Code, w1.Body.String())
	}

	// Now serve a suspended entitlement (simulates a cp tier change).
	stub.mu.Lock()
	stub.ent = map[string]interface{}{
		"suspended":         true,
		"max_storage_bytes": 10_000_000,
		"max_seats":         10,
	}
	stub.mu.Unlock()

	// Second upload: the billing layer fetches a FRESH entitlement (no cache hit
	// yet, cache TTL has not elapsed) and sees suspended=true → 402.
	w2 := httptest.NewRecorder()
	router.ServeHTTP(w2, pngUpload(t, []byte("second-upload")))
	if w2.Code != http.StatusPaymentRequired {
		t.Fatalf("suspended account should get 402, got %d (%s)", w2.Code, w2.Body.String())
	}
}
