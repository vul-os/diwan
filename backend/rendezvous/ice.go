package rendezvous

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// ice.go — GET /api/rendezvous/ice: the STUN/TURN servers this deployment wants
// browsers to use for NAT traversal.
//
// WHY IT IS SERVED BY THE BINARY AND NOT BAKED INTO THE BUNDLE
// -----------------------------------------------------------
// Diwan's browser code can already read STUN/TURN config from `VITE_STUN_URLS` /
// `VITE_TURN_*` — but those are BUILD-TIME variables baked into the JS bundle. An
// operator who downloaded a release binary (or pulled the container) cannot set
// them without rebuilding the frontend, which makes docs/COTURN.md unusable for
// exactly the audience it is written for. Serving the same facts from the running
// binary closes that: point `collab.ice.*` at your coturn, restart, done.
//
// Precedence is unchanged and deliberate: the client only uses this response when
// it is non-empty, otherwise it falls back to its own build-time/injected config
// (see resolveStunFallback in src/lib/collab/webrtc/call/ice.js). So a deployment
// that already configured the bundle keeps working byte-for-byte, and an
// unconfigured server returns an empty list rather than inventing servers.
//
// WHAT THIS ENDPOINT EXPOSES
// --------------------------
// It is UNAUTHENTICATED, because a browser needs ICE servers before it has any
// session and anonymous invite-link collaboration is the feature. So whatever is
// configured here is readable by anyone who can reach the box. That is fine for
// STUN (a STUN server only tells a caller its own public address) and it is the
// reason TURN has two modes:
//
//   - TurnSecret (RECOMMENDED) — coturn's `static-auth-secret` / REST API. The
//     secret NEVER leaves the server; each response carries a time-limited
//     username/credential pair minted from it. A leaked response is useless
//     within the hour.
//   - TurnUsername/TurnCredential — a long-lived credential, handed verbatim to
//     anyone who asks. Supported because some deployments have no choice, and
//     documented as what it is rather than dressed up.
//
// If both are set, the secret wins: never hand out a long-lived credential when a
// short-lived one is available.

// ICEConfig is the operator's STUN/TURN configuration. All fields optional; an
// entirely empty ICEConfig makes the endpoint return an empty list, which the
// client reads as "not configured here" and answers from its own config.
type ICEConfig struct {
	// STUNURLs are `stun:` URLs. Safe to publish.
	STUNURLs []string
	// TURNURLs are `turn:`/`turns:` URLs. Only used when a credential mode below
	// is also configured — a TURN URL with no credentials is useless to a browser,
	// and emitting it would produce a confusing half-configured ICE list.
	TURNURLs []string
	// TurnSecret is coturn's static-auth-secret. When set, credentials are minted
	// per response and expire after TurnTTL.
	TurnSecret string
	// TurnTTL is how long a minted credential is valid. Defaults to 1 hour, which
	// comfortably outlives a session's ICE gathering while bounding replay of a
	// leaked response.
	TurnTTL time.Duration
	// TurnUsername/TurnCredential are a long-lived pair, served verbatim. Ignored
	// when TurnSecret is set.
	TurnUsername   string
	TurnCredential string
}

// iceServer is one entry of the response, in the shape RTCPeerConnection expects
// and the JS client already parses (`{ urls, username?, credential? }`).
type iceServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
	TTL        int64    `json:"ttl,omitempty"`
}

// MountICE registers GET /ice on the same group as the rest of the protocol.
// Separate from Mount so a caller can serve discovery without ICE (or vice versa)
// and so the ICE config is passed explicitly rather than smuggled into Service.
func MountICE(r gin.IRouter, cfg ICEConfig) {
	g := r.Group(Prefix)
	g.GET("/ice", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"ice_servers": buildICEServers(cfg, time.Now())})
	})
}

// buildICEServers renders the configured servers at time `now`. Split from the
// handler so the credential minting can be tested against a fixed clock.
func buildICEServers(cfg ICEConfig, now time.Time) []iceServer {
	out := []iceServer{}

	stun := nonEmpty(cfg.STUNURLs)
	if len(stun) > 0 {
		out = append(out, iceServer{URLs: stun})
	}

	turn := nonEmpty(cfg.TURNURLs)
	if len(turn) == 0 {
		return out
	}

	if cfg.TurnSecret != "" {
		ttl := cfg.TurnTTL
		if ttl <= 0 {
			ttl = time.Hour
		}
		// coturn REST API: the username is "<unix-expiry>[:<name>]" and the
		// credential is base64(HMAC-SHA1(secret, username)). The expiry is IN the
		// username, which is why it needs no server-side state — coturn
		// recomputes the HMAC and checks the clock.
		user := strconv.FormatInt(now.Add(ttl).Unix(), 10)
		mac := hmac.New(sha1.New, []byte(cfg.TurnSecret))
		mac.Write([]byte(user))
		out = append(out, iceServer{
			URLs:       turn,
			Username:   user,
			Credential: base64.StdEncoding.EncodeToString(mac.Sum(nil)),
			TTL:        int64(ttl.Seconds()),
		})
		return out
	}

	if cfg.TurnUsername != "" && cfg.TurnCredential != "" {
		out = append(out, iceServer{URLs: turn, Username: cfg.TurnUsername, Credential: cfg.TurnCredential})
	}
	// Deliberately NOTHING when TURN URLs are configured with no credential mode:
	// a credential-less TURN entry cannot authenticate and would only make ICE
	// gathering slower while looking configured.
	return out
}

// nonEmpty trims and drops blanks, so a config line like `stun_urls: ["", ...]`
// or a stray comma in an env var cannot emit an empty URL into the ICE list.
func nonEmpty(in []string) []string {
	out := make([]string, 0, len(in))
	for _, s := range in {
		if t := strings.TrimSpace(s); t != "" {
			out = append(out, t)
		}
	}
	return out
}
