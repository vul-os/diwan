// Package invites implements single-use / expiring registration invite tokens.
//
// Motivation
// ----------
// Registration on a bootstrapped instance was previously gated behind a single
// static DIWAN_REGISTRATION_TOKEN (a shared secret that never expires
// and can be reused indefinitely). This package adds proper invite tokens that
// an admin mints on demand:
//
//   - the raw token is shown ONCE at mint time and never stored;
//   - only a SHA-256 hash is persisted (so a DB leak does not reveal usable
//     tokens);
//   - each token has an expiry and a use-count cap (default 1 = single use);
//   - tokens can be revoked;
//   - Consume is atomic (transaction-guarded) so a token cannot be redeemed
//     past its cap under concurrency.
//
// The static-token and admin-JWT registration paths are preserved (see
// handlers/auth.go) — invite tokens are an additional, stronger option.
//
// Persistence is pure-Go modernc SQLite (no CGO), mirroring fileacl/userauth.
package invites

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// Errors returned by the store.
var (
	ErrNotFound = errors.New("invites: token not found")
	ErrExpired  = errors.New("invites: token expired")
	ErrConsumed = errors.New("invites: token already used up")
	ErrRevoked  = errors.New("invites: token revoked")
)

// Invite is the metadata for a minted token (never includes the raw secret).
type Invite struct {
	ID        string `json:"id"`         // public id (the token hash hex)
	CreatedBy string `json:"created_by"` // admin account id that minted it
	Note      string `json:"note"`       // free-form label (e.g. invitee email)
	MaxUses   int    `json:"max_uses"`
	UsedCount int    `json:"used_count"`
	ExpiresAt int64  `json:"expires_at"` // unix seconds; 0 = never
	CreatedAt int64  `json:"created_at"`
	Revoked   bool   `json:"revoked"`
}

// Active reports whether the invite can still be redeemed at time now.
func (i Invite) Active(now time.Time) bool {
	if i.Revoked {
		return false
	}
	if i.MaxUses > 0 && i.UsedCount >= i.MaxUses {
		return false
	}
	if i.ExpiresAt > 0 && now.Unix() >= i.ExpiresAt {
		return false
	}
	return true
}

// Store is the persistence interface for invite tokens.
type Store interface {
	// Mint creates a new invite and returns the RAW token (shown once) plus the
	// stored metadata. maxUses<=0 defaults to 1 (single-use). ttl<=0 means the
	// token never expires.
	Mint(createdBy, note string, maxUses int, ttl time.Duration) (rawToken string, inv Invite, err error)
	// Consume atomically validates and redeems rawToken. On success the use-count
	// is incremented inside a transaction. Returns ErrNotFound / ErrExpired /
	// ErrConsumed / ErrRevoked when the token cannot be redeemed.
	Consume(rawToken string) (Invite, error)
	// Valid reports whether rawToken could currently be redeemed WITHOUT
	// consuming it. Used to authorize a registration attempt before committing
	// (so a token is only burned once the account is actually created). Returns
	// the same sentinel errors as Consume on failure.
	Valid(rawToken string) (Invite, error)
	// List returns all invites (metadata only) most-recent first.
	List() ([]Invite, error)
	// Revoke marks the invite identified by id (the token hash hex) revoked.
	Revoke(id string) error
	Close() error
}

// hashToken returns the hex SHA-256 of a raw token. The hash is the stored id.
func hashToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

// newRawToken returns a 256-bit URL-safe random token.
func newRawToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// ---------------------------------------------------------------------------
// SQLiteStore
// ---------------------------------------------------------------------------

type SQLiteStore struct {
	db *sql.DB
}

func NewSQLiteStore(dsn string) (*SQLiteStore, error) {
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("invites: open db: %w", err)
	}
	db.SetMaxOpenConns(1)
	s := &SQLiteStore{db: db}
	if err := s.init(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *SQLiteStore) init() error {
	_, err := s.db.Exec(`
		CREATE TABLE IF NOT EXISTS invites (
			id         TEXT PRIMARY KEY,       -- sha256(raw) hex
			created_by TEXT NOT NULL DEFAULT '',
			note       TEXT NOT NULL DEFAULT '',
			max_uses   INTEGER NOT NULL DEFAULT 1,
			used_count INTEGER NOT NULL DEFAULT 0,
			expires_at INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL DEFAULT 0,
			revoked    INTEGER NOT NULL DEFAULT 0
		);
	`)
	if err != nil {
		return fmt.Errorf("invites: init schema: %w", err)
	}
	return nil
}

func (s *SQLiteStore) Close() error {
	if s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *SQLiteStore) Mint(createdBy, note string, maxUses int, ttl time.Duration) (string, Invite, error) {
	if maxUses <= 0 {
		maxUses = 1
	}
	raw, err := newRawToken()
	if err != nil {
		return "", Invite{}, err
	}
	now := time.Now()
	inv := Invite{
		ID:        hashToken(raw),
		CreatedBy: createdBy,
		Note:      note,
		MaxUses:   maxUses,
		UsedCount: 0,
		CreatedAt: now.Unix(),
	}
	if ttl > 0 {
		inv.ExpiresAt = now.Add(ttl).Unix()
	}
	_, err = s.db.Exec(
		`INSERT INTO invites (id, created_by, note, max_uses, used_count, expires_at, created_at, revoked)
		 VALUES (?, ?, ?, ?, 0, ?, ?, 0)`,
		inv.ID, inv.CreatedBy, inv.Note, inv.MaxUses, inv.ExpiresAt, inv.CreatedAt)
	if err != nil {
		return "", Invite{}, err
	}
	return raw, inv, nil
}

