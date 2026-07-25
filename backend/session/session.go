// Package session implements the Vulos SSO session-introspection seam used by
// Office's auth middleware to validate a user's browser session WITHOUT Office
// ever holding session-signing power.
//
// This is the wedge-aligned identity path: Office never mints or verifies its
// OWN session signature — it INTROSPECTS the opaque `vc_session` cookie against a
// configurable identity provider (the sovereign box in self-host, an optional
// gateway the owner configures for hosted deployments). The provider is the
// sole holder of session-signing power; Office only ever asks "is this session
// valid, and who is it?".
//
//	POST {IDENTITY_URL}/api/session/introspect
//	  Headers: Content-Type: application/json
//	           X-Relay-Auth: <shared service secret>   (the same secret Office
//	                         already presents to the CP for API-key introspection
//	                         and entitlements — VULOS_CP_TOKEN == CP_SHARED_SECRET;
//	                         it is a SERVICE-AUTH secret, NOT a signing key)
//	  Body:    {"session": "<vc_session cookie value>"}
//	  200  →   {"valid": true,
//	            "userId":   "alice@vulos.org",
//	            "tenantId": "acct_123",       (account id — the tenant scope)
//	            "expiresAt": 1720000000}      (unix seconds; 0 = unknown)
//	  200  →   {"valid": false}              (invalid/expired/revoked/suspended/forged)
//
// Results are cached in-process for a short TTL (~cacheMaxTTL, further bounded by
// the session's own expiresAt) so a burst of requests does not become a CP
// round-trip per request. Both valid AND invalid results are cached so a hot bad
// cookie cannot hammer the provider.
//
// Fail-closed contract: when an IDENTITY_URL is configured, a transport error or
// a non-200 from the provider yields an ERROR (not a "valid:false"), and the
// caller MUST reject the request (401) rather than fall open to a shared
// identity. Configuring an identity provider is an explicit statement that this
// is a multi-user deployment; falling open would be a tenant-isolation breach.
//
// This package imports nothing from the rest of office: it is the wire seam, so
// the provider side (CP or sovereign box) can implement the identical contract.
package session

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	// CookieName is the session cookie the identity provider issues and Office
	// introspects. Office never sets or signs this cookie — it only reads its
	// opaque value off the request and asks the provider to resolve it.
	CookieName = "vc_session"

	// EnvIdentityURL points at the identity provider's base URL (the sovereign
	// box in self-host, the CP in cloud, e.g. https://cp.vulos.org). When UNSET
	// the session-introspection path is DISABLED and Office keeps its existing
	// local single-identity behavior (self-host appliance — unchanged). When SET
	// Office is in multi-user mode and MUST fail closed on any doubt.
	EnvIdentityURL = "IDENTITY_URL"

	// EnvSharedSecret is the service-auth secret Office presents to the identity
	// provider on the introspection call. It is the SAME secret Office already
	// holds for CP API-key introspection / entitlements (VULOS_CP_TOKEN), which
	// equals the provider's CP_SHARED_SECRET. It is NOT a signing key.
	EnvSharedSecret = "VULOS_CP_TOKEN"

	// HeaderRelayAuth is the shared service-auth header used across Vulos products
	// (the secret is EnvSharedSecret).
	HeaderRelayAuth = "X-Relay-Auth"

	// cacheMaxTTL bounds how long an introspection result is trusted before the
	// provider is asked again, regardless of the session's own expiry. Short
	// enough that a revoked/suspended session stops working promptly; long enough
	// to absorb a burst of requests. The effective TTL is min(cacheMaxTTL, time
	// until the session's expiresAt).
	cacheMaxTTL = 45 * time.Second
)

// Result is the identity provider's response to a session introspection.
//
// TenantID is the account id and is the tenant scope Office keys all data by:
// every downstream lookup (files, comments, storage keys) is scoped to it so a
// user only ever sees their own tenant's data.
type Result struct {
	Valid     bool   `json:"valid"`
	UserID    string `json:"userId"`
	TenantID  string `json:"tenantId"`
	ExpiresAt int64  `json:"expiresAt"` // unix seconds; 0 = unknown
}

// Introspector validates an opaque session value and returns the resolved
// identity. A non-nil error means the validation could NOT be completed
// (provider unreachable / non-200); callers MUST fail closed (reject) rather
// than grant access.
type Introspector interface {
	Introspect(ctx context.Context, session string) (Result, error)
}

