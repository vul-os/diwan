// Package directory resolves an EMAIL to a Vulos principal via the control
// plane's directory ("verify lookup"), so share dialogs can accept an email
// instead of a raw account id.
//
// It implements Contract 2 of the account-only document-sharing design
// (2026-06-30): the cell serves
//
//	GET {cp}/api/verify/lookup?email=<email>
//	  → DiscoveryResult{ VulaID, Server, DisplayName }   (vulos discovery.go shape)
//
// For an account-only (boxless) user the cell resolves the email to that
// account's CLOUD-HOME VulaID and the cell's own server. Box-running users
// resolve to their box's VulaID + server. The response shape is unchanged from
// the existing discovery contract — this package only CALLS it.
//
// Locality routing (Contract 3) is decided by the caller from the resolved
// Server: a recipient on OUR cell is CO-CLOUD (use the local per-document ACL);
// anyone else is REMOTE (must be shared via the peering/peershare path). See
// CoCloud.
package directory

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// ErrNotFound is returned by Resolver.LookupEmail when the directory has no
// account for the supplied email (HTTP 404). It is a normal, expected outcome
// (the sharer typed an address that is not a Vulos account) — NOT a transport
// failure — so callers map it to a 404/“no account” response, never a 5xx.
var ErrNotFound = errors.New("directory: no Vulos account for that email")

// ErrUnavailable is returned when no directory is configured (standalone /
// self-host without a control plane). Email resolution is impossible; the
// caller must fall back to a raw account id.
var ErrUnavailable = errors.New("directory: email resolution unavailable (no control plane configured)")

// DiscoveryResult mirrors vulos discovery.go's DiscoveryResult — the EXISTING
// shape returned by the cell directory. Field names are decoded permissively
// (snake_case, camelCase, and exported-name forms) because the wire tags are
// owned by an externally configured directory agent and we want to
// interoperate without a lock-step change.
type DiscoveryResult struct {
	// VulaID is the recipient's self-certifying identity
	// (vula:ed25519:<base64 pubkey>). For an account-only user this is the
	// account's cloud-home VulaID, provisioned lazily by the cell.
	VulaID string `json:"vula_id"`
	// Server is the host that serves the recipient's peering intake /
	// CollabStore. For a co-cloud account-only user this is OUR cell's server.
	Server string `json:"server"`
	// DisplayName is a human label for the recipient (optional).
	DisplayName string `json:"display_name"`
}

// Resolver resolves an email to a directory principal.
type Resolver interface {
	// LookupEmail resolves email to a DiscoveryResult. It returns ErrNotFound
	// when the email has no Vulos account, ErrUnavailable when no directory is
	// configured, or a wrapped transport error on a control-plane failure.
	LookupEmail(ctx context.Context, email string) (DiscoveryResult, error)
}

// CPResolver resolves emails against the control plane's verify-lookup endpoint.
type CPResolver struct {
	// BaseURL is the control-plane base (e.g. https://cp.vulos.org), no trailing
	// slash.
	BaseURL string
	// Token is presented as X-Relay-Auth (shared cp auth header used across the
	// suite; the secret is VULOS_CP_TOKEN).
	Token string
	// LocalServer is THIS cell's server identity, used to decide co-cloud vs
	// remote locality (see CoCloud). May be empty (see CoCloud's fail-safe).
	LocalServer string

	http *http.Client
}

// Environment contract (shared with backend/integration/cloud).
const (
	envCPBaseURL = "VULOS_CP_BASE_URL"
	envCPToken   = "VULOS_CP_TOKEN"
	// envCellServer pins THIS cell's server identity for locality routing. When
	// unset it defaults to the host of VULOS_CP_BASE_URL (consolidated topology
	// where the cell and control plane share a host).
	envCellServer = "VULOS_CELL_SERVER"
)

// headerRelayAuth is the shared cp authentication header (matches
// integration/cloud.HeaderRelayAuth).
const headerRelayAuth = "X-Relay-Auth"

