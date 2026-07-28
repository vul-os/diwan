package storage

import (
	"context"
	"os"
	"testing"

	"diwan/backend/fileacl"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Compile-time guarantee that the co-located Postgres ACL store satisfies the
// fileacl.Store contract and that PostgresStorage advertises ACLProvider.
var (
	_ fileacl.Store = (*PostgresACLStore)(nil)
	_ ACLProvider   = (*PostgresStorage)(nil)
)

// newTestPool opens a pgxpool pinned to the "office" schema (matching
// production) and ensures the schema exists. Callers must defer pool.Close().
func newTestPool(t *testing.T, dsn string) *pgxpool.Pool {
	t.Helper()
	poolCfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatalf("parse DSN: %v", err)
	}
	poolCfg.ConnConfig.RuntimeParams["search_path"] = "office"
	pool, err := pgxpool.NewWithConfig(context.Background(), poolCfg)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	ctx := context.Background()
	// Ensure the office schema exists — mirrors what NewPostgresStorage does.
	if _, err := pool.Exec(ctx, `CREATE SCHEMA IF NOT EXISTS office`); err != nil {
		pool.Close()
		t.Fatalf("create schema office: %v", err)
	}
	return pool
}

// TestPostgresACLContract exercises the full fileacl.Store contract against a
// real Postgres instance. It is SKIPPED unless VULOS_TEST_POSTGRES_DSN points
// at a throwaway database (CI without Postgres still passes; the logic is
// shared SQL identical in shape to the proven sqlite store).
//
// The test operates in the "office" schema — the same schema used in
// production — so foreign-key constraints and index names match exactly.
func TestPostgresACLContract(t *testing.T) {
	dsn := os.Getenv("VULOS_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("set VULOS_TEST_POSTGRES_DSN to run the Postgres ACL contract test")
	}
	pool := newTestPool(t, dsn)
	defer pool.Close()

	ctx := context.Background()
	// The ACL tables FK to files(id) in the office schema.
	// Ensure a files table + seed rows exist so SetOwner/Share for "f1"
	// satisfy the foreign key.
	if _, err := pool.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS files (
			id TEXT PRIMARY KEY, name TEXT, type TEXT, content JSONB,
			created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
		);`); err != nil {
		t.Fatalf("files table: %v", err)
	}
	// Clean slate for the test ids.
	_, _ = pool.Exec(ctx, `DELETE FROM file_acl_shares WHERE file_id IN ('f1','doc')`)
	_, _ = pool.Exec(ctx, `DELETE FROM file_acl_owners WHERE file_id IN ('f1','doc')`)
	_, _ = pool.Exec(ctx, `INSERT INTO files (id, name, type) VALUES ('f1','f1','doc') ON CONFLICT DO NOTHING`)

	s := &PostgresStorage{pool: pool}
	acl := s.ACLStore()

	// Unknown file → unowned/allowed.
	if a, rec, _ := acl.CanAccess("nope", "anyone"); !a || rec {
		t.Fatalf("unknown file: allowed=%v recorded=%v", a, rec)
	}
	// Owner + non-owner.
	if err := acl.SetOwner("f1", "alice"); err != nil {
		t.Fatalf("SetOwner: %v", err)
	}
	if a, rec, _ := acl.CanAccess("f1", "alice"); !a || !rec {
		t.Fatalf("owner access: allowed=%v recorded=%v", a, rec)
	}
	if a, _, _ := acl.CanAccess("f1", "bob"); a {
		t.Fatal("non-owner should be denied")
	}
	// Share / unshare (default editor role).
	if err := acl.Share("f1", "bob"); err != nil {
		t.Fatalf("Share: %v", err)
	}
	if a, _, _ := acl.CanAccess("f1", "bob"); !a {
		t.Fatal("shared account should have access")
	}
	ids, _ := acl.AccessibleFileIDs("bob")
	if !ids["f1"] {
		t.Fatal("AccessibleFileIDs should include shared f1 for bob")
	}
	if err := acl.Unshare("f1", "bob"); err != nil {
		t.Fatalf("Unshare: %v", err)
	}
	if a, _, _ := acl.CanAccess("f1", "bob"); a {
		t.Fatal("unshared account should lose access")
	}
	// Deleting the FILE cascades the ACL away (transactional travel-with-files).
	if _, err := pool.Exec(ctx, `DELETE FROM files WHERE id='f1'`); err != nil {
		t.Fatalf("delete file: %v", err)
	}
	if _, ok, _ := acl.Get("f1"); ok {
		t.Fatal("ACL should be cascade-deleted with the file")
	}
}

// TestPostgresACLRoles verifies that owner/editor/viewer roles round-trip
// correctly in the Postgres ACL store and that GetRole returns the right role
// for each collaborator type.
func TestPostgresACLRoles(t *testing.T) {
	dsn := os.Getenv("VULOS_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("set VULOS_TEST_POSTGRES_DSN to run the Postgres ACL role test")
	}
	pool := newTestPool(t, dsn)
	defer pool.Close()

	ctx := context.Background()
	if _, err := pool.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS files (
			id TEXT PRIMARY KEY, name TEXT, type TEXT, content JSONB,
			created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
		);`); err != nil {
		t.Fatalf("files table: %v", err)
	}
	// Seed a test file and wipe any leftover rows.
	_, _ = pool.Exec(ctx, `DELETE FROM file_acl_shares WHERE file_id = 'role-test'`)
	_, _ = pool.Exec(ctx, `DELETE FROM file_acl_owners WHERE file_id = 'role-test'`)
	_, _ = pool.Exec(ctx, `INSERT INTO files (id, name, type) VALUES ('role-test','rt','doc') ON CONFLICT DO NOTHING`)

	s := &PostgresStorage{pool: pool}
	acl := s.ACLStore()

	// Owner role.
	if err := acl.SetOwner("role-test", "owner1"); err != nil {
		t.Fatalf("SetOwner: %v", err)
	}
	role, found, err := acl.GetRole("role-test", "owner1")
	if err != nil || !found || role != fileacl.RoleOwner {
		t.Fatalf("owner role: got %q found=%v err=%v", role, found, err)
	}

	// Editor role.
	if err := acl.ShareWithRole("role-test", "editor1", fileacl.RoleEditor); err != nil {
		t.Fatalf("ShareWithRole editor: %v", err)
	}
	role, found, err = acl.GetRole("role-test", "editor1")
	if err != nil || !found || role != fileacl.RoleEditor {
		t.Fatalf("editor role: got %q found=%v err=%v", role, found, err)
	}

	// Viewer role.
	if err := acl.ShareWithRole("role-test", "viewer1", fileacl.RoleViewer); err != nil {
		t.Fatalf("ShareWithRole viewer: %v", err)
	}
	role, found, err = acl.GetRole("role-test", "viewer1")
	if err != nil || !found || role != fileacl.RoleViewer {
		t.Fatalf("viewer role: got %q found=%v err=%v", role, found, err)
	}

	// Role upgrade: viewer → editor.
	if err := acl.ShareWithRole("role-test", "viewer1", fileacl.RoleEditor); err != nil {
		t.Fatalf("ShareWithRole upgrade: %v", err)
	}
	role, _, _ = acl.GetRole("role-test", "viewer1")
	if role != fileacl.RoleEditor {
		t.Fatalf("role upgrade failed: got %q, want editor", role)
	}

	// Unknown account → RoleNone.
	role, found, err = acl.GetRole("role-test", "nobody")
	if err != nil || found || role != fileacl.RoleNone {
		t.Fatalf("unknown account: got %q found=%v err=%v", role, found, err)
	}

	// Cleanup.
	_, _ = pool.Exec(ctx, `DELETE FROM file_acl_shares WHERE file_id = 'role-test'`)
	_, _ = pool.Exec(ctx, `DELETE FROM file_acl_owners WHERE file_id = 'role-test'`)
	_, _ = pool.Exec(ctx, `DELETE FROM files WHERE id = 'role-test'`)
}