func (s *SQLiteStore) Valid(rawToken string) (Invite, error) {
	id := hashToken(rawToken)
	var inv Invite
	var revoked int
	err := s.db.QueryRow(
		`SELECT id, created_by, note, max_uses, used_count, expires_at, created_at, revoked
		 FROM invites WHERE id = ?`, id).
		Scan(&inv.ID, &inv.CreatedBy, &inv.Note, &inv.MaxUses, &inv.UsedCount,
			&inv.ExpiresAt, &inv.CreatedAt, &revoked)
	switch err {
	case nil:
	case sql.ErrNoRows:
		return Invite{}, ErrNotFound
	default:
		return Invite{}, err
	}
	inv.Revoked = revoked != 0
	return validateInvite(inv)
}

// validateInvite returns inv when it is currently redeemable, else the matching
// sentinel error.
func validateInvite(inv Invite) (Invite, error) {
	now := time.Now()
	if inv.Revoked {
		return Invite{}, ErrRevoked
	}
	if inv.ExpiresAt > 0 && now.Unix() >= inv.ExpiresAt {
		return Invite{}, ErrExpired
	}
	if inv.MaxUses > 0 && inv.UsedCount >= inv.MaxUses {
		return Invite{}, ErrConsumed
	}
	return inv, nil
}

func (s *SQLiteStore) Consume(rawToken string) (Invite, error) {
	id := hashToken(rawToken)
	tx, err := s.db.Begin()
	if err != nil {
		return Invite{}, err
	}
	defer tx.Rollback() //nolint:errcheck — no-op after a successful Commit

	var inv Invite
	var revoked int
	err = tx.QueryRow(
		`SELECT id, created_by, note, max_uses, used_count, expires_at, created_at, revoked
		 FROM invites WHERE id = ?`, id).
		Scan(&inv.ID, &inv.CreatedBy, &inv.Note, &inv.MaxUses, &inv.UsedCount,
			&inv.ExpiresAt, &inv.CreatedAt, &revoked)
	switch err {
	case nil:
	case sql.ErrNoRows:
		return Invite{}, ErrNotFound
	default:
		return Invite{}, err
	}
	inv.Revoked = revoked != 0
	if _, verr := validateInvite(inv); verr != nil {
		return Invite{}, verr
	}
	if _, err := tx.Exec(`UPDATE invites SET used_count = used_count + 1 WHERE id = ?`, id); err != nil {
		return Invite{}, err
	}
	if err := tx.Commit(); err != nil {
		return Invite{}, err
	}
	inv.UsedCount++
	return inv, nil
}

func (s *SQLiteStore) List() ([]Invite, error) {
	rows, err := s.db.Query(
		`SELECT id, created_by, note, max_uses, used_count, expires_at, created_at, revoked
		 FROM invites ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Invite
	for rows.Next() {
		var inv Invite
		var revoked int
		if err := rows.Scan(&inv.ID, &inv.CreatedBy, &inv.Note, &inv.MaxUses,
			&inv.UsedCount, &inv.ExpiresAt, &inv.CreatedAt, &revoked); err != nil {
			return nil, err
		}
		inv.Revoked = revoked != 0
		out = append(out, inv)
	}
	return out, rows.Err()
}

func (s *SQLiteStore) Revoke(id string) error {
	res, err := s.db.Exec(`UPDATE invites SET revoked = 1 WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// ---------------------------------------------------------------------------
// NullStore — in-memory backend for tests / degraded mode
// ---------------------------------------------------------------------------

type NullStore struct {
	mu      sync.Mutex
	invites map[string]*Invite
}

func NewNullStore() *NullStore {
	return &NullStore{invites: make(map[string]*Invite)}
}

func (n *NullStore) Mint(createdBy, note string, maxUses int, ttl time.Duration) (string, Invite, error) {
	if maxUses <= 0 {
		maxUses = 1
	}
	raw, err := newRawToken()
	if err != nil {
		return "", Invite{}, err
	}
	now := time.Now()
	inv := Invite{
		ID:        hashToken(raw),
		CreatedBy: createdBy,
		Note:      note,
		MaxUses:   maxUses,
		CreatedAt: now.Unix(),
	}
	if ttl > 0 {
		inv.ExpiresAt = now.Add(ttl).Unix()
	}
	n.mu.Lock()
	cp := inv
	n.invites[inv.ID] = &cp
	n.mu.Unlock()
	return raw, inv, nil
}

func (n *NullStore) Valid(rawToken string) (Invite, error) {
	id := hashToken(rawToken)
	n.mu.Lock()
	defer n.mu.Unlock()
	inv, ok := n.invites[id]
	if !ok {
		return Invite{}, ErrNotFound
	}
	return validateInvite(*inv)
}

func (n *NullStore) Consume(rawToken string) (Invite, error) {
	id := hashToken(rawToken)
	n.mu.Lock()
	defer n.mu.Unlock()
	inv, ok := n.invites[id]
	if !ok {
		return Invite{}, ErrNotFound
	}
	if _, err := validateInvite(*inv); err != nil {
		return Invite{}, err
	}
	inv.UsedCount++
	return *inv, nil
}

func (n *NullStore) List() ([]Invite, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	out := make([]Invite, 0, len(n.invites))
	for _, inv := range n.invites {
		out = append(out, *inv)
	}
	return out, nil
}

func (n *NullStore) Revoke(id string) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	inv, ok := n.invites[id]
	if !ok {
		return ErrNotFound
	}
	inv.Revoked = true
	return nil
}

func (n *NullStore) Close() error { return nil }
