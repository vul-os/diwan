package storage

// fileacl_postgres.go — a fileacl.Store implementation that lives in the SAME
// Postgres backend as the file store. When Postgres is the storage backend, the
// per-file ACL must travel with the files: co-locating it here (rather than in
// the separate sqlite ACL store) means ownership/shares are in the same
// database — same transactions, same replication, same backup/restore — as the
// documents they protect. The owner/share rows reference files(id) ON DELETE
// CASCADE so deleting a file atomically drops its ACL.
//
// The sqlite backend keeps using fileacl.NewSQLiteStore (the ACL DB sits beside
// the sqlite document store). The handler layer selects the right store via
// PostgresStorage.ACLStore() / the storage.ACLProvider interface.

import (
	"context"

	"diwan/backend/fileacl"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ACLProvider is implemented by storage backends that ship their own,
// co-located ACL store. SharedFileAuthz uses this so ACL ownership lives in the
// same backend as the files (transactional + replicated under Postgres).
type ACLProvider interface {
	// ACLStore returns a fileacl.Store backed by this storage backend.
	ACLStore() fileacl.Store
}

// PostgresACLStore implements fileacl.Store over the same pgxpool as the file
// store.
type PostgresACLStore struct {
	pool *pgxpool.Pool
}

var _ fileacl.Store = (*PostgresACLStore)(nil)

// ACLStore returns the co-located Postgres ACL store, lazily migrating its
// schema. PostgresStorage satisfies storage.ACLProvider.
func (s *PostgresStorage) ACLStore() fileacl.Store {
	st := &PostgresACLStore{pool: s.pool}
	st.migrate()
	return st
}

func (a *PostgresACLStore) migrate() {
	// ON DELETE CASCADE ties the ACL lifecycle to the file: ownership/shares are
	// removed in the same transaction as the file delete. The role column
	// (owner/editor/commenter/viewer) defaults to 'editor'.
	_, _ = a.pool.Exec(context.Background(), `
		CREATE TABLE IF NOT EXISTS file_acl_owners (
			file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
			owner   TEXT NOT NULL DEFAULT ''
		);
		CREATE TABLE IF NOT EXISTS file_acl_shares (
			file_id    TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
			account_id TEXT NOT NULL,
			role       TEXT NOT NULL DEFAULT 'editor',
			PRIMARY KEY (file_id, account_id)
		);
		CREATE INDEX IF NOT EXISTS idx_file_acl_owners_owner ON file_acl_owners(owner);
		CREATE INDEX IF NOT EXISTS idx_file_acl_shares_account ON file_acl_shares(account_id);
	`)
}

func (a *PostgresACLStore) SetOwner(fileID, owner string) error {
	if fileID == "" {
		return fileacl.ErrEmptyFileID
	}
	_, err := a.pool.Exec(context.Background(),
		`INSERT INTO file_acl_owners (file_id, owner) VALUES ($1, $2)
		 ON CONFLICT (file_id) DO UPDATE SET owner = EXCLUDED.owner`,
		fileID, owner)
	return err
}

func (a *PostgresACLStore) Get(fileID string) (fileacl.Record, bool, error) {
	var owner string
	err := a.pool.QueryRow(context.Background(),
		`SELECT owner FROM file_acl_owners WHERE file_id = $1`, fileID).Scan(&owner)
	if err == pgx.ErrNoRows {
		return fileacl.Record{}, false, nil
	}
	if err != nil {
		return fileacl.Record{}, false, err
	}
	collabs, err := a.listCollaborators(fileID)
	if err != nil {
		return fileacl.Record{}, false, err
	}
	return fileacl.Record{FileID: fileID, Owner: owner, Collaborators: collabs}, true, nil
}

func (a *PostgresACLStore) listCollaborators(fileID string) ([]fileacl.CollaboratorEntry, error) {
	rows, err := a.pool.Query(context.Background(),
		`SELECT account_id, role FROM file_acl_shares WHERE file_id = $1 ORDER BY account_id`, fileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []fileacl.CollaboratorEntry
	for rows.Next() {
		var id, role string
		if err := rows.Scan(&id, &role); err != nil {
			return nil, err
		}
		out = append(out, fileacl.CollaboratorEntry{AccountID: id, Role: fileacl.Role(role)})
	}
	return out, rows.Err()
}

func (a *PostgresACLStore) Share(fileID, accountID string) error {
	return a.ShareWithRole(fileID, accountID, fileacl.RoleEditor)
}

func (a *PostgresACLStore) ShareWithRole(fileID, accountID string, role fileacl.Role) error {
	if fileID == "" || accountID == "" {
		return fileacl.ErrEmptyFileID
	}
	_, err := a.pool.Exec(context.Background(),
		`INSERT INTO file_acl_shares (file_id, account_id, role) VALUES ($1, $2, $3)
		 ON CONFLICT (file_id, account_id) DO UPDATE SET role = EXCLUDED.role`,
		fileID, accountID, string(role))
	return err
}

func (a *PostgresACLStore) Unshare(fileID, accountID string) error {
	_, err := a.pool.Exec(context.Background(),
		`DELETE FROM file_acl_shares WHERE file_id = $1 AND account_id = $2`,
		fileID, accountID)
	return err
}

func (a *PostgresACLStore) Delete(fileID string) error {
	// Explicit delete (the ON DELETE CASCADE also handles the file-delete path).
	ctx := context.Background()
	if _, err := a.pool.Exec(ctx, `DELETE FROM file_acl_shares WHERE file_id = $1`, fileID); err != nil {
		return err
	}
	_, err := a.pool.Exec(ctx, `DELETE FROM file_acl_owners WHERE file_id = $1`, fileID)
	return err
}

func (a *PostgresACLStore) CanAccess(fileID, accountID string) (bool, bool, error) {
	rec, ok, err := a.Get(fileID)
	if err != nil {
		return false, false, err
	}
	if !ok {
		// Unowned/legacy file → fail-safe allow (matches sqlite store contract).
		return true, false, nil
	}
	if rec.Owner == accountID {
		return true, true, nil
	}
	for _, c := range rec.Collaborators {
		if c.AccountID == accountID {
			return true, true, nil
		}
	}
	return false, true, nil
}

func (a *PostgresACLStore) GetRole(fileID, accountID string) (fileacl.Role, bool, error) {
	rec, ok, err := a.Get(fileID)
	if err != nil {
		return fileacl.RoleNone, false, err
	}
	if !ok {
		return fileacl.RoleNone, false, nil
	}
	if rec.Owner == accountID {
		return fileacl.RoleOwner, true, nil
	}
	for _, c := range rec.Collaborators {
		if c.AccountID == accountID {
			return c.Role, true, nil
		}
	}
	return fileacl.RoleNone, false, nil
}

func (a *PostgresACLStore) AccessibleFileIDs(accountID string) (map[string]bool, error) {
	ctx := context.Background()
	out := make(map[string]bool)
	owned, err := a.pool.Query(ctx, `SELECT file_id FROM file_acl_owners WHERE owner = $1`, accountID)
	if err != nil {
		return nil, err
	}
	for owned.Next() {
		var id string
		if err := owned.Scan(&id); err != nil {
			owned.Close()
			return nil, err
		}
		out[id] = true
	}
	owned.Close()

	shared, err := a.pool.Query(ctx, `SELECT file_id FROM file_acl_shares WHERE account_id = $1`, accountID)
	if err != nil {
		return nil, err
	}
	defer shared.Close()
	for shared.Next() {
		var id string
		if err := shared.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, shared.Err()
}

// Close is a no-op: the pgxpool is owned by PostgresStorage.
func (a *PostgresACLStore) Close() error { return nil }
