package storage

// migrate_cmd.go — exported helpers for the `diwan migrate` subcommand.
//
// RunMigrations opens the configured storage backend and applies every
// migration; it is idempotent (all DDL uses CREATE … IF NOT EXISTS).
// MigrationStatus queries which tables exist in the Postgres schema and returns
// a map[tableName]bool for the tables the codebase creates.
//
// Both helpers are safe to call out-of-band (before or alongside a running
// server) — they do not acquire any application-level locks.

import (
	"context"
	"fmt"

	"diwan/backend/config"
)

// knownTables is the full set of tables diwan creates across all
// migration passes. The migrate up subcommand verifies all are present after
// applying migrations.
var knownTables = []string{
	"files",
	"file_versions",
	"file_acl_owners",
	"file_acl_shares",
	"envelopes",
	"audit_log",
	"signer_tokens",
	"sealed_pdfs",
	"comments",
	"comment_replies",
	"suggestions",
}

// RunMigrations opens a Postgres storage backend and applies all migrations.
// For the local (sqlite) backend the storage constructor applies migrations
// inline, so this is a no-op with a success log.
//
// DATABASE_URL / VULOS_DATABASE_URL override the config.yaml storage.type so
// that `diwan migrate up` works in the cloud environment without editing
// config files.
func RunMigrations(cfg *config.Config) error {
	// Apply env override (same logic as storage.New so migrate up is consistent).
	if dsn := databaseURL(); dsn != "" {
		cfg.Storage.Type = "postgres"
		cfg.Storage.Postgres.DSN = dsn
	}
	switch cfg.Storage.Type {
	case "postgres":
		s, err := NewPostgresStorage(cfg)
		if err != nil {
			return fmt.Errorf("migrate up (postgres): %w", err)
		}
		// Trigger lazy schemas that run on first use (idempotent).
		// ACL tables are migrated here explicitly so they are created in the
		// office schema even before any file is accessed.
		s.ACLStore() // calls PostgresACLStore.migrate() which creates ACL tables
		s.migrateSigningSchema()
		s.migrateSealedSchema()
		s.migrateCommentsSchema()
		s.migrateSuggestionsSchema()
		fmt.Println("migrate up: all postgres migrations applied (schema: office)")
		return nil
	default:
		fmt.Println("migrate up: local (sqlite) storage — migrations applied at startup")
		return nil
	}
}

// MigrationStatus returns a map of table name → exists for all known
// application tables. For the local backend it reports all tables as present
// (they are applied at startup).
//
// DATABASE_URL / VULOS_DATABASE_URL override the config.yaml storage.type,
// consistent with RunMigrations and storage.New.
func MigrationStatus(cfg *config.Config) (map[string]bool, error) {
	status := make(map[string]bool, len(knownTables))
	for _, t := range knownTables {
		status[t] = false
	}

	// Apply env override so `migrate status` reports the live cloud backend.
	if dsn := databaseURL(); dsn != "" {
		cfg.Storage.Type = "postgres"
		cfg.Storage.Postgres.DSN = dsn
	}

	if cfg.Storage.Type != "postgres" {
		// Local/sqlite backend: migrations always run at startup.
		for k := range status {
			status[k] = true
		}
		return status, nil
	}

	s, err := NewPostgresStorage(cfg)
	if err != nil {
		return nil, fmt.Errorf("migrate status (postgres): %w", err)
	}

	// Query the "office" schema — all diwan tables live there so the
	// product can share a single Neon database with other VulOS products.
	rows, err := s.pool.Query(context.Background(),
		`SELECT table_name FROM information_schema.tables
		 WHERE table_schema = 'office' AND table_type = 'BASE TABLE'`)
	if err != nil {
		return nil, fmt.Errorf("migrate status: query tables: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			continue
		}
		if _, known := status[name]; known {
			status[name] = true
		}
	}
	return status, rows.Err()
}
