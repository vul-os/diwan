package storage

// backend_contract_test.go — dual-backend Storage interface contract tests.
//
// TestLocalStorageContract runs against the JSON-file local backend (always).
// TestPostgresStorageContract runs against a real Postgres instance when
// VULOS_TEST_POSTGRES_DSN is set; it is skipped otherwise so the default
// go test ./... path (no external services) still passes cleanly.
//
// Both tests exercise the same testStorageContract helper, ensuring that the
// Storage interface contract holds identically for both backends.

import (
	"os"
	"testing"

	"diwan/backend/config"
	"diwan/backend/models"
	"diwan/backend/signing"
)

// testStorageContract is a backend-agnostic verification of the core Storage
// interface: create, get, update, list, delete a file; version history is
// created automatically on update and can be listed and restored.
func testStorageContract(t *testing.T, store Storage) {
	t.Helper()

	// ── File CRUD ────────────────────────────────────────────────────────────
	f := &models.File{
		ID:      "contract-test-file-1",
		Name:    "Contract Test",
		Type:    "doc",
		Content: map[string]any{"type": "doc", "content": []any{}},
	}

	// Create
	if err := store.CreateFile(f); err != nil {
		t.Fatalf("CreateFile: %v", err)
	}

	// Get
	got, err := store.GetFile(f.ID)
	if err != nil {
		t.Fatalf("GetFile: %v", err)
	}
	if got.Name != f.Name {
		t.Fatalf("GetFile name: got %q, want %q", got.Name, f.Name)
	}
	if got.Type != f.Type {
		t.Fatalf("GetFile type: got %q, want %q", got.Type, f.Type)
	}

	// Update (also creates a version snapshot automatically in postgres backend)
	f.Name = "Contract Test Updated"
	if err := store.UpdateFile(f); err != nil {
		t.Fatalf("UpdateFile: %v", err)
	}
	got2, err := store.GetFile(f.ID)
	if err != nil {
		t.Fatalf("GetFile after update: %v", err)
	}
	if got2.Name != "Contract Test Updated" {
		t.Fatalf("UpdateFile name: got %q, want %q", got2.Name, "Contract Test Updated")
	}

	// List — the file must appear
	files, err := store.ListFiles()
	if err != nil {
		t.Fatalf("ListFiles: %v", err)
	}
	found := false
	for _, ff := range files {
		if ff.ID == f.ID {
			found = true
			if ff.Name != "Contract Test Updated" {
				t.Fatalf("ListFiles stale name: got %q", ff.Name)
			}
			break
		}
	}
	if !found {
		t.Fatalf("ListFiles: file %q not found among %d results", f.ID, len(files))
	}

	// ── Version history ───────────────────────────────────────────────────────
	// Create an explicit named version.
	v := &models.FileVersion{
		ID:     "v-contract-1",
		FileID: f.ID,
		Name:   "Named snapshot",
		Label:  "v1-label",
	}
	if err := store.CreateVersion(v); err != nil {
		t.Fatalf("CreateVersion: %v", err)
	}

	versions, err := store.ListVersions(f.ID)
	if err != nil {
		t.Fatalf("ListVersions: %v", err)
	}
	foundVer := false
	for _, vv := range versions {
		if vv.ID == "v-contract-1" {
			foundVer = true
		}
	}
	if !foundVer {
		t.Fatalf("ListVersions: version v-contract-1 not found")
	}

	// GetVersion by ID
	if _, err := store.GetVersion(f.ID, "v-contract-1"); err != nil {
		t.Fatalf("GetVersion: %v", err)
	}

	// LabelVersion
	if err := store.LabelVersion(f.ID, "v-contract-1", "release-1"); err != nil {
		t.Fatalf("LabelVersion: %v", err)
	}

	// PruneVersions (cap=0 → removes all, idempotent)
	if err := store.PruneVersions(f.ID, 0); err != nil {
		t.Fatalf("PruneVersions: %v", err)
	}

	// ── Suggestions (OFFICE-27) ───────────────────────────────────────────────
	sg := &models.Suggestion{
		ID:       "sg-contract-1",
		FileID:   f.ID,
		Kind:     models.SuggestionKind("insert"),
		State:    models.SuggestionState("pending"),
		AuthorID: "alice",
		From:     0,
		To:       5,
		Text:     "Hello",
	}
	if err := store.CreateSuggestion(sg); err != nil {
		t.Fatalf("CreateSuggestion: %v", err)
	}
	sgs, err := store.ListSuggestions(f.ID)
	if err != nil {
		t.Fatalf("ListSuggestions: %v", err)
	}
	if len(sgs) == 0 {
		t.Fatal("ListSuggestions: expected at least 1")
	}
	sg.State = models.SuggestionState("accepted")
	sg.ReviewerID = "bob"
	if err := store.UpdateSuggestion(sg); err != nil {
		t.Fatalf("UpdateSuggestion: %v", err)
	}
	if err := store.DeleteSuggestion(f.ID, sg.ID); err != nil {
		t.Fatalf("DeleteSuggestion: %v", err)
	}

	// ── Share links — the token is stored HASHED on every backend ─────────────
	//
	// This lives in the shared contract rather than in the local-backend test
	// because the defect it guards was a per-backend one: the file store wrote
	// the live token while backend/invites (SQLite) hashed. Any backend that
	// implements Storage must hash, so the assertion belongs where both run.
	linkToken := "Q29udHJhY3RUb2tlbl9ub3RSYW5kb21fNDNjaGFyc19va2F5"
	linkHash := signing.HashShareLinkToken(linkToken)
	sl := &models.ShareLink{
		ID:           "sl-contract-1",
		FileID:       f.ID,
		Token:        linkToken,
		CreatedBy:    "alice",
		PasswordHash: "$2a$10$fakehashfakehashfakehashfakehashfakehashfakehashfa",
	}
	if err := store.CreateShareLink(sl); err != nil {
		t.Fatalf("CreateShareLink: %v", err)
	}
	if sl.TokenHash != linkHash {
		t.Fatalf("CreateShareLink must derive TokenHash itself: got %q", sl.TokenHash)
	}
	gotLink, err := store.GetShareLinkByToken(linkToken)
	if err != nil {
		t.Fatalf("GetShareLinkByToken(raw): %v", err)
	}
	if gotLink.Token != "" {
		t.Fatalf("a read path returned a live token %q — the store must not be able to", gotLink.Token)
	}
	if gotLink.TokenHash != linkHash {
		t.Fatalf("TokenHash round-trip: got %q, want %q", gotLink.TokenHash, linkHash)
	}
	if !gotLink.HasPassword || gotLink.PasswordHash != sl.PasswordHash {
		t.Fatalf("bcrypt password gate did not round-trip: %+v", gotLink)
	}
	// The stored hash must not itself open the link.
	if _, err := store.GetShareLinkByToken(linkHash); err == nil {
		t.Fatal("the stored hash must not work as a token")
	}
	listed, err := store.ListShareLinks(f.ID)
	if err != nil || len(listed) != 1 {
		t.Fatalf("ListShareLinks: err=%v n=%d", err, len(listed))
	}
	if listed[0].Token != "" {
		t.Fatalf("ListShareLinks leaked a token: %q", listed[0].Token)
	}
	if err := store.RevokeShareLink(f.ID, "sl-contract-1"); err != nil {
		t.Fatalf("RevokeShareLink: %v", err)
	}
	revoked, err := store.GetShareLinkByToken(linkToken)
	if err != nil || !revoked.Revoked {
		t.Fatalf("link should read back revoked: err=%v link=%+v", err, revoked)
	}
	// Minting without a token is a caller bug, not a silently keyless record.
	if err := store.CreateShareLink(&models.ShareLink{ID: "sl-contract-2", FileID: f.ID}); err == nil {
		t.Fatal("CreateShareLink with an empty token must error")
	}

	// ── Delete ────────────────────────────────────────────────────────────────
	if err := store.DeleteFile(f.ID); err != nil {
		t.Fatalf("DeleteFile: %v", err)
	}
	if _, err := store.GetFile(f.ID); err == nil {
		t.Fatal("GetFile after DeleteFile: expected error, got nil")
	}
}

