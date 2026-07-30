package config

import (
	"os"
	"strings"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Server      ServerConfig      `yaml:"server"`
	Auth        AuthConfig        `yaml:"auth"`
	Storage     StorageConfig     `yaml:"storage"`
	Persistence PersistenceConfig `yaml:"persistence"`
	Collab      CollabConfig      `yaml:"collab"`
}

// CollabConfig configures peer DISCOVERY for browser-to-browser collaboration
// (see docs/COLLABORATION.md §3). Diwan's backend still never mediates live
// document content — edits ride a direct WebRTC data channel — but it does now
// serve the signalling that lets two browsers find each other in the first place
// (BuiltinRendezvous), and it can be pointed at somebody else's instead
// (RendezvousURL).
type CollabConfig struct {
	// BuiltinRendezvous serves Diwan's OWN signed, content-blind peer-discovery
	// surface from this binary at /api/rendezvous/* (backend/rendezvous).
	//
	// DEFAULT TRUE, and that default is the point. WebRTC cannot introduce two
	// browsers without something in the middle passing the first few packets;
	// before this existed, a standalone Diwan had nowhere to get that and fell
	// through to honestly-local-only unless the operator ran a separate
	// vulos-relayd (Ephor) and set RendezvousURL. Collaboration therefore
	// depended on a DIFFERENT product being deployed. Now one Diwan on one VPS is
	// sufficient by itself, and Ephor is a choice rather than a prerequisite.
	//
	// Set false to turn it off. That is a real, supported posture — a deployment
	// that wants no discovery state on its own box at all — and it degrades
	// honestly: sessions fall back to RendezvousURL if set, else to local-only
	// with the UI saying so. It never degrades to a broken editor.
	//
	// Env override: VULOS_BUILTIN_RENDEZVOUS / DIWAN_BUILTIN_RENDEZVOUS.
	BuiltinRendezvous bool `yaml:"builtin_rendezvous"`

	// RendezvousURL is the base URL of any vulos-relayd's OPEN rendezvous
	// surface (announce/resolve/signal/mailbox + ICE), consumed DIRECTLY by the
	// browser — no Vulos OS / host-box `/api/peering/*` required. When set, a
	// STANDALONE Diwan (which mounts no `/api/peering/*` — see main.go) still
	// gets real peer-to-peer collaboration: any self-hosted relayd is enough.
	// When unset (default), a collab session uses the host-box `/api/peering/*`
	// path when one is present, otherwise this binary's OWN built-in rendezvous
	// surface (BuiltinRendezvous above), otherwise local-only. Setting this is
	// therefore an EXPLICIT choice to send discovery somewhere else, and it
	// accordingly outranks the built-in surface — an operator who names a relay
	// meant it (most often to share one relay across several deployments, or for
	// its TURN/NAT-traversal help).
	//
	// Because the browser calls this URL CROSS-ORIGIN, the relayd behind it must
	// serve its rendezvous role with CORS (every Ephor since the role
	// shipped with CORS does; e2e-p2p/ asserts the posture against a real one).
	// It must also be reachable from wherever users load Diwan — an https page
	// cannot call an http relay, so a public deployment needs TLS on the relay.
	//
	// Read-only from the browser's perspective: exposed at the unauthenticated
	// GET /api/reachability as `rendezvous_url` so it can be picked up without a
	// frontend rebuild. Env override: VULOS_RENDEZVOUS_URL / DIWAN_RENDEZVOUS_URL.
	RendezvousURL string `yaml:"rendezvous_url"`

	// ICE is the STUN/TURN configuration served at GET /api/rendezvous/ice.
	ICE ICEConfig `yaml:"ice"`
}