// Config holds the resolved session-introspection seam settings.
type Config struct {
	IdentityURL string
	Token       string
}

// FromEnv reads the session-introspection config from the environment.
func FromEnv() Config {
	return Config{
		IdentityURL: strings.TrimRight(strings.TrimSpace(os.Getenv(EnvIdentityURL)), "/"),
		Token:       strings.TrimSpace(os.Getenv(EnvSharedSecret)),
	}
}

// Enabled reports whether the session path is configured (an identity URL is
// set). When false Office keeps its existing local single-identity behavior.
func (c Config) Enabled() bool { return strings.TrimSpace(c.IdentityURL) != "" }

// cpIntrospector is the provider-backed Introspector with a bounded cache.
type cpIntrospector struct {
	cfg  Config
	http *http.Client
	now  func() time.Time // injectable clock (tests)

	mu    sync.Mutex
	cache map[string]cachedResult
}

type cachedResult struct {
	res       Result
	expiresAt time.Time // when this cache entry stops being trusted
}

// NewIntrospector builds a provider-backed Introspector from cfg. Returns nil
// when cfg is not Enabled() so the caller can detect the "local mode" path.
func NewIntrospector(cfg Config) Introspector {
	if !cfg.Enabled() {
		return nil
	}
	return NewIntrospectorWithClient(cfg, &http.Client{Timeout: 5 * time.Second})
}

// NewIntrospectorWithClient builds an introspector over a caller-supplied HTTP
// client (tests point this at an httptest server).
func NewIntrospectorWithClient(cfg Config, hc *http.Client) *cpIntrospector {
	return &cpIntrospector{
		cfg:   cfg,
		http:  hc,
		now:   time.Now,
		cache: make(map[string]cachedResult),
	}
}

// cacheKey hashes the raw session so the in-memory cache never retains the
// session secret in the clear.
func cacheKey(session string) string {
	sum := sha256.Sum256([]byte(session))
	return hex.EncodeToString(sum[:])
}

func (c *cpIntrospector) fromCache(session string) (Result, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.cache[cacheKey(session)]
	if !ok || !c.now().Before(e.expiresAt) {
		return Result{}, false
	}
	return e.res, true
}

// remember stores res under a TTL bounded by BOTH cacheMaxTTL and the session's
// own expiresAt, so a session that expires in 5s is not trusted for 45s.
func (c *cpIntrospector) remember(session string, res Result) {
	now := c.now()
	exp := now.Add(cacheMaxTTL)
	if res.Valid && res.ExpiresAt > 0 {
		sessionExp := time.Unix(res.ExpiresAt, 0)
		if sessionExp.Before(exp) {
			exp = sessionExp
		}
	}
	// Never cache a result whose TTL is already in the past (already-expired
	// session): treat it as uncacheable so the next request re-checks.
	if !exp.After(now) {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.cache[cacheKey(session)] = cachedResult{res: res, expiresAt: exp}
}

// introspectRequest is the wire body POSTed to the identity provider.
type introspectRequest struct {
	Session string `json:"session"`
}

// Introspect resolves session against the identity provider, consulting the
// short-TTL cache first. A transport/non-200 error is returned (caller fails
// closed). A valid result whose expiresAt is already in the past is downgraded
// to invalid (defence in depth against a provider that returns a stale valid).
func (c *cpIntrospector) Introspect(ctx context.Context, session string) (Result, error) {
	if session == "" {
		return Result{Valid: false}, nil
	}
	if r, ok := c.fromCache(session); ok {
		return r, nil
	}

	raw, err := json.Marshal(introspectRequest{Session: session})
	if err != nil {
		return Result{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.cfg.IdentityURL+"/api/session/introspect", bytes.NewReader(raw))
	if err != nil {
		return Result{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.cfg.Token != "" {
		req.Header.Set(HeaderRelayAuth, c.cfg.Token)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return Result{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return Result{}, fmt.Errorf("session introspect: status %d", resp.StatusCode)
	}

	var res Result
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return Result{}, err
	}

	// Defence in depth: a provider that answers valid:true but with a past
	// expiresAt is treated as invalid, and a valid result must carry a non-empty
	// userId (an identity we can actually scope by).
	if res.Valid {
		if res.UserID == "" {
			res = Result{Valid: false}
		} else if res.ExpiresAt > 0 && !time.Unix(res.ExpiresAt, 0).After(c.now()) {
			res = Result{Valid: false}
		}
	}

	c.remember(session, res)
	return res, nil
}
