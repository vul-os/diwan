package handlers

// system_test.go — GET /api/reachability surfaces collab.rendezvous_url.
//
// The browser's collab layer (src/lib/collab/reachableBase.js) fetches this
// unauthenticated endpoint to learn a deploy-time fact it cannot discover on
// its own: the base URL of a self-hosted relayd's OPEN rendezvous surface, so
// a STANDALONE Diwan (no `/api/peering/*` — see main.go) can still offer real
// P2P collaboration. Pin the field's presence, its config.yaml/env source, and
// that it is trimmed the same way public_base_url is.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"diwan/backend/config"

	"github.com/gin-gonic/gin"
)

func reachabilityRouter(cfg *config.Config) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	h := NewSystemHandler(cfg, "test", "standalone", "standalone")
	r.GET("/api/reachability", h.Reachability)
	return r
}

func TestReachability_RendezvousURLEmptyByDefault(t *testing.T) {
	r := reachabilityRouter(&config.Config{})
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/reachability", nil))

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON response: %v", err)
	}
	if v, ok := body["rendezvous_url"]; !ok || v != "" {
		t.Fatalf("expected empty rendezvous_url when unset, got %#v", body["rendezvous_url"])
	}
}

func TestReachability_RendezvousURLFromConfig(t *testing.T) {
	cfg := &config.Config{Collab: config.CollabConfig{RendezvousURL: "https://relay.example.org/"}}
	r := reachabilityRouter(cfg)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/reachability", nil))

	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON response: %v", err)
	}
	// Trailing slash trimmed, mirroring public_base_url's contract.
	if body["rendezvous_url"] != "https://relay.example.org" {
		t.Fatalf("expected trimmed rendezvous_url, got %#v", body["rendezvous_url"])
	}
}
