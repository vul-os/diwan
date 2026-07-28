// Package cloud is the OPTIONAL gateway ("cp" control plane) adapter for the
// office integration seam. Office has no dependency on any external control
// plane; this adapter talks to whatever gateway the owner configures.
//
// It implements the seam.Identity / seam.Entitlements / seam.Usage interfaces
// against the control plane. It is a SEPARATE package on purpose:
//
//   - The office core never imports it. Only the composition root (main.go)
//     references it, and only when the cloud is explicitly enabled via env.
//   - Deleting this package must not break the standalone build. The core falls
//     back to seam.NewStandaloneProvider().
//
// Selection is via env (see Enabled / FromEnv). With zero cloud env set the
// caller stays fully standalone.
package cloud

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"diwan/backend/seam"
)

// Environment contract for the optional cloud adapter.
const (
	// EnvCPBaseURL, when set, enables the cloud adapter and points it at the
	// control-plane base URL (e.g. https://cp.vulos.org). Absent → standalone.
	EnvCPBaseURL = "VULOS_CP_BASE_URL"

	// EnvCPToken is the service token office presents to the control plane on
	// outbound calls (entitlements lookup, usage reporting). Optional.
	EnvCPToken = "VULOS_CP_TOKEN"

	// EnvOrgID is the tenant/org id (also consumed by the storage layer). The
	// cloud adapter stamps it onto resolved identities and usage events.
	EnvOrgID = "VULOS_ORG_ID"
)

// Enabled reports whether the cloud adapter should be used (i.e. a control-plane
// base URL is configured). When false, callers must use the standalone seam.
func Enabled() bool {
	return strings.TrimSpace(os.Getenv(EnvCPBaseURL)) != ""
}

// Config holds the resolved cloud adapter settings.
type Config struct {
	BaseURL string
	Token   string
	OrgID   string
}

// FromEnv reads the cloud adapter config from the environment.
func FromEnv() Config {
	return Config{
		BaseURL: strings.TrimRight(strings.TrimSpace(os.Getenv(EnvCPBaseURL)), "/"),
		Token:   strings.TrimSpace(os.Getenv(EnvCPToken)),
		OrgID:   strings.TrimSpace(os.Getenv(EnvOrgID)),
	}
}

// NewProvider builds a seam.Provider backed by the control plane.
//
// Identity is delegated to the supplied standalone identity (office tokens are
// HS256-signed by office/cp with a shared secret, so local verification is both
// correct and avoids a network round-trip per request) — but the resolved
// identity is stamped with the configured OrgID. Entitlements and Usage call out
// to the control plane.
//
// The standaloneIdentity argument lets the core keep using its existing local
// JWT verification; pass seam.NewLocalIdentity(...) from main.go.
func NewProvider(cfg Config, standaloneIdentity seam.Identity) seam.Provider {
	client := &http.Client{Timeout: 5 * time.Second}
	return seam.Provider{
		Identity:     &orgStampedIdentity{inner: standaloneIdentity, orgID: cfg.OrgID},
		Entitlements: &cpEntitlements{cfg: cfg, http: client},
		Usage:        &cpUsage{cfg: cfg, http: client},
	}
}

// ---- Identity ---------------------------------------------------------------

// orgStampedIdentity wraps a local identity and stamps the cloud OrgID onto the
// verified result so downstream handlers can scope by tenant.
type orgStampedIdentity struct {
	inner seam.Identity
	orgID string
}

func (o *orgStampedIdentity) AuthEnabled() bool { return o.inner.AuthEnabled() }

func (o *orgStampedIdentity) Authenticate(ctx context.Context, token string) (seam.AccountIdentity, error) {
	id, err := o.inner.Authenticate(ctx, token)
	if err != nil {
		return id, err
	}
	if id.OrgID == "" {
		id.OrgID = o.orgID
	}
	return id, nil
}

// ---- Entitlements -----------------------------------------------------------

type cpEntitlements struct {
	cfg  Config
	http *http.Client

	// lastSeen is the bounded last-known-entitlement cache that makes the
	// fail-open posture deliberate AND time-bounded. A successful For() refreshes
	// it; Allowed() consults it ONLY when a fresh resolve errors. A WARM entry
	// (within entCacheTTL) rides out a transient cp blip; once the entry is COLD
	// (expired or never seen) Allowed DENIES rather than granting indefinitely
	// through a prolonged cp outage.
	cacheMu  sync.Mutex
	lastSeen map[string]cachedEnt
}

// cachedEnt is a last-known entitlement with the time it was fetched.
type cachedEnt struct {
	ent     seam.Entitlement
	fetched time.Time
}

// entCacheTTL bounds how long a last-known entitlement is trusted after the cp
// stops answering. Mirrors the billing-layer warm-cache TTL (backend/billing
// enforce.go): long enough to ride out a transient blip, short enough that a
// prolonged outage stops granting and a real tier change is picked up soon.
const entCacheTTL = 60 * time.Second

// remember stores a freshly-resolved entitlement in the bounded cache.
func (e *cpEntitlements) remember(accountID string, ent seam.Entitlement) {
	e.cacheMu.Lock()
	defer e.cacheMu.Unlock()
	if e.lastSeen == nil {
		e.lastSeen = make(map[string]cachedEnt)
	}
	e.lastSeen[accountID] = cachedEnt{ent: ent, fetched: time.Now()}
}