// ICEConfig configures NAT traversal for direct WebRTC.
//
// Diwan's browser bundle can already read STUN/TURN settings from VITE_STUN_URLS
// / VITE_TURN_* — but those are BUILD-TIME variables compiled into the JS. An
// operator running a downloaded release binary or the container image cannot set
// them without rebuilding the frontend, which made docs/COTURN.md unusable for
// exactly the people it is written for. These fields are the runtime equivalent:
// set them, restart, and the browser picks them up from
// GET /api/rendezvous/ice.
//
// Precedence: the browser uses this response only when it is non-empty, else it
// falls back to its own build-time/injected config. So leaving this empty
// (the default) changes nothing for a deployment that already configured the
// bundle.
//
// WHAT IS PUBLIC. That endpoint is unauthenticated — a browser needs ICE servers
// before it has any session — so anything here is readable by anyone who can
// reach the box. STUN URLs are not secret. For TURN, prefer TurnSecret: the
// secret stays server-side and each response carries a short-lived credential.
type ICEConfig struct {
	// STUNURLs are `stun:` URLs (e.g. your own coturn's STUN listener).
	// Env override: VULOS_STUN_URLS / DIWAN_STUN_URLS (comma-separated).
	STUNURLs []string `yaml:"stun_urls"`

	// TURNURLs are `turn:`/`turns:` URLs. Ignored unless a credential mode below
	// is configured too — a credential-less TURN entry cannot authenticate.
	// Env override: VULOS_TURN_URLS / DIWAN_TURN_URLS (comma-separated).
	TURNURLs []string `yaml:"turn_urls"`

	// TurnSecret is coturn's `static-auth-secret` (its REST API / "ephemeral
	// credential" mode). RECOMMENDED: the secret never leaves this process, and
	// each /ice response carries a username/credential valid only for TurnTTL,
	// so a leaked response expires instead of being a permanent grant.
	// Env override: VULOS_TURN_SECRET / DIWAN_TURN_SECRET.
	TurnSecret string `yaml:"turn_secret"`

	// TurnTTLSeconds is how long a minted credential lasts. Default 3600.
	TurnTTLSeconds int `yaml:"turn_ttl_seconds"`

	// TurnUsername / TurnCredential are a LONG-LIVED pair, served verbatim to any
	// caller. Supported for deployments that have no REST secret; prefer
	// TurnSecret. Ignored when TurnSecret is set.
	// Env overrides: VULOS_TURN_USERNAME / DIWAN_TURN_USERNAME,
	// VULOS_TURN_CREDENTIAL / DIWAN_TURN_CREDENTIAL.
	TurnUsername   string `yaml:"turn_username"`
	TurnCredential string `yaml:"turn_credential"`
}

// PersistenceConfig gates optional durability models layered ON TOP of the
// existing whole-document PUT (which always remains the primary store).
type PersistenceConfig struct {
	// UpdateLog turns on the per-file append-only CRDT update log
	// (POST/GET /api/files/:id/updates, frames under data/updates/<id>/).
	// When off (default) those routes are absent and the whole-doc PUT is the
	// only durability path — nothing about existing behaviour changes. During
	// the transition the frontend DUAL-WRITES: it keeps autosaving the whole
	// document AND appends CRDT frames, so enabling or disabling the flag never
	// loses a document. Env override: VULOS_PERSISTENCE_UPDATELOG / DIWAN_UPDATE_LOG.
	UpdateLog bool `yaml:"updatelog"`
}

type ServerConfig struct {
	Addr       string `yaml:"addr"`
	DataDir    string `yaml:"data_dir"`
	UploadsDir string `yaml:"uploads_dir"`
}

type AuthConfig struct {
	Enabled        bool   `yaml:"enabled"`
	Password       string `yaml:"password"`
	MaxAttempts    int    `yaml:"max_attempts"`
	LockoutMinutes int    `yaml:"lockout_minutes"`
	SessionHours   int    `yaml:"session_hours"`
}

type StorageConfig struct {
	Type     string         `yaml:"type"`
	Postgres PostgresConfig `yaml:"postgres"`
}

type PostgresConfig struct {
	Host     string `yaml:"host"`
	Port     int    `yaml:"port"`
	User     string `yaml:"user"`
	Password string `yaml:"password"`
	Database string `yaml:"database"`
	SSLMode  string `yaml:"sslmode"`
	// DSN is a full Postgres connection URL (postgres://…). When set it takes
	// precedence over the individual host/port/user/password/database fields.
	// Populated at runtime from DATABASE_URL or VULOS_DATABASE_URL; not written
	// to config.yaml.
	DSN string `yaml:"-"`
}