// FromEnv builds a CPResolver from the environment, or returns nil when no
// control plane is configured (standalone / self-host) — in which case email
// resolution is unavailable and callers fall back to a raw account id.
func FromEnv() *CPResolver {
	base := strings.TrimRight(strings.TrimSpace(os.Getenv(envCPBaseURL)), "/")
	if base == "" {
		return nil
	}
	local := strings.TrimSpace(os.Getenv(envCellServer))
	if local == "" {
		// Default: same host as the control plane (consolidated cell topology).
		if u, err := url.Parse(base); err == nil {
			local = u.Host
		}
	}
	return &CPResolver{
		BaseURL:     base,
		Token:       strings.TrimSpace(os.Getenv(envCPToken)),
		LocalServer: local,
		http:        &http.Client{Timeout: 5 * time.Second},
	}
}

// LookupEmail implements Resolver against {cp}/api/verify/lookup?email=.
func (r *CPResolver) LookupEmail(ctx context.Context, email string) (DiscoveryResult, error) {
	if r == nil || strings.TrimSpace(r.BaseURL) == "" {
		return DiscoveryResult{}, ErrUnavailable
	}
	email = strings.TrimSpace(email)
	if email == "" {
		return DiscoveryResult{}, fmt.Errorf("directory: empty email")
	}
	reqURL := fmt.Sprintf("%s/api/verify/lookup?email=%s", r.BaseURL, url.QueryEscape(email))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return DiscoveryResult{}, err
	}
	if r.Token != "" {
		req.Header.Set(headerRelayAuth, r.Token)
	}
	client := r.http
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return DiscoveryResult{}, fmt.Errorf("directory: lookup transport: %w", err)
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
		// proceed
	case http.StatusNotFound:
		return DiscoveryResult{}, ErrNotFound
	default:
		return DiscoveryResult{}, fmt.Errorf("directory: lookup status %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return DiscoveryResult{}, fmt.Errorf("directory: read body: %w", err)
	}
	res, err := decodeDiscovery(body)
	if err != nil {
		return DiscoveryResult{}, err
	}
	if res.VulaID == "" && res.Server == "" {
		// A 200 with an empty principal is treated as not-found rather than a
		// silent co-cloud grant (fail closed).
		return DiscoveryResult{}, ErrNotFound
	}
	return res, nil
}

// decodeDiscovery parses a DiscoveryResult permissively across the field-name
// dialects the directory might emit (snake_case / camelCase / exported names),
// so office interoperates with an externally configured directory without a
// lock-step JSON-tag change.
func decodeDiscovery(body []byte) (DiscoveryResult, error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		return DiscoveryResult{}, fmt.Errorf("directory: decode body: %w", err)
	}
	pick := func(keys ...string) string {
		for _, k := range keys {
			if v, ok := raw[k]; ok {
				var s string
				if json.Unmarshal(v, &s) == nil && s != "" {
					return s
				}
			}
		}
		return ""
	}
	return DiscoveryResult{
		VulaID:      pick("vula_id", "vulaId", "VulaID", "vulaID"),
		Server:      pick("server", "Server"),
		DisplayName: pick("display_name", "displayName", "DisplayName"),
	}, nil
}

// CoCloud reports whether res names a recipient on THIS cell (so the local
// per-document ACL is the correct path) versus a REMOTE recipient (box or
// other cell) that must be shared via peering/peershare.
//
// Decision:
//   - empty Server → CO-CLOUD. The directory returns no distinct host for an
//     account-only user hosted right here.
//   - Server host-equal to localServer → CO-CLOUD.
//   - otherwise → REMOTE.
//
// Fail-safe: when localServer is empty (cell identity not configured) a
// NON-EMPTY Server cannot be confirmed as ours, so it is treated as REMOTE
// rather than silently granting a local ACL to a possibly off-cell account.
func CoCloud(res DiscoveryResult, localServer string) bool {
	if strings.TrimSpace(res.Server) == "" {
		return true
	}
	return sameHost(res.Server, localServer)
}

// sameHost compares two server identities by host, tolerating scheme and a
// trailing path/port-less form.
func sameHost(a, b string) bool {
	ha, hb := hostOf(a), hostOf(b)
	if ha == "" || hb == "" {
		return false
	}
	return strings.EqualFold(ha, hb)
}

func hostOf(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	if !strings.Contains(s, "://") {
		s = "//" + s
	}
	u, err := url.Parse(s)
	if err != nil {
		return ""
	}
	return u.Host
}
