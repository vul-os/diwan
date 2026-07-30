package config

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// collab_test.go — the collab discovery + ICE settings, and the YAML behaviour
// they quietly depend on.
//
// `builtin_rendezvous` is a bool that DEFAULTS TO TRUE, which is the one shape of
// setting that can break silently. Load() unmarshals into a struct that Default()
// already populated, so an omitted key must leave `true` standing and an explicit
// `false` must win. If yaml.v3 ever zeroed the whole `collab` struct on seeing the
// key, every deployment with a `collab:` block would lose peer discovery with no
// error anywhere — so that is asserted against a real file rather than assumed.

func writeCfg(t *testing.T, body string) string {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	return p
}

func TestDefault_BuiltinRendezvousOn(t *testing.T) {
	// A bare `diwan` binary must be able to introduce two browsers to each other
	// without another product being deployed. That is what this default IS.
	if !Default().Collab.BuiltinRendezvous {
		t.Fatal("builtin_rendezvous must default to true")
	}
}

func TestLoad_OmittedBuiltinRendezvousKeepsDefaultTrue(t *testing.T) {
	// The `collab` key is PRESENT but names only rendezvous_url — exactly the
	// shape of a config written before builtin_rendezvous existed.
	p := writeCfg(t, "collab:\n  rendezvous_url: \"https://relay.example.org\"\n")
	cfg, err := Load(p)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !cfg.Collab.BuiltinRendezvous {
		t.Fatal("an omitted builtin_rendezvous must leave the default (true) standing")
	}
	if cfg.Collab.RendezvousURL != "https://relay.example.org" {
		t.Fatalf("rendezvous_url: got %q", cfg.Collab.RendezvousURL)
	}
	// …and the rest of the config is still the default, not zeroed.
	if cfg.Server.Addr != ":8080" || cfg.Storage.Type != "local" {
		t.Fatalf("unrelated defaults were lost: %+v", cfg.Server)
	}
}

func TestLoad_ExplicitFalseTurnsBuiltinRendezvousOff(t *testing.T) {
	p := writeCfg(t, "collab:\n  builtin_rendezvous: false\n")
	cfg, err := Load(p)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Collab.BuiltinRendezvous {
		t.Fatal("an explicit false must turn the built-in surface off")
	}
}

func TestApplyEnvOverrides_BuiltinRendezvous(t *testing.T) {
	for _, tc := range []struct {
		env  string
		want bool
	}{{"0", false}, {"false", false}, {"off", false}, {"1", true}, {"true", true}} {
		t.Run(tc.env, func(t *testing.T) {
			t.Setenv("VULOS_BUILTIN_RENDEZVOUS", tc.env)
			cfg := Default()
			applyEnvOverrides(cfg)
			if cfg.Collab.BuiltinRendezvous != tc.want {
				t.Fatalf("VULOS_BUILTIN_RENDEZVOUS=%s → %v, want %v", tc.env, cfg.Collab.BuiltinRendezvous, tc.want)
			}
		})
	}
}

// A MISSING config file is a supported deployment (a container or PaaS image
// configured entirely from the environment). The env overrides used not to be
// applied on that branch, which silently ignored every VULOS_*/DIWAN_* variable
// in exactly the deployment that had nothing else to configure with.
func TestLoad_MissingFileStillAppliesEnvOverrides(t *testing.T) {
	t.Setenv("VULOS_RENDEZVOUS_URL", "https://relay.example.org")
	t.Setenv("VULOS_BUILTIN_RENDEZVOUS", "0")
	t.Setenv("VULOS_STUN_URLS", "stun:stun.example.org:3478")

	cfg, err := Load(filepath.Join(t.TempDir(), "does-not-exist.yaml"))
	if err != nil {
		t.Fatalf("a missing config file must not be an error: %v", err)
	}
	if cfg.Collab.RendezvousURL != "https://relay.example.org" {
		t.Errorf("rendezvous_url from env was ignored: %q", cfg.Collab.RendezvousURL)
	}
	if cfg.Collab.BuiltinRendezvous {
		t.Error("builtin_rendezvous from env was ignored")
	}
	if !reflect.DeepEqual(cfg.Collab.ICE.STUNURLs, []string{"stun:stun.example.org:3478"}) {
		t.Errorf("stun_urls from env was ignored: %#v", cfg.Collab.ICE.STUNURLs)
	}
}

func TestApplyEnvOverrides_ICE(t *testing.T) {
	// A trailing comma and stray spaces are what a hand-written env var actually
	// looks like; an empty URL reaching the ICE list would be handed to
	// RTCPeerConnection.
	t.Setenv("VULOS_STUN_URLS", " stun:a.example:3478 , stun:b.example:3478 , ")
	t.Setenv("VULOS_TURN_URLS", "turn:t.example:3478,")
	t.Setenv("VULOS_TURN_SECRET", "s3cr3t")
	t.Setenv("VULOS_TURN_USERNAME", "u")
	t.Setenv("VULOS_TURN_CREDENTIAL", "p")

	cfg := Default()
	applyEnvOverrides(cfg)

	if want := []string{"stun:a.example:3478", "stun:b.example:3478"}; !reflect.DeepEqual(cfg.Collab.ICE.STUNURLs, want) {
		t.Errorf("stun_urls: got %#v, want %#v", cfg.Collab.ICE.STUNURLs, want)
	}
	if want := []string{"turn:t.example:3478"}; !reflect.DeepEqual(cfg.Collab.ICE.TURNURLs, want) {
		t.Errorf("turn_urls: got %#v, want %#v", cfg.Collab.ICE.TURNURLs, want)
	}
	if cfg.Collab.ICE.TurnSecret != "s3cr3t" || cfg.Collab.ICE.TurnUsername != "u" || cfg.Collab.ICE.TurnCredential != "p" {
		t.Errorf("turn credentials not plumbed: %+v", cfg.Collab.ICE)
	}
}

// The config.yaml CHECKED INTO THIS REPO must parse, and must parse into the
// values it documents. It is the file every self-hoster starts from, and a typo in
// it is a broken deployment that no other test would catch.
func TestRepoConfigYAMLParses(t *testing.T) {
	// The test runs in backend/config, so walk up to the repo root.
	p := filepath.Join("..", "..", "config.yaml")
	if _, err := os.Stat(p); err != nil {
		t.Skipf("config.yaml not found from %s: %v", mustCwd(t), err)
	}
	cfg, err := Load(p)
	if err != nil {
		t.Fatalf("the repo's own config.yaml does not parse: %v", err)
	}
	if !cfg.Collab.BuiltinRendezvous {
		t.Error("config.yaml must ship with builtin_rendezvous on — it is the documented default")
	}
	if cfg.Collab.RendezvousURL != "" {
		t.Errorf("config.yaml must ship with no relay configured, got %q", cfg.Collab.RendezvousURL)
	}
	if len(cfg.Collab.ICE.STUNURLs) != 0 || len(cfg.Collab.ICE.TURNURLs) != 0 {
		t.Errorf("config.yaml must ship with no ICE servers (they are per-deployment): %+v", cfg.Collab.ICE)
	}
	if cfg.Collab.ICE.TurnSecret != "" || cfg.Collab.ICE.TurnCredential != "" {
		t.Error("config.yaml must never ship a TURN credential")
	}
	if cfg.Server.Addr == "" {
		t.Error("config.yaml must set a server addr")
	}
}

func mustCwd(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		return "?"
	}
	return wd
}