// TestLocalStorageContract runs the contract test against the JSON-file backend.
// No external services required — always runs.
func TestLocalStorageContract(t *testing.T) {
	dir := t.TempDir()
	cfg := config.Default()
	cfg.Server.DataDir = dir
	store, err := NewLocalStorage(cfg)
	if err != nil {
		t.Fatalf("NewLocalStorage: %v", err)
	}
	testStorageContract(t, store)
}

// TestPostgresStorageContract runs the contract test against a live Postgres
// instance. Skipped when VULOS_TEST_POSTGRES_DSN is unset (standard CI path).
// Set VULOS_TEST_POSTGRES_DSN to a throwaway database URL to run it.
//
// The test uses the "office" Postgres schema, matching production.
func TestPostgresStorageContract(t *testing.T) {
	dsn := os.Getenv("VULOS_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("set VULOS_TEST_POSTGRES_DSN to run the Postgres storage contract test")
	}

	// Use databaseURL override path to exercise the env-var-driven backend
	// selection (same code path as production when DATABASE_URL is set).
	t.Setenv("DATABASE_URL", dsn)

	cfg := config.Default()
	store, err := New(cfg)
	if err != nil {
		t.Fatalf("New (postgres via DATABASE_URL): %v", err)
	}

	// Ensure clean state: remove any leftover row from a previous interrupted run.
	pg := store.(*PostgresStorage)
	_, _ = pg.pool.Exec(t.Context(), `DELETE FROM files WHERE id = 'contract-test-file-1'`)

	testStorageContract(t, store)
}
