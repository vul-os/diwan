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

// CollabConfig configures the browser-side P2P collaboration transport (see
// docs/COLLABORATION.md §3). Diwan's OWN backend never mediates live
// collaboration — this section exists only to tell the BROWSER where to find a
// peering/rendezvous surface when this server doesn't serve its own.
type CollabConfig struct {
	// RendezvousURL is the base URL of any vulos-relayd's OPEN rendezvous
	// surface (announce/resolve/signal/mailbox + ICE), consumed DIRECTLY by the
	// browser — no Vulos OS / host-box `/api/peering/*` required. When set, a
	// STANDALONE Diwan (which mounts no `/api/peering/*` — see main.go) still
	// gets real peer-to-peer collaboration: any self-hosted relayd is enough.
	// When unset (default), every collab session stays on the existing
	// host-box `/api/peering/*` path when one is present, or local-only when it
	// is not — byte-identical to behaviour before this option existed.
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
		return Default(), nil
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
	}
}
