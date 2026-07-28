// Package notify implements a per-account in-app notification store used to
// surface @-mentions (and future activity) to the mentioned user.
//
// SECURITY: every row is addressed to exactly one recipient account. The Store
// only ever queries/mutates BY account id, and the HTTP layer passes the
// VERIFIED requester id — so an account can only ever list or mark-read its own
// notifications, never another account's (no cross-account access / IDOR).
//
// Persistence is pure-Go modernc SQLite (no CGO), mirroring fileacl/audit. A
// NullStore (in-memory) is provided for tests and the degraded/local path.
package notify

import (
	"database/sql"
	"fmt"
	"sort"
	"sync"
	"time"

	"diwan/backend/models"

	"github.com/google/uuid"

	_ "modernc.org/sqlite"
)

// Store is the persistence interface for per-account notifications.
type Store interface {
	// Create inserts a notification. The ID/CreatedAt are filled if empty.
	Create(n *models.Notification) error
	// ListForAccount returns notifications addressed to account, newest-first.
	ListForAccount(account string) ([]*models.Notification, error)
	// MarkRead flips the read flag for id, but ONLY when it belongs to account
	// (ownership guard). Returns ok=false if no such row is owned by account.
	MarkRead(account, id string) (ok bool, err error)
	// MarkAllRead marks every unread notification owned by account as read.
	MarkAllRead(account string) error
	Close() error
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
		return nil, fmt.Errorf("notify: open db: %w", err)
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
		CREATE TABLE IF NOT EXISTS notifications (
			id         TEXT PRIMARY KEY,
			account    TEXT NOT NULL,
			kind       TEXT NOT NULL,
			actor      TEXT NOT NULL DEFAULT '',
			file_id    TEXT NOT NULL DEFAULT '',
			file_name  TEXT NOT NULL DEFAULT '',
			comment_id TEXT NOT NULL DEFAULT '',
			snippet    TEXT NOT NULL DEFAULT '',
			read       INTEGER NOT NULL DEFAULT 0,
			created_at TIMESTAMP NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_notifications_account ON notifications(account, created_at DESC);
	`)
	if err != nil {
		return fmt.Errorf("notify: init schema: %w", err)
	}
	return nil
}

func (s *SQLiteStore) Close() error {
	if s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *SQLiteStore) Create(n *models.Notification) error {
	if n.Account == "" {
		return fmt.Errorf("notify: empty recipient account")
	}
	if n.ID == "" {
		n.ID = uuid.New().String()
	}
	if n.CreatedAt.IsZero() {
		n.CreatedAt = time.Now().UTC()
	}
	_, err := s.db.Exec(
		`INSERT INTO notifications (id, account, kind, actor, file_id, file_name, comment_id, snippet, read, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		n.ID, n.Account, string(n.Kind), n.Actor, n.FileID, n.FileName, n.CommentID, n.Snippet, boolToInt(n.Read), n.CreatedAt,
	)
	return err
}

func (s *SQLiteStore) ListForAccount(account string) ([]*models.Notification, error) {
	rows, err := s.db.Query(
		`SELECT id, account, kind, actor, file_id, file_name, comment_id, snippet, read, created_at
		 FROM notifications WHERE account = ? ORDER BY created_at DESC LIMIT 200`, account)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*models.Notification
	for rows.Next() {
		var n models.Notification
		var kind string
		var read int
		if err := rows.Scan(&n.ID, &n.Account, &kind, &n.Actor, &n.FileID, &n.FileName, &n.CommentID, &n.Snippet, &read, &n.CreatedAt); err != nil {
			return nil, err
		}
		n.Kind = models.NotificationKind(kind)
		n.Read = read != 0
		out = append(out, &n)
	}
	return out, rows.Err()
}

func (s *SQLiteStore) MarkRead(account, id string) (bool, error) {
	res, err := s.db.Exec(`UPDATE notifications SET read = 1 WHERE id = ? AND account = ?`, id, account)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

func (s *SQLiteStore) MarkAllRead(account string) error {
	_, err := s.db.Exec(`UPDATE notifications SET read = 1 WHERE account = ? AND read = 0`, account)
	return err
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// ---------------------------------------------------------------------------
// NullStore — in-memory backend for tests / degraded mode
// ---------------------------------------------------------------------------

type NullStore struct {
	mu   sync.RWMutex
	rows map[string]*models.Notification
}

func NewNullStore() *NullStore {
	return &NullStore{rows: make(map[string]*models.Notification)}
}

func (n *NullStore) Create(x *models.Notification) error {
	if x.Account == "" {
		return fmt.Errorf("notify: empty recipient account")
	}
	if x.ID == "" {
		x.ID = uuid.New().String()
	}
	if x.CreatedAt.IsZero() {
		x.CreatedAt = time.Now().UTC()
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	cp := *x
	n.rows[x.ID] = &cp
	return nil
}

func (n *NullStore) ListForAccount(account string) ([]*models.Notification, error) {
	n.mu.RLock()
	defer n.mu.RUnlock()
	var out []*models.Notification
	for _, r := range n.rows {
		if r.Account == account {
			cp := *r
			out = append(out, &cp)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out, nil
}

func (n *NullStore) MarkRead(account, id string) (bool, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	r, ok := n.rows[id]
	if !ok || r.Account != account {
		return false, nil
	}
	r.Read = true
	return true, nil
}

func (n *NullStore) MarkAllRead(account string) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	for _, r := range n.rows {
		if r.Account == account {
			r.Read = true
		}
	}
	return nil
}

func (n *NullStore) Close() error { return nil }
