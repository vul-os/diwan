package cloud

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"diwan/backend/seam"
)

// With no cloud env set, the adapter must report disabled so the caller stays
// fully standalone.
func TestEnabled_DefaultOff(t *testing.T) {
	t.Setenv(EnvCPBaseURL, "")
	if Enabled() {
		t.Fatal("cloud adapter must be disabled when VULOS_CP_BASE_URL is unset")
	}
}

func TestEnabled_OnWhenBaseURLSet(t *testing.T) {
	t.Setenv(EnvCPBaseURL, "https://cp.example.com")
	if !Enabled() {
		t.Fatal("cloud adapter must be enabled when VULOS_CP_BASE_URL is set")
	}
	cfg := FromEnv()
	if cfg.BaseURL != "https://cp.example.com" {
		t.Fatalf("unexpected base url %q", cfg.BaseURL)
	}
}

// The cloud provider delegates identity to the supplied standalone identity and
// stamps the configured OrgID onto the result.
func TestOrgStampedIdentity(t *testing.T) {
	inner := seam.NewLocalIdentity(func() ([]byte, error) { return []byte("s"), nil }, false)
	p := NewProvider(Config{OrgID: "org-123"}, inner)

	id, err := p.Identity.Authenticate(context.Background(), "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if id.OrgID != "org-123" {
		t.Fatalf("expected org stamped, got %+v", id)
	}
	if id.AccountID != "self" {
		t.Fatalf("expected delegated self identity, got %+v", id)
	}
}

// The entitlements adapter must call the shared cp contract: GET with the
// account_id/product query and the X-Relay-Auth header, and map the response
// fields (suspended, max_storage_bytes, max_seats, features.office) onto the
// seam.Entitlement.
func TestEntitlements_CPContract(t *testing.T) {
	var gotPath, gotQuery, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotQuery = r.URL.RawQuery
		gotAuth = r.Header.Get(HeaderRelayAuth)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"tier":"pro","suspended":true,"max_storage_bytes":1024,"max_seats":5,"features":{"office":false}}`)
	}))
	defer srv.Close()

	e := &cpEntitlements{cfg: Config{BaseURL: srv.URL, Token: "secret123"}, http: srv.Client()}
	ent, err := e.For(context.Background(), "alice@vulos.org")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if gotPath != "/api/entitlements" {
		t.Fatalf("unexpected path %q", gotPath)
	}
	if gotQuery != "account_id=alice%40vulos.org&product=office" {
		t.Fatalf("unexpected query %q", gotQuery)
	}
	if gotAuth != "secret123" {
		t.Fatalf("expected X-Relay-Auth secret, got %q", gotAuth)
	}
	if ent.Tier != "pro" || !ent.Suspended || ent.MaxStorageBytes != 1024 || ent.MaxSeats != 5 {
		t.Fatalf("response not mapped: %+v", ent)
	}
	if v, ok := ent.Features["office"]; !ok || v {
		t.Fatalf("office feature not mapped: %+v", ent.Features)
	}
}

// Allowed must treat suspended:true as denied (when the cp answers). When the cp
// is unreachable the fail-open is now BOUNDED: a cold-cache (never-seen) account
// is DENIED rather than granted indefinitely, while a warm last-known
// entitlement still rides out a transient blip.
func TestAllowed_SuspendedAndBoundedFailOpen(t *testing.T) {
	suspended := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"suspended":true}`)
	}))
	defer suspended.Close()
	e := &cpEntitlements{cfg: Config{BaseURL: suspended.URL}, http: suspended.Client()}
	if e.Allowed(context.Background(), "a", seam.FeatureOffice) {
		t.Fatal("suspended account must be denied")
	}

	// Unreachable cp + COLD cache → DENY (closes the indefinite-grant window).
	down := &cpEntitlements{cfg: Config{BaseURL: "http://127.0.0.1:0"}, http: suspended.Client()}
	if down.Allowed(context.Background(), "a", seam.FeatureOffice) {
		t.Fatal("unreachable cp with cold cache must DENY, not grant indefinitely")
	}

	// Warm last-known entitlement survives a transient cp blip: resolve once
	// against a healthy cp (warming the cache), then point the SAME limiter at a
	// dead address and confirm the warm entry still allows.
	healthy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"suspended":false,"features":{"office":true}}`)
	}))
	defer healthy.Close()
	warm := &cpEntitlements{cfg: Config{BaseURL: healthy.URL}, http: healthy.Client()}
	if !warm.Allowed(context.Background(), "b", seam.FeatureOffice) {
		t.Fatal("healthy cp should allow account b")
	}
	warm.cfg.BaseURL = "http://127.0.0.1:0" // cp now unreachable
	if !warm.Allowed(context.Background(), "b", seam.FeatureOffice) {
		t.Fatal("warm last-known entitlement must ride out a transient cp blip (allow)")
	}
}

// Usage.Report must POST the shared cp body shape with the X-Relay-Auth header,
// mapping storage→bytes and seats→count.
func TestUsage_CPContract(t *testing.T) {
	type body struct {
		Product   string `json:"product"`
		AccountID string `json:"account_id"`
		Kind      string `json:"kind"`
		Count     int64  `json:"count"`
		Bytes     int64  `json:"bytes"`
	}
	recv := make(chan body, 2)
	var auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get(HeaderRelayAuth)
		var b body
		_ = json.NewDecoder(r.Body).Decode(&b)
		recv <- b
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()

	u := &cpUsage{cfg: Config{BaseURL: srv.URL, Token: "sek"}, http: srv.Client()}
	u.Report(context.Background(), seam.UsageEvent{AccountID: "alice@vulos.org", Kind: seam.KindStorage, Value: 2048})
	u.Report(context.Background(), seam.UsageEvent{AccountID: "alice@vulos.org", Kind: seam.KindSeats, Value: 1})

	got1 := <-recv
	got2 := <-recv
	if auth != "sek" {
		t.Fatalf("expected X-Relay-Auth header, got %q", auth)
	}
	byKind := map[string]body{got1.Kind: got1, got2.Kind: got2}
	if s := byKind[seam.KindStorage]; s.Product != "office" || s.AccountID != "alice@vulos.org" || s.Bytes != 2048 || s.Count != 0 {
		t.Fatalf("storage usage body wrong: %+v", s)
	}
	if s := byKind[seam.KindSeats]; s.Count != 1 || s.Bytes != 0 {
		t.Fatalf("seats usage body wrong: %+v", s)
	}
}