// warm returns the last-known entitlement for accountID iff it is still within
// entCacheTTL. A cold/expired/absent entry returns ok=false.
func (e *cpEntitlements) warm(accountID string) (seam.Entitlement, bool) {
	e.cacheMu.Lock()
	defer e.cacheMu.Unlock()
	c, ok := e.lastSeen[accountID]
	if !ok || time.Since(c.fetched) >= entCacheTTL {
		return seam.Entitlement{}, false
	}
	return c.ent, true
}

// HeaderRelayAuth is the shared cp authentication header (matches the cp
// contract used across vulos products; the secret is VULOS_CP_TOKEN).
const HeaderRelayAuth = "X-Relay-Auth"

// cpEntitlementResponse is the shared cp contract for an entitlements lookup:
//
//	GET {cp}/api/entitlements?account_id=<email>&product=office
//	  → { tier, suspended, max_storage_bytes, max_seats, features{office} }
type cpEntitlementResponse struct {
	Tier            string          `json:"tier"`
	Suspended       bool            `json:"suspended"`
	MaxStorageBytes int64           `json:"max_storage_bytes"`
	MaxSeats        int64           `json:"max_seats"`
	Features        map[string]bool `json:"features"`
}

func (e *cpEntitlements) For(ctx context.Context, accountID string) (seam.Entitlement, error) {
	reqURL := fmt.Sprintf("%s/api/entitlements?account_id=%s&product=office",
		e.cfg.BaseURL, url.QueryEscape(accountID))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return seam.Entitlement{}, err
	}
	if e.cfg.Token != "" {
		req.Header.Set(HeaderRelayAuth, e.cfg.Token)
	}
	resp, err := e.http.Do(req)
	if err != nil {
		return seam.Entitlement{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return seam.Entitlement{}, fmt.Errorf("cp entitlements: status %d", resp.StatusCode)
	}
	var r cpEntitlementResponse
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil {
		return seam.Entitlement{}, err
	}
	ent := seam.Entitlement{
		Tier:            r.Tier,
		Suspended:       r.Suspended,
		MaxStorageBytes: r.MaxStorageBytes,
		MaxSeats:        r.MaxSeats,
		Features:        r.Features,
	}
	// Warm the bounded cache on every successful resolve so Allowed() can ride
	// out a subsequent transient cp blip without granting indefinitely.
	e.remember(accountID, ent)
	return ent, nil
}

// allowedFor applies the feature decision to a resolved entitlement: a suspended
// account is denied everything; an explicit feature=false denies; otherwise the
// feature is allowed (generous-by-default for absent keys).
func allowedFor(ent seam.Entitlement, feature string) bool {
	if ent.Suspended {
		return false
	}
	if ent.Features == nil {
		return true
	}
	if v, ok := ent.Features[feature]; ok {
		return v
	}
	return true
}

// Allowed reports whether accountID may use feature. Fail-open is now DELIBERATE
// and BOUNDED rather than indefinite:
//
//   - a fresh cp resolve decides authoritatively (and warms the cache);
//   - on a resolver error we consult the bounded last-known cache: a WARM entry
//     (within entCacheTTL) still decides, so a known-good account survives a
//     transient cp blip;
//   - a COLD/absent entry (prolonged outage or never-seen account) is DENIED,
//     closing the indefinite-grant abuse window the audit flagged.
func (e *cpEntitlements) Allowed(ctx context.Context, accountID, feature string) bool {
	ent, err := e.For(ctx, accountID)
	if err == nil {
		return allowedFor(ent, feature)
	}
	if ent, ok := e.warm(accountID); ok {
		return allowedFor(ent, feature)
	}
	// cp unreachable and no warm last-known entitlement: deny rather than grant
	// indefinitely. Short blips are covered by the warm cache above.
	return false
}

// ---- Usage ------------------------------------------------------------------

type cpUsage struct {
	cfg  Config
	http *http.Client
}

// cpUsageBody is the shared cp contract for a usage report:
//
//	POST {cp}/api/usage  { product:"office", account_id, kind:"storage|seats", count, bytes, idempotency_key }
//
// idempotency_key uniquely identifies the event so the control plane can dedupe
// at-least-once retries and never double-bill a single action.
type cpUsageBody struct {
	Product        string `json:"product"`
	AccountID      string `json:"account_id"`
	Kind           string `json:"kind"`
	Count          int64  `json:"count"`
	Bytes          int64  `json:"bytes"`
	IdempotencyKey string `json:"idempotency_key,omitempty"`
}

func (u *cpUsage) Report(ctx context.Context, ev seam.UsageEvent) {
	// Map the seam's neutral UsageEvent.Kind onto the cp's kind+count/bytes
	// dimensions. "storage.bytes" → bytes; everything else → a unit count.
	body := cpUsageBody{
		Product:        "office",
		AccountID:      ev.AccountID,
		Kind:           ev.Kind,
		IdempotencyKey: ev.IdempotencyKey,
	}
	switch ev.Kind {
	case seam.KindStorage:
		body.Bytes = ev.Value
	default: // seam.KindSeats and any count-based dimension
		body.Count = ev.Value
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return
	}
	reqURL := u.cfg.BaseURL + "/api/usage"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, reqURL, bytes.NewReader(raw))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	if u.cfg.Token != "" {
		req.Header.Set(HeaderRelayAuth, u.cfg.Token)
	}
	// Fire-and-forget: never block request handling on metering.
	resp, err := u.http.Do(req)
	if err != nil {
		return
	}
	resp.Body.Close()
}
