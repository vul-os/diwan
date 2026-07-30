package rendezvous

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func iceHarness(t *testing.T, cfg ICEConfig) *gin.Engine {
	t.Helper()
	r := gin.New()
	MountICE(r, cfg)
	return r
}

func getICE(t *testing.T, r *gin.Engine) []map[string]any {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, Prefix+"/ice", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("ice: %d %s", w.Code, w.Body.String())
	}
	var body struct {
		IceServers []map[string]any `json:"ice_servers"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("ice body: %v (%s)", err, w.Body.String())
	}
	return body.IceServers
}

// An unconfigured server must return an EMPTY list, not invented servers. The
// client reads empty as "not configured here" and answers from its own build-time
// config, so an empty response is what preserves existing behaviour exactly.
func TestICEUnconfiguredReturnsEmpty(t *testing.T) {
	got := getICE(t, iceHarness(t, ICEConfig{}))
	if len(got) != 0 {
		t.Fatalf("unconfigured ICE should be empty, got %v", got)
	}
}

func TestICEStunOnly(t *testing.T) {
	got := getICE(t, iceHarness(t, ICEConfig{STUNURLs: []string{"stun:stun.example.org:3478", "  "}}))
	if len(got) != 1 {
		t.Fatalf("want 1 entry, got %v", got)
	}
	urls, _ := got[0]["urls"].([]any)
	if len(urls) != 1 || urls[0] != "stun:stun.example.org:3478" {
		t.Errorf("blank URLs must be dropped; got %v", got[0])
	}
	if _, hasCred := got[0]["credential"]; hasCred {
		t.Errorf("a STUN entry must carry no credential: %v", got[0])
	}
}

// TURN with no credential mode emits NOTHING for TURN: a credential-less entry
// cannot authenticate, and shipping it would only slow ICE while looking
// configured.
func TestICETurnWithoutCredentialsIsOmitted(t *testing.T) {
	got := getICE(t, iceHarness(t, ICEConfig{
		STUNURLs: []string{"stun:stun.example.org:3478"},
		TURNURLs: []string{"turn:turn.example.org:3478"},
	}))
	if len(got) != 1 {
		t.Fatalf("want only the STUN entry, got %v", got)
	}
	urls, _ := got[0]["urls"].([]any)
	if len(urls) != 1 || !strings.HasPrefix(urls[0].(string), "stun:") {
		t.Fatalf("the surviving entry should be STUN, got %v", got[0])
	}
}

// The REST-API mode is the one an operator should use: the secret stays on the
// server and each response carries a short-lived credential.
func TestICETurnRestCredentialsAreEphemeralAndCorrect(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	cfg := ICEConfig{
		TURNURLs:   []string{"turn:turn.example.org:3478"},
		TurnSecret: "s3cr3t",
		TurnTTL:    30 * time.Minute,
	}
	servers := buildICEServers(cfg, now)
	if len(servers) != 1 {
		t.Fatalf("want 1 entry, got %#v", servers)
	}
	s := servers[0]

	wantUser := strconv.FormatInt(now.Add(30*time.Minute).Unix(), 10)
	if s.Username != wantUser {
		t.Errorf("username should be the unix expiry: want %s, got %s", wantUser, s.Username)
	}
	mac := hmac.New(sha1.New, []byte("s3cr3t"))
	mac.Write([]byte(wantUser))
	if want := base64.StdEncoding.EncodeToString(mac.Sum(nil)); s.Credential != want {
		t.Errorf("credential is not base64(HMAC-SHA1(secret, username)): want %s, got %s", want, s.Credential)
	}
	if s.TTL != 1800 {
		t.Errorf("ttl: want 1800, got %d", s.TTL)
	}

	// The secret itself must never appear in a response.
	raw, _ := json.Marshal(servers)
	if strings.Contains(string(raw), "s3cr3t") {
		t.Fatalf("the TURN secret leaked into the response: %s", raw)
	}

	// A later request mints a DIFFERENT credential — that is what makes a leaked
	// response expire rather than being a permanent grant.
	later := buildICEServers(cfg, now.Add(time.Minute))
	if later[0].Credential == s.Credential {
		t.Error("credentials must change with the clock")
	}
}

// A long-lived pair is supported, but the REST secret must win when both are
// configured: never hand out a permanent credential when a temporary one is
// available.
func TestICETurnSecretBeatsStaticCredential(t *testing.T) {
	servers := buildICEServers(ICEConfig{
		TURNURLs:       []string{"turn:turn.example.org:3478"},
		TurnSecret:     "s3cr3t",
		TurnUsername:   "static-user",
		TurnCredential: "static-pass",
	}, time.Unix(1_800_000_000, 0))
	if len(servers) != 1 {
		t.Fatalf("want 1 entry, got %#v", servers)
	}
	if servers[0].Username == "static-user" || servers[0].Credential == "static-pass" {
		t.Fatalf("the long-lived credential was served despite a REST secret: %#v", servers[0])
	}
}

func TestICEStaticCredentialsWhenThatIsAllThereIs(t *testing.T) {
	servers := buildICEServers(ICEConfig{
		TURNURLs:       []string{"turn:turn.example.org:3478"},
		TurnUsername:   "static-user",
		TurnCredential: "static-pass",
	}, time.Unix(1_800_000_000, 0))
	if len(servers) != 1 || servers[0].Username != "static-user" || servers[0].Credential != "static-pass" {
		t.Fatalf("static credentials not served: %#v", servers)
	}
	// Half a pair is not a pair: a username with no credential must emit nothing.
	half := buildICEServers(ICEConfig{
		TURNURLs:     []string{"turn:turn.example.org:3478"},
		TurnUsername: "static-user",
	}, time.Unix(1_800_000_000, 0))
	if len(half) != 0 {
		t.Fatalf("an incomplete credential pair must emit nothing, got %#v", half)
	}
}
