package storage

// postgres_sharelinks_test.go — the Postgres half of the share-link token-hash
// fix, against a REAL database: the backfill of pre-fix rows (which held the
// live token in share_links.token) and the guarantee that a freshly minted row
// never contains the token at all.
//
// The local backend's equivalents live in local_sharelinks_hash_test.go. Both
// exist because the two backends migrate by completely different mechanisms —
// a file rename here, an UPDATE there — and a passing file-store test says
// nothing about a deployed Postgres.
//
// Skipped unless VULOS_TEST_POSTGRES_DSN points at a throwaway database (same
// gate as the storage contract test). CI's go-postgres job sets it.

import (
	"os"
	"testing"
	"time"

	"diwan/backend/config"
	"diwan/backend/models"
	"diwan/backend/signing"
)

func newPostgresStoreForShareLinks(t *testing.T) *PostgresStorage {
	t.Helper()
	dsn := os.Getenv("VULOS_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("set VULOS_TEST_POSTGRES_DSN to run the Postgres share-link token-hash tests " +
			"(NOT VERIFIED without it: the plaintext-token backfill and the no-plaintext-in-share_links guarantee)")
	}
	t.Setenv("DATABASE_URL", dsn)
	store, err := New(config.Default())
	if err != nil {
		t.Fatalf("New (postgres via DATABASE_URL): %v", err)
	}
	return store.(*PostgresStorage)
}

// seedShareLinkFile creates the parent file row (share_links has an FK to it)
// and registers cleanup; the FK cascade removes the links.
func seedShareLinkFile(t *testing.T, pg *PostgresStorage, id string) {
	t.Helper()
	_, _ = pg.pool.Exec(t.Context(), `DELETE FROM files WHERE id = $1`, id)
	if err := pg.CreateFile(&models.File{ID: id, Name: "Shared", Type: models.FileTypeDoc, Content: "x"}); err != nil {
		t.Fatalf("CreateFile: %v", err)
	}
	t.Cleanup(func() { _, _ = pg.pool.Exec(t.Context(), `DELETE FROM files WHERE id = $1`, id) })
}

// TestPostgresShareLink_LegacyPlaintextRowIsBackfilled writes a row exactly as
// the pre-fix code did — token column = the live token — and proves that the
// link a user already holds keeps working while the plaintext leaves the table.
func TestPostgresShareLink_LegacyPlaintextRowIsBackfilled(t *testing.T) {
	seeder := newPostgresStoreForShareLinks(t)
	const fileID = "pg-sharelink-legacy-file"
	seedShareLinkFile(t, seeder, fileID)

	const rawToken = "TGVnYWN5UGxhaW50ZXh0VG9rZW5fNDNjaGFyc19va2F5MDE"
	hash := signing.HashShareLinkToken(rawToken)

	// Pre-fix INSERT: the live token goes straight into the key column.
	if _, err := seeder.pool.Exec(t.Context(),
		`INSERT INTO share_links (id, file_id, token, created_by, password_hash, expires_at, revoked, created_at)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
		"pg-legacy-link", fileID, rawToken, "alice", "", nil, false, time.Now()); err != nil {
		t.Fatalf("seed legacy row: %v", err)
	}

	// Now START A SERVER against that database — that is the sequence an
	// operator performs, and the boot-time backfill is what must convert the
	// row. (The seeding store above already ran its own backfill before the row
	// existed, which is exactly why a fresh one is needed here.)
	pg := newPostgresStoreForShareLinks(t)

	// The URL the user is holding still opens the link.
	got, err := pg.GetShareLinkByToken(rawToken)
	if err != nil {
		t.Fatalf("legacy link must keep working after the change: %v", err)
	}
	if got.ID != "pg-legacy-link" || got.FileID != fileID {
		t.Fatalf("legacy row did not survive the backfill: %+v", got)
	}
	if got.TokenHash != hash {
		t.Fatalf("row was not converted to its hash: %q", got.TokenHash)
	}

	// The plaintext must be gone from the table entirely.
	var remaining int
	if err := pg.pool.QueryRow(t.Context(),
		`SELECT count(*) FROM share_links WHERE token = $1`, rawToken).Scan(&remaining); err != nil {
		t.Fatalf("count plaintext rows: %v", err)
	}
	if remaining != 0 {
		t.Fatalf("PLAINTEXT TOKEN STILL IN share_links: %d row(s)", remaining)
	}

	// Nothing in the table may be shaped like a raw token any more.
	var unhashed int
	if err := pg.pool.QueryRow(t.Context(),
		`SELECT count(*) FROM share_links WHERE token !~ '^[0-9a-f]{64}$'`).Scan(&unhashed); err != nil {
		t.Fatalf("count unhashed rows: %v", err)
	}
	if unhashed != 0 {
		t.Fatalf("%d share_links row(s) still hold a non-hash key", unhashed)
	}
}

// TestPostgresShareLink_MintStoresOnlyTheHash is the forward half: a link minted
// through the normal path must leave no token behind, and no read path may
// return one.
func TestPostgresShareLink_MintStoresOnlyTheHash(t *testing.T) {
	pg := newPostgresStoreForShareLinks(t)
	const fileID = "pg-sharelink-mint-file"
	seedShareLinkFile(t, pg, fileID)

	const rawToken = "TWludGVkVG9rZW5Ob3RSYW5kb21fNDNjaGFyc19va2F5MDE"
	link := &models.ShareLink{ID: "pg-mint-link", FileID: fileID, Token: rawToken, CreatedAt: time.Now()}
	if err := pg.CreateShareLink(link); err != nil {
		t.Fatalf("CreateShareLink: %v", err)
	}

	var stored string
	if err := pg.pool.QueryRow(t.Context(),
		`SELECT token FROM share_links WHERE id = $1`, "pg-mint-link").Scan(&stored); err != nil {
		t.Fatalf("read back row: %v", err)
	}
	if stored == rawToken {
		t.Fatal("PLAINTEXT TOKEN WRITTEN TO share_links.token")
	}
	if stored != signing.HashShareLinkToken(rawToken) {
		t.Fatalf("stored key is not the token hash: %q", stored)
	}

	if _, err := pg.GetShareLinkByToken(stored); err == nil {
		t.Fatal("the stored hash must not itself work as a token")
	}
	links, err := pg.ListShareLinks(fileID)
	if err != nil || len(links) != 1 {
		t.Fatalf("ListShareLinks: err=%v n=%d", err, len(links))
	}
	if links[0].Token != "" {
		t.Fatalf("ListShareLinks leaked a token: %q", links[0].Token)
	}
}
