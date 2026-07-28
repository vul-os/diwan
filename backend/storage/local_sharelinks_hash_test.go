package storage

// local_sharelinks_hash_test.go — the share-link store must hold HASHES, never
// live tokens, and must convert a pre-hash data directory in place without
// killing the links people are already holding.
//
// Each test here fails loudly if the fix is reverted: the first two by finding
// the plaintext token on disk, the third by failing to resolve a legacy link.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"diwan/backend/config"
	"diwan/backend/models"
	"diwan/backend/signing"
)

// realisticToken is shaped exactly like signing.GenerateShareLinkToken output
// (43 base64url chars), so the "43 chars vs 64 hex chars" discriminator the
// migration relies on is exercised for real rather than against a stub.
const realisticToken = "Qm9ndXNUb2tlbkZvclRlc3RzT25seV9ub3RSYW5kb20"

func sharelinkFiles(t *testing.T, s *LocalStorage) []string {
	t.Helper()
	entries, err := os.ReadDir(s.shareLinksDir())
	if err != nil {
		t.Fatalf("read sharelinks dir: %v", err)
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

// TestLocalShareLinks_TokenNeverHitsDisk is the regression for the defect this
// store had: it wrote the LIVE token as both the filename and a `token` field,
// so anyone who could read data/sharelinks/ held working capabilities.
func TestLocalShareLinks_TokenNeverHitsDisk(t *testing.T) {
	s := newOrgStore(t)
	in := &models.ShareLink{
		ID: "link1", FileID: "fileA", Token: realisticToken,
		CreatedBy: "alice", CreatedAt: time.Now(),
	}
	if err := s.CreateShareLink(in); err != nil {
		t.Fatalf("CreateShareLink: %v", err)
	}

	names := sharelinkFiles(t, s)
	if len(names) != 1 {
		t.Fatalf("expected exactly one record file, got %v", names)
	}
	wantName := signing.HashShareLinkToken(realisticToken) + ".json"
	if names[0] != wantName {
		t.Fatalf("record must be keyed by token hash: got %q, want %q", names[0], wantName)
	}

	// The bytes on disk must not contain the token in any form.
	raw, err := os.ReadFile(filepath.Join(s.shareLinksDir(), names[0]))
	if err != nil {
		t.Fatalf("read record: %v", err)
	}
	if strings.Contains(string(raw), realisticToken) {
		t.Fatalf("PLAINTEXT TOKEN ON DISK — record contains the live token:\n%s", raw)
	}
	// And no `token` key at all, so nothing can grow back into one.
	var onDisk map[string]any
	if err := json.Unmarshal(raw, &onDisk); err != nil {
		t.Fatalf("record is not JSON: %v", err)
	}
	if _, ok := onDisk["token"]; ok {
		t.Fatalf("record still carries a `token` field: %s", raw)
	}
	if got := onDisk["token_hash"]; got != signing.HashShareLinkToken(realisticToken) {
		t.Fatalf("token_hash wrong on disk: %v", got)
	}

	// Files are 0600: the record still holds the bcrypt password hash, which is
	// the whole gate for a password-protected link.
	info, err := os.Stat(filepath.Join(s.shareLinksDir(), names[0]))
	if err != nil {
		t.Fatalf("stat record: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0600 {
		t.Fatalf("record permissions: got %04o, want 0600", perm)
	}
}

// TestLocalShareLinks_ReadPathsReturnNoToken proves the store cannot hand a
// token back to any caller — which is what makes the HTTP layer's
// `json:"token,omitempty"` an actual guarantee rather than a hope.
func TestLocalShareLinks_ReadPathsReturnNoToken(t *testing.T) {
	s := newOrgStore(t)
	if err := s.CreateShareLink(&models.ShareLink{
		ID: "link1", FileID: "fileA", Token: realisticToken, CreatedAt: time.Now(),
	}); err != nil {
		t.Fatalf("CreateShareLink: %v", err)
	}

	got, err := s.GetShareLinkByToken(realisticToken)
	if err != nil {
		t.Fatalf("GetShareLinkByToken: %v", err)
	}
	if got.Token != "" {
		t.Fatalf("Get must not return a token, got %q", got.Token)
	}
	if got.TokenHash != signing.HashShareLinkToken(realisticToken) {
		t.Fatalf("TokenHash not populated on read: %q", got.TokenHash)
	}

	links, err := s.ListShareLinks("fileA")
	if err != nil || len(links) != 1 {
		t.Fatalf("ListShareLinks: %v links=%d", err, len(links))
	}
	if links[0].Token != "" {
		t.Fatalf("List must not return a token, got %q", links[0].Token)
	}

	// Presenting the HASH where a token is expected must NOT resolve: it would
	// mean a leaked store was still a leaked capability.
	if _, err := s.GetShareLinkByToken(signing.HashShareLinkToken(realisticToken)); err == nil {
		t.Fatal("the stored hash must not itself work as a token")
	}

	// A minted link with no token is a programming error, not a silent no-op.
	if err := s.CreateShareLink(&models.ShareLink{ID: "x", FileID: "fileA"}); err == nil {
		t.Fatal("CreateShareLink with an empty token must error")
	}
}

// TestLocalShareLinks_MigrationFailsLoudlyOnAnUnreadableRecord pins the choice
// NOT to skip a record it cannot parse. Skipping would report a successful
// migration while leaving a live plaintext-keyed link on disk — a silent half
// migration, which is worse than refusing to start.
func TestLocalShareLinks_MigrationFailsLoudlyOnAnUnreadableRecord(t *testing.T) {
	dataDir := t.TempDir()
	dir := filepath.Join(dataDir, "sharelinks")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	junk := filepath.Join(dir, "SomeLegacyTokenName.json")
	if err := os.WriteFile(junk, []byte("{not json"), 0600); err != nil {
		t.Fatalf("write junk record: %v", err)
	}

	cfg := config.Default()
	cfg.Server.DataDir = dataDir
	_, err := NewLocalStorage(cfg)
	if err == nil {
		t.Fatal("startup must FAIL on an unparseable share-link record, not skip it")
	}
	// The message has to name the file, or the operator cannot act on it.
	if !strings.Contains(err.Error(), "SomeLegacyTokenName.json") {
		t.Fatalf("error must name the offending file, got: %v", err)
	}
	// The record is left alone, so nothing is destroyed by the failed start.
	if _, serr := os.Stat(junk); serr != nil {
		t.Fatalf("a failed migration must not delete the record it could not read: %v", serr)
	}
}

// TestLocalShareLinks_MigratesLegacyPlaintextRecords is the compatibility half
// of the fix: a data directory written by the previous release must convert in
// place, and the URLs users already hold must keep working.
func TestLocalShareLinks_MigratesLegacyPlaintextRecords(t *testing.T) {
	// Seed the data dir BEFORE the store is built: that is the real sequence —
	// an operator upgrades the binary and starts it against a directory the
	// previous release wrote.
	dataDir := t.TempDir()
	dir := filepath.Join(dataDir, "sharelinks")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	// Hand-write a record in the OLD format: filename is the token, and the
	// body carries it too.
	exp := time.Now().Add(time.Hour)
	legacy := map[string]any{
		"id":            "legacy-1",
		"file_id":       "fileA",
		"token":         realisticToken,
		"created_by":    "alice",
		"password_hash": "$2a$10$fakehashfakehashfakehashfakehashfakehashfakehashfa",
		"expires_at":    exp.Format(time.RFC3339Nano),
		"revoked":       false,
		"created_at":    time.Now().Format(time.RFC3339Nano),
	}
	body, _ := json.MarshalIndent(legacy, "", "  ")
	legacyPath := filepath.Join(dir, realisticToken+".json")
	if err := os.WriteFile(legacyPath, body, 0644); err != nil {
		t.Fatalf("write legacy record: %v", err)
	}

	// Starting the server is what converts the directory.
	cfg := config.Default()
	cfg.Server.DataDir = dataDir
	s, err := NewLocalStorage(cfg)
	if err != nil {
		t.Fatalf("NewLocalStorage over a pre-fix data dir: %v", err)
	}

	// The link a user is already holding still resolves.
	got, err := s.GetShareLinkByToken(realisticToken)
	if err != nil {
		t.Fatalf("legacy link must keep working after the change: %v", err)
	}
	if got.ID != "legacy-1" || got.FileID != "fileA" {
		t.Fatalf("legacy record did not survive migration: %+v", got)
	}
	if got.PasswordHash != legacy["password_hash"] {
		t.Fatalf("bcrypt gate lost in migration: %q", got.PasswordHash)
	}
	if got.ExpiresAt == nil {
		t.Fatal("expiry lost in migration")
	}

	// …and the plaintext is gone from disk.
	if _, err := os.Stat(legacyPath); !os.IsNotExist(err) {
		t.Fatalf("legacy plaintext-named record still present: %v", err)
	}
	names := sharelinkFiles(t, s)
	if len(names) != 1 || names[0] != signing.HashShareLinkToken(realisticToken)+".json" {
		t.Fatalf("expected exactly the hash-keyed record, got %v", names)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, names[0]))
	if strings.Contains(string(raw), realisticToken) {
		t.Fatalf("migration left the plaintext token in the record:\n%s", raw)
	}

	// Migration is idempotent: restarting over the already-converted directory
	// changes nothing and the link still resolves. (A second restart is the
	// realistic case — the first one is not the last time the server boots.)
	s2, err := NewLocalStorage(cfg)
	if err != nil {
		t.Fatalf("second NewLocalStorage over the converted dir: %v", err)
	}
	if _, err := s2.GetShareLinkByToken(realisticToken); err != nil {
		t.Fatalf("link stopped resolving after a second start: %v", err)
	}
	if names2 := sharelinkFiles(t, s2); len(names2) != 1 || names2[0] != names[0] {
		t.Fatalf("migration is not idempotent: %v then %v", names, names2)
	}
}