func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		// No config file is a SUPPORTED deployment, not an error: a container or
		// PaaS image is normally configured entirely from the environment. The env
		// overrides must therefore be applied on this branch too — they used not
		// to be, which silently ignored every VULOS_*/DIWAN_* variable in exactly
		// the deployment that had nothing else to configure with.
		cfg := Default()
		applyEnvOverrides(cfg)
		return cfg, nil
	}
	cfg := Default()
	if err := yaml.Unmarshal(data, cfg); err != nil {
		return nil, err
	}
	applyEnvOverrides(cfg)
	return cfg, nil
}

// applyEnvOverrides lets deployments flip config from the environment (Fly / OS
// box) without editing the checked-in config.yaml. Only additive, opt-in flags
// are honoured here.
func applyEnvOverrides(cfg *Config) {
	if v, ok := boolEnv("VULOS_PERSISTENCE_UPDATELOG", "DIWAN_UPDATE_LOG"); ok {
		cfg.Persistence.UpdateLog = v
	}
	if v, ok := stringEnv("VULOS_RENDEZVOUS_URL", "DIWAN_RENDEZVOUS_URL"); ok {
		cfg.Collab.RendezvousURL = v
	}
	if v, ok := boolEnv("VULOS_BUILTIN_RENDEZVOUS", "DIWAN_BUILTIN_RENDEZVOUS"); ok {
		cfg.Collab.BuiltinRendezvous = v
	}
	// ICE (STUN/TURN) served at GET /api/rendezvous/ice. Env-settable so a
	// RELEASE BINARY or container can be pointed at a coturn without rebuilding
	// the frontend bundle — see ICEConfig.
	if v, ok := stringEnv("VULOS_STUN_URLS", "DIWAN_STUN_URLS"); ok {
		cfg.Collab.ICE.STUNURLs = csvEnv(v)
	}
	if v, ok := stringEnv("VULOS_TURN_URLS", "DIWAN_TURN_URLS"); ok {
		cfg.Collab.ICE.TURNURLs = csvEnv(v)
	}
	if v, ok := stringEnv("VULOS_TURN_SECRET", "DIWAN_TURN_SECRET"); ok {
		cfg.Collab.ICE.TurnSecret = v
	}
	if v, ok := stringEnv("VULOS_TURN_USERNAME", "DIWAN_TURN_USERNAME"); ok {
		cfg.Collab.ICE.TurnUsername = v
	}
	if v, ok := stringEnv("VULOS_TURN_CREDENTIAL", "DIWAN_TURN_CREDENTIAL"); ok {
		cfg.Collab.ICE.TurnCredential = v
	}
}

// csvEnv splits a comma-separated env value, trimming and dropping blanks so a
// trailing comma or a stray space cannot emit an empty URL into the ICE list.
func csvEnv(raw string) []string {
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}

// boolEnv returns the parsed value of the first set env var among names, and
// whether any was set. Accepts 1/true/on/yes (case-insensitive) as true.
func boolEnv(names ...string) (bool, bool) {
	for _, n := range names {
		raw, present := os.LookupEnv(n)
		if !present {
			continue
		}
		switch strings.TrimSpace(strings.ToLower(raw)) {
		case "1", "true", "on", "yes":
			return true, true
		case "0", "false", "off", "no", "":
			return false, true
		}
	}
	return false, false
}

// stringEnv returns the trimmed value of the first set (non-empty lookup,
// value may be blank) env var among names, and whether any was found present.
func stringEnv(names ...string) (string, bool) {
	for _, n := range names {
		if raw, present := os.LookupEnv(n); present {
			return strings.TrimSpace(raw), true
		}
	}
	return "", false
}

func Default() *Config {
	return &Config{
		Server: ServerConfig{
			Addr:       ":8080",
			DataDir:    "./data",
			UploadsDir: "./uploads",
		},
		Auth: AuthConfig{
			Enabled:        false,
			Password:       "",
			MaxAttempts:    5,
			LockoutMinutes: 15,
			SessionHours:   24,
		},
		Storage: StorageConfig{
			Type: "local",
			Postgres: PostgresConfig{
				Host:    "localhost",
				Port:    5432,
				SSLMode: "disable",
			},
		},
		Collab: CollabConfig{
			// ON by default: a bare `diwan` binary must be able to introduce two
			// browsers to each other without any other product being deployed.
			// See CollabConfig.BuiltinRendezvous.
			BuiltinRendezvous: true,
		},
	}
}
