package main

// cmd_migrate.go — `diwan migrate` subcommand.
//
// Usage:
//
//	diwan migrate up     — connect to the configured storage backend
//	                              and apply all schema migrations (idempotent).
//	diwan migrate status — print which application tables are present.
//
// Both forms read config.yaml (same as the server). When no config is found,
// sensible defaults are used (local sqlite storage).
//
// Cloud / ops usage (out-of-band, before first server boot or after an upgrade):
//
//	diwan migrate up
//	# → "migrate up: all postgres migrations applied"

import (
	"flag"
	"fmt"
	"log"
	"os"
	"sort"

	"diwan/backend/config"
	"diwan/backend/storage"
)

// runMigrate is the entry point for the `migrate` subcommand.
func runMigrate(args []string) {
	fs := flag.NewFlagSet("migrate", flag.ExitOnError)
	configPath := fs.String("config", "config.yaml", "path to config file")
	_ = fs.Parse(args)

	subcmd := "up"
	if fs.NArg() > 0 {
		subcmd = fs.Arg(0)
	}

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Printf("migrate: config load warning (%v) — using defaults", err)
		cfg = config.Default()
	}

	switch subcmd {
	case "up":
		if err := storage.RunMigrations(cfg); err != nil {
			fmt.Fprintln(os.Stderr, "migrate up:", err)
			os.Exit(1)
		}

	case "status":
		statuses, err := storage.MigrationStatus(cfg)
		if err != nil {
			fmt.Fprintln(os.Stderr, "migrate status:", err)
			os.Exit(1)
		}
		// Print in deterministic order.
		tables := make([]string, 0, len(statuses))
		for t := range statuses {
			tables = append(tables, t)
		}
		sort.Strings(tables)
		fmt.Printf("%-30s %s\n", "TABLE", "STATUS")
		for _, t := range tables {
			state := "missing"
			if statuses[t] {
				state = "ok"
			}
			fmt.Printf("%-30s %s\n", t, state)
		}

	default:
		fmt.Fprintf(os.Stderr, "migrate: unknown subcommand %q (valid: up, status)\n", subcmd)
		os.Exit(2)
	}
}
