package storage

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sort"
	"sync"
	"time"

	"diwan/backend/config"
	"diwan/backend/models"
	"diwan/backend/signing"

	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresStorage struct {
	pool *pgxpool.Pool
	// shareLinkHashOnce guards the one-time backfill of plaintext share-link
	// tokens into their hashes (see migrateShareLinkHashes).
	shareLinkHashOnce sync.Once
}

// NewPostgresStorage opens a pgxpool connection to Postgres, ensures the
// "office" schema exists, pins every connection's search_path to "office"
// (so all CREATE TABLE / SELECT statements operate in that schema without
// explicit qualification), and runs the idempotent startup migration.
//
// Connection source priority:
//  1. cfg.Storage.Postgres.DSN — full postgres://… URL (set by the
//     DATABASE_URL / VULOS_DATABASE_URL env-override path in storage.New).
//  2. Structured fields Host/Port/User/Password/Database/SSLMode from
//     config.yaml — used when there is no URL env var.
func NewPostgresStorage(cfg *config.Config) (*PostgresStorage, error) {
	pg := cfg.Storage.Postgres

	// Build the raw DSN: URL wins over structured fields.
	rawDSN := pg.DSN
	if rawDSN == "" {
		rawDSN = fmt.Sprintf(
			"host=%s port=%d user=%s password=%s dbname=%s sslmode=%s",
			pg.Host, pg.Port, pg.User, pg.Password, pg.Database, pg.SSLMode,
		)
	}

	poolCfg, err := pgxpool.ParseConfig(rawDSN)
	if err != nil {
		return nil, fmt.Errorf("parse postgres config: %w", err)
	}
	// Pin every connection's search_path to the "office" schema so all table
	// references are schema-qualified transparently. This lets the "office"
	// product share a single Neon database with other products (each uses its
	// own schema: "mail", "talk", "office", etc.) without table-name clashes.
	poolCfg.ConnConfig.RuntimeParams["search_path"] = "office"

	pool, err := pgxpool.NewWithConfig(context.Background(), poolCfg)
	if err != nil {
		return nil, fmt.Errorf("connect to postgres: %w", err)
	}

	s := &PostgresStorage{pool: pool}
	if err := s.migrate(); err != nil {
		pool.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	// Convert any pre-fix share-link row holding a PLAINTEXT token at boot, so a
	// deployment stops storing live capabilities the moment it starts this
	// binary — not the first time somebody happens to open a share link. The
	// read paths call it too (it is a sync.Once), which is what makes the tests
	// that build a store directly still cover it.
	s.migrateShareLinkHashes()
	return s, nil
}

// Pool exposes the underlying pgx pool so sibling subsystems that share the
// office schema (e.g. the CRDT update log) can reuse the same connection pool —
// its search_path is already pinned to "office". The core storage contract is
// unchanged; this is an escape hatch used only by the composition root (main.go).
func (s *PostgresStorage) Pool() *pgxpool.Pool { return s.pool }

func (s *PostgresStorage) migrate() error {
	ctx := context.Background()
	// CREATE SCHEMA must run with an unqualified connection (no search_path
	// restriction) — it is a database-level statement. The pool's search_path
	// is already set to "office" via RuntimeParams, so Postgres will resolve
	// table names inside this connection to the office schema once it exists.
	// Using CREATE SCHEMA IF NOT EXISTS is idempotent and safe to call on
	// every startup.
	if _, err := s.pool.Exec(ctx, `CREATE SCHEMA IF NOT EXISTS office`); err != nil {
		return fmt.Errorf("create schema office: %w", err)
	}
	_, err := s.pool.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS files (
			id          TEXT PRIMARY KEY,
			name        TEXT NOT NULL,
			type        TEXT NOT NULL,
			content     JSONB,
			rev         BIGINT NOT NULL DEFAULT 1,
			parent_id   TEXT NOT NULL DEFAULT '',
			starred     BOOLEAN NOT NULL DEFAULT FALSE,
			trashed     BOOLEAN NOT NULL DEFAULT FALSE,
			trashed_at  TIMESTAMPTZ,
			created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
		);
		CREATE TABLE IF NOT EXISTS folders (
			id          TEXT PRIMARY KEY,
			name        TEXT NOT NULL,
			parent_id   TEXT NOT NULL DEFAULT '',
			starred     BOOLEAN NOT NULL DEFAULT FALSE,
			trashed     BOOLEAN NOT NULL DEFAULT FALSE,
			trashed_at  TIMESTAMPTZ,
			created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
		);
		CREATE TABLE IF NOT EXISTS file_versions (
			id          TEXT NOT NULL,
			file_id     TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
			name        TEXT NOT NULL,
			content     JSONB,
			author      TEXT NOT NULL DEFAULT '',
			label       TEXT NOT NULL DEFAULT '',
			created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			PRIMARY KEY (file_id, id)
		);
		CREATE INDEX IF NOT EXISTS file_versions_file_id_created ON file_versions (file_id, created_at DESC);
		CREATE TABLE IF NOT EXISTS share_links (
			id            TEXT NOT NULL,
			file_id       TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
			-- Holds the hex SHA-256 of the share-link token, never the token.
			-- The name predates the fix and is kept because renaming it would
			-- be an ALTER against already-deployed databases for no functional
			-- gain; migrateShareLinkHashes backfills existing rows.
			token         TEXT PRIMARY KEY,
			created_by    TEXT NOT NULL DEFAULT '',
			password_hash TEXT NOT NULL DEFAULT '',
			expires_at    TIMESTAMPTZ,
			revoked       BOOLEAN NOT NULL DEFAULT FALSE,
			created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
		);
		CREATE INDEX IF NOT EXISTS share_links_file ON share_links (file_id);
	`)
	return err
}

// migrateSigningSchema creates signing tables on first use (lazy/idempotent).
func (s *PostgresStorage) migrateSigningSchema() {
	_, _ = s.pool.Exec(context.Background(), `
		CREATE TABLE IF NOT EXISTS envelopes (
			id            TEXT PRIMARY KEY,
			data          JSONB NOT NULL,
			created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
		);
		CREATE TABLE IF NOT EXISTS audit_log (
			id            TEXT PRIMARY KEY,
			envelope_id   TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
			data          JSONB NOT NULL,
			created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
		);
		CREATE INDEX IF NOT EXISTS audit_log_envelope ON audit_log (envelope_id, created_at ASC);
		CREATE TABLE IF NOT EXISTS signer_tokens (
			token         TEXT PRIMARY KEY,
			envelope_id   TEXT NOT NULL,
			signer_id     TEXT NOT NULL,
			created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
		);
	`)
}

// ============================================================
// File CRUD
// ============================================================

func (s *PostgresStorage) ListFiles() ([]*models.File, error) {
	rows, err := s.pool.Query(context.Background(),
		`SELECT id, name, type, content, rev, parent_id, starred, trashed, trashed_at, created_at, updated_at FROM files ORDER BY updated_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var files []*models.File
	for rows.Next() {
		var f models.File
		var contentJSON []byte
		if err := rows.Scan(&f.ID, &f.Name, &f.Type, &contentJSON, &f.Rev, &f.ParentID, &f.Starred, &f.Trashed, &f.TrashedAt, &f.CreatedAt, &f.UpdatedAt); err != nil {
			return nil, err
		}
		if contentJSON != nil {
			if err := json.Unmarshal(contentJSON, &f.Content); err != nil {
				return nil, err
			}
		}
		files = append(files, &f)
	}
	return files, rows.Err()
}

func (s *PostgresStorage) GetFile(id string) (*models.File, error) {
	var f models.File
	var contentJSON []byte
	err := s.pool.QueryRow(context.Background(),
		`SELECT id, name, type, content, rev, parent_id, starred, trashed, trashed_at, created_at, updated_at FROM files WHERE id=$1`, id,
	).Scan(&f.ID, &f.Name, &f.Type, &contentJSON, &f.Rev, &f.ParentID, &f.Starred, &f.Trashed, &f.TrashedAt, &f.CreatedAt, &f.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("file not found")
	}
	if contentJSON != nil {
		if err := json.Unmarshal(contentJSON, &f.Content); err != nil {
			return nil, err
		}
	}
	return &f, nil
}

func (s *PostgresStorage) CreateFile(f *models.File) error {
	contentJSON, err := json.Marshal(f.Content)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(context.Background(),
		`INSERT INTO files (id, name, type, content, rev, parent_id) VALUES ($1, $2, $3, $4, 1, $5)`,
		f.ID, f.Name, f.Type, contentJSON, f.ParentID,
	)
	if err == nil {
		f.Rev = 1
	}
	return err
}

// UpdateFile snapshots current content as a version before overwriting (OFFICE-08),
// then commits with a rev compare-and-swap for optimistic concurrency (P2).
func (s *PostgresStorage) UpdateFile(f *models.File) error {
	existing, err := s.GetFile(f.ID)
	if err != nil {
		return err
	}
	// P2 optimistic concurrency: a caller-supplied rev (>0) must match the stored
	// rev or the write is stale → ErrRevConflict (→ 409). The UPDATE below is
	// ALSO guarded on rev so the check-and-swap is atomic even under a race (two
	// PUTs that both read the same rev: exactly one UPDATE matches, the other
	// affects 0 rows and is reported as a conflict). rev 0 = unconditional write.
	if f.Rev > 0 && f.Rev != existing.Rev {
		return ErrRevConflict
	}
	snap := &models.FileVersion{
		ID:        fmt.Sprintf("%d", existing.UpdatedAt.UnixNano()),
		FileID:    existing.ID,
		Name:      existing.Name,
		Author:    f.EditorID, // who made the edit that superseded this snapshot
		Content:   existing.Content,
		CreatedAt: existing.UpdatedAt,
	}
	_ = s.CreateVersion(snap)
	_ = s.PruneVersions(existing.ID, DefaultVersionCap)

	contentJSON, err := json.Marshal(f.Content)
	if err != nil {
		return err
	}
	// Guard the UPDATE on the rev we validated so a concurrent committer that
	// slipped in between GetFile and here loses the race (0 rows → conflict).
	newRev := existing.Rev + 1
	cmd, err := s.pool.Exec(context.Background(),
		`UPDATE files SET name=$2, content=$3, rev=$4, updated_at=NOW() WHERE id=$1 AND rev=$5`,
		f.ID, f.Name, contentJSON, newRev, existing.Rev,
	)
	if err != nil {
		return err
	}
	if cmd.RowsAffected() == 0 {
		// Either the row vanished or its rev advanced under us. Distinguish so the
		// caller gets a precise 404 vs 409.
		if _, gerr := s.GetFile(f.ID); gerr != nil {
			return fmt.Errorf("file not found")
		}
		return ErrRevConflict
	}
	f.Rev = newRev
	return nil
}

func (s *PostgresStorage) DeleteFile(id string) error {
	cmd, err := s.pool.Exec(context.Background(), `DELETE FROM files WHERE id=$1`, id)
	if err != nil {
		return err
	}
	if cmd.RowsAffected() == 0 {
		return fmt.Errorf("file not found")
	}
	return nil
}

// UpdateFileMeta persists only the organization metadata (folder/star/trash),
// leaving content + rev untouched (no version snapshot).
func (s *PostgresStorage) UpdateFileMeta(id, parentID string, starred, trashed bool, trashedAt *time.Time) error {
	cmd, err := s.pool.Exec(context.Background(),
		`UPDATE files SET parent_id=$2, starred=$3, trashed=$4, trashed_at=$5, updated_at=NOW() WHERE id=$1`,
		id, parentID, starred, trashed, trashedAt,
	)
	if err != nil {
		return err
	}
	if cmd.RowsAffected() == 0 {
		return fmt.Errorf("file not found")
	}
	return nil
}

// ============================================================
// Folders (parity: file organization)
// ============================================================

func (s *PostgresStorage) ListFolders() ([]*models.Folder, error) {
	rows, err := s.pool.Query(context.Background(),
		`SELECT id, name, parent_id, starred, trashed, trashed_at, created_at, updated_at FROM folders ORDER BY name ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var folders []*models.Folder
	for rows.Next() {
		var f models.Folder
		if err := rows.Scan(&f.ID, &f.Name, &f.ParentID, &f.Starred, &f.Trashed, &f.TrashedAt, &f.CreatedAt, &f.UpdatedAt); err != nil {
			return nil, err
		}
		folders = append(folders, &f)
	}
	return folders, rows.Err()
}

func (s *PostgresStorage) GetFolder(id string) (*models.Folder, error) {
	var f models.Folder
	err := s.pool.QueryRow(context.Background(),
		`SELECT id, name, parent_id, starred, trashed, trashed_at, created_at, updated_at FROM folders WHERE id=$1`, id,
	).Scan(&f.ID, &f.Name, &f.ParentID, &f.Starred, &f.Trashed, &f.TrashedAt, &f.CreatedAt, &f.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("folder not found")
	}
	return &f, nil
}

func (s *PostgresStorage) CreateFolder(f *models.Folder) error {
	_, err := s.pool.Exec(context.Background(),
		`INSERT INTO folders (id, name, parent_id, starred, trashed, trashed_at) VALUES ($1,$2,$3,$4,$5,$6)`,
		f.ID, f.Name, f.ParentID, f.Starred, f.Trashed, f.TrashedAt,
	)
	return err
}

func (s *PostgresStorage) UpdateFolder(f *models.Folder) error {
	cmd, err := s.pool.Exec(context.Background(),
		`UPDATE folders SET name=$2, parent_id=$3, starred=$4, trashed=$5, trashed_at=$6, updated_at=NOW() WHERE id=$1`,
		f.ID, f.Name, f.ParentID, f.Starred, f.Trashed, f.TrashedAt,
	)
	if err != nil {
		return err
	}
	if cmd.RowsAffected() == 0 {
		return fmt.Errorf("folder not found")
	}
	return nil
}

func (s *PostgresStorage) DeleteFolder(id string) error {
	cmd, err := s.pool.Exec(context.Background(), `DELETE FROM folders WHERE id=$1`, id)
	if err != nil {
		return err
	}
	if cmd.RowsAffected() == 0 {
		return fmt.Errorf("folder not found")
	}
	return nil
}

// ============================================================
// Version history (OFFICE-08)
// ============================================================

func (s *PostgresStorage) CreateVersion(v *models.FileVersion) error {
	data, err := json.Marshal(v.Content)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(context.Background(),
		`INSERT INTO file_versions (id, file_id, name, author, content, created_at) VALUES ($1,$2,$3,$4,$5,$6)
		 ON CONFLICT (file_id, id) DO NOTHING`,
		v.ID, v.FileID, v.Name, v.Author, data, v.CreatedAt,
	)
	return err
}

func (s *PostgresStorage) ListVersions(fileID string) ([]*models.FileVersion, error) {
	rows, err := s.pool.Query(context.Background(),
		`SELECT id, file_id, name, author, label, content, created_at FROM file_versions
		 WHERE file_id=$1 ORDER BY created_at DESC`, fileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var versions []*models.FileVersion
	for rows.Next() {
		var v models.FileVersion
		var contentJSON []byte
		if err := rows.Scan(&v.ID, &v.FileID, &v.Name, &v.Author, &v.Label, &contentJSON, &v.CreatedAt); err != nil {
			return nil, err
		}
		if contentJSON != nil {
			_ = json.Unmarshal(contentJSON, &v.Content)
		}
		versions = append(versions, &v)
	}
	return versions, rows.Err()
}

func (s *PostgresStorage) GetVersion(fileID, versionID string) (*models.FileVersion, error) {
	var v models.FileVersion
	var contentJSON []byte
	err := s.pool.QueryRow(context.Background(),
		`SELECT id, file_id, name, author, label, content, created_at FROM file_versions WHERE file_id=$1 AND id=$2`,
		fileID, versionID,
	).Scan(&v.ID, &v.FileID, &v.Name, &v.Author, &v.Label, &contentJSON, &v.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("version not found")
	}
	if contentJSON != nil {
		_ = json.Unmarshal(contentJSON, &v.Content)
	}
	return &v, nil
}

func (s *PostgresStorage) PruneVersions(fileID string, cap int) error {
	_, err := s.pool.Exec(context.Background(), `
		DELETE FROM file_versions WHERE (file_id, id) IN (
			SELECT file_id, id FROM file_versions
			WHERE file_id=$1
			ORDER BY created_at DESC
			OFFSET $2
		)`, fileID, cap)
	return err
}

// LabelVersion updates the label column on an existing version (OFFICE-28).
// The label column is part of the file_versions schema created in migrate().
func (s *PostgresStorage) LabelVersion(fileID, versionID, label string) error {
	cmd, err := s.pool.Exec(context.Background(),
		`UPDATE file_versions SET label=$3 WHERE file_id=$1 AND id=$2`,
		fileID, versionID, label)
	if err != nil {
		return err
	}
	if cmd.RowsAffected() == 0 {
		return fmt.Errorf("version not found")
	}
	return nil
}

// ============================================================
// Signing — Envelope CRUD (OFFICE-40)
// ============================================================

func (s *PostgresStorage) CreateEnvelope(env *models.Envelope) error {
	s.migrateSigningSchema()
	now := time.Now()
	env.CreatedAt = now
	env.UpdatedAt = now
	data, err := json.Marshal(env)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(context.Background(),
		`INSERT INTO envelopes (id, data, created_at, updated_at) VALUES ($1,$2,$3,$4)`,
		env.ID, data, now, now,
	)
	return err
}

func (s *PostgresStorage) GetEnvelope(id string) (*models.Envelope, error) {
	s.migrateSigningSchema()
	var data []byte
	err := s.pool.QueryRow(context.Background(),
		`SELECT data FROM envelopes WHERE id=$1`, id,
	).Scan(&data)
	if err != nil {
		return nil, fmt.Errorf("envelope not found")
	}
	var env models.Envelope
	if err := json.Unmarshal(data, &env); err != nil {
		return nil, err
	}
	return &env, nil
}

func (s *PostgresStorage) ListEnvelopes() ([]*models.Envelope, error) {
	s.migrateSigningSchema()
	rows, err := s.pool.Query(context.Background(),
		`SELECT data FROM envelopes ORDER BY updated_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var envs []*models.Envelope
	for rows.Next() {
		var data []byte
		if err := rows.Scan(&data); err != nil {
			return nil, err
		}
		var env models.Envelope
		if err := json.Unmarshal(data, &env); err != nil {
			continue
		}
		envs = append(envs, &env)
	}
	return envs, rows.Err()
}

func (s *PostgresStorage) UpdateEnvelope(env *models.Envelope) error {
	env.UpdatedAt = time.Now()
	data, err := json.Marshal(env)
	if err != nil {
		return err
	}
	cmd, err := s.pool.Exec(context.Background(),
		`UPDATE envelopes SET data=$2, updated_at=$3 WHERE id=$1`,
		env.ID, data, env.UpdatedAt,
	)
	if err != nil {
		return err
	}
	if cmd.RowsAffected() == 0 {
		return fmt.Errorf("envelope not found")
	}
	return nil
}

func (s *PostgresStorage) DeleteEnvelope(id string) error {
	cmd, err := s.pool.Exec(context.Background(), `DELETE FROM envelopes WHERE id=$1`, id)
	if err != nil {
		return err
	}
	if cmd.RowsAffected() == 0 {
		return fmt.Errorf("envelope not found")
	}
	return nil
}

// ============================================================
// Signing — Signer management (OFFICE-40)
// ============================================================

func (s *PostgresStorage) UpsertSigner(sg *models.Signer) error {
	env, err := s.GetEnvelope(sg.EnvelopeID)
	if err != nil {
		return err
	}
	found := false
	for i, existing := range env.Signers {
		if existing.ID == sg.ID {
			env.Signers[i] = sg
			found = true
			break
		}
	}
	if !found {
		env.Signers = append(env.Signers, sg)
	}
	return s.UpdateEnvelope(env)
}

func (s *PostgresStorage) GetSigner(id string) (*models.Signer, error) {
	envs, err := s.ListEnvelopes()
	if err != nil {
		return nil, err
	}
	for _, env := range envs {
		for _, sg := range env.Signers {
			if sg.ID == id {
				return sg, nil
			}
		}
	}
	return nil, fmt.Errorf("signer not found")
}

func (s *PostgresStorage) ListSignersByEnvelope(envelopeID string) ([]*models.Signer, error) {
	env, err := s.GetEnvelope(envelopeID)
	if err != nil {
		return nil, err
	}
	signers := env.Signers
	sort.Slice(signers, func(i, j int) bool {
		return signers[i].Order < signers[j].Order
	})
	return signers, nil
}

// ============================================================
// Signing — Append-only audit log (OFFICE-40)
// ============================================================

func (s *PostgresStorage) AppendAuditEvent(ev *models.AuditEvent) error {
	s.migrateSigningSchema()
	data, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(context.Background(),
		`INSERT INTO audit_log (id, envelope_id, data, created_at) VALUES ($1,$2,$3,$4)`,
		ev.ID, ev.EnvelopeID, data, ev.Timestamp,
	)
	return err
}

func (s *PostgresStorage) ListAuditEvents(envelopeID string) ([]*models.AuditEvent, error) {
	s.migrateSigningSchema()
	rows, err := s.pool.Query(context.Background(),
		`SELECT data FROM audit_log WHERE envelope_id=$1 ORDER BY created_at ASC`, envelopeID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var events []*models.AuditEvent
	for rows.Next() {
		var data []byte
		if err := rows.Scan(&data); err != nil {
			return nil, err
		}
		var ev models.AuditEvent
		if err := json.Unmarshal(data, &ev); err != nil {
			continue
		}
		events = append(events, &ev)
	}
	return events, rows.Err()
}

// ============================================================
// Signing — Token index (OFFICE-42)
// ============================================================

func (s *PostgresStorage) StoreSignerToken(token, envelopeID, signerID string) error {
	s.migrateSigningSchema()
	_, err := s.pool.Exec(context.Background(),
		`INSERT INTO signer_tokens (token, envelope_id, signer_id) VALUES ($1,$2,$3)
		 ON CONFLICT (token) DO NOTHING`,
		token, envelopeID, signerID,
	)
	return err
}

func (s *PostgresStorage) ResolveToken(token string) (string, string, error) {
	s.migrateSigningSchema()
	var envelopeID, signerID string
	err := s.pool.QueryRow(context.Background(),
		`SELECT envelope_id, signer_id FROM signer_tokens WHERE token=$1`, token,
	).Scan(&envelopeID, &signerID)
	if err != nil {
		return "", "", fmt.Errorf("token not found")
	}
	return envelopeID, signerID, nil
}

// ============================================================
// Sealed PDF store (OFFICE-46) — Postgres implementation
// ============================================================

func (s *PostgresStorage) migrateSealedSchema() {
	_, _ = s.pool.Exec(context.Background(), `
		CREATE TABLE IF NOT EXISTS sealed_pdfs (
			envelope_id TEXT PRIMARY KEY,
			data        BYTEA NOT NULL,
			created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
		);
	`)
}

func (s *PostgresStorage) StoreSealedPDF(envelopeID string, data []byte) error {
	s.migrateSealedSchema()
	_, err := s.pool.Exec(context.Background(),
		`INSERT INTO sealed_pdfs (envelope_id, data) VALUES ($1, $2)
		 ON CONFLICT (envelope_id) DO UPDATE SET data = EXCLUDED.data`,
		envelopeID, data,
	)
	return err
}

func (s *PostgresStorage) GetSealedPDF(envelopeID string) ([]byte, error) {
	s.migrateSealedSchema()
	var data []byte
	err := s.pool.QueryRow(context.Background(),
		`SELECT data FROM sealed_pdfs WHERE envelope_id=$1`, envelopeID,
	).Scan(&data)
	if err != nil {
		return nil, fmt.Errorf("sealed PDF not found")
	}
	return data, nil
}

// ============================================================
// Comments (OFFICE-26) — Postgres implementations
// ============================================================

func (s *PostgresStorage) migrateCommentsSchema() {
	s.pool.Exec(context.Background(), `
		CREATE TABLE IF NOT EXISTS comments (
			id TEXT PRIMARY KEY,
			file_id TEXT NOT NULL,
			anchor JSONB NOT NULL DEFAULT '{}',
			author_id TEXT NOT NULL DEFAULT '',
			body TEXT NOT NULL DEFAULT '',
			state TEXT NOT NULL DEFAULT 'open',
			seq_clock TEXT NOT NULL DEFAULT '',
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		);
		CREATE TABLE IF NOT EXISTS comment_replies (
			id TEXT PRIMARY KEY,
			comment_id TEXT NOT NULL,
			file_id TEXT NOT NULL,
			author_id TEXT NOT NULL DEFAULT '',
			body TEXT NOT NULL DEFAULT '',
			seq_clock TEXT NOT NULL DEFAULT '',
			deleted BOOLEAN NOT NULL DEFAULT FALSE,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		);
		-- Comment assignment (task assignee) is kept in a SIDE TABLE rather than a
		-- new column so the schema stays CREATE-only (additive to existing
		-- deployments — no ALTER of the comments table needed). One row per
		-- assigned comment; unassigning deletes the row.
		CREATE TABLE IF NOT EXISTS comment_assignees (
			comment_id TEXT PRIMARY KEY,
			file_id TEXT NOT NULL DEFAULT '',
			assignee TEXT NOT NULL DEFAULT '',
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		);
	`)
}

// setCommentAssignee upserts (or clears) the assignee side-row for a comment.
func (s *PostgresStorage) setCommentAssignee(c *models.Comment) {
	if c.Assignee == "" {
		_, _ = s.pool.Exec(context.Background(),
			`DELETE FROM comment_assignees WHERE comment_id=$1`, c.ID)
		return
	}
	_, _ = s.pool.Exec(context.Background(),
		`INSERT INTO comment_assignees (comment_id,file_id,assignee,updated_at)
		 VALUES ($1,$2,$3,NOW())
		 ON CONFLICT (comment_id) DO UPDATE SET assignee=$3,file_id=$2,updated_at=NOW()`,
		c.ID, c.FileID, c.Assignee)
}

// getCommentAssignee reads a comment's assignee ("" when unassigned).
func (s *PostgresStorage) getCommentAssignee(commentID string) string {
	var a string
	_ = s.pool.QueryRow(context.Background(),
		`SELECT assignee FROM comment_assignees WHERE comment_id=$1`, commentID).Scan(&a)
	return a
}

func (s *PostgresStorage) CreateComment(c *models.Comment) error {
	s.migrateCommentsSchema()
	anchor, _ := json.Marshal(c.Anchor)
	_, err := s.pool.Exec(context.Background(),
		`INSERT INTO comments (id,file_id,anchor,author_id,body,state,seq_clock,created_at,updated_at)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
		 ON CONFLICT (id) DO UPDATE SET anchor=$3,body=$5,state=$6,seq_clock=$7,updated_at=$9`,
		c.ID, c.FileID, anchor, c.AuthorID, c.Body, c.State, c.SeqClock, c.CreatedAt, c.UpdatedAt,
	)
	if err == nil {
		// Persist assignment in the side table (upsert/clear) so it survives the
		// UpdateComment→CreateComment path and reloads with the comment.
		s.setCommentAssignee(c)
	}
	return err
}

func (s *PostgresStorage) GetComment(fileID, commentID string) (*models.Comment, error) {
	s.migrateCommentsSchema()
	var c models.Comment
	var anchor []byte
	err := s.pool.QueryRow(context.Background(),
		`SELECT id,file_id,anchor,author_id,body,state,seq_clock,created_at,updated_at
		 FROM comments WHERE file_id=$1 AND id=$2`, fileID, commentID,
	).Scan(&c.ID, &c.FileID, &anchor, &c.AuthorID, &c.Body, &c.State, &c.SeqClock, &c.CreatedAt, &c.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("comment not found")
	}
	_ = json.Unmarshal(anchor, &c.Anchor)
	c.Assignee = s.getCommentAssignee(c.ID)
	return &c, nil
}

func (s *PostgresStorage) ListComments(fileID string) ([]*models.Comment, error) {
	s.migrateCommentsSchema()
	rows, err := s.pool.Query(context.Background(),
		`SELECT id,file_id,anchor,author_id,body,state,seq_clock,created_at,updated_at
		 FROM comments WHERE file_id=$1 ORDER BY created_at ASC`, fileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var comments []*models.Comment
	for rows.Next() {
		var c models.Comment
		var anchor []byte
		if err := rows.Scan(&c.ID, &c.FileID, &anchor, &c.AuthorID, &c.Body, &c.State, &c.SeqClock, &c.CreatedAt, &c.UpdatedAt); err != nil {
			continue
		}
		_ = json.Unmarshal(anchor, &c.Anchor)
		c.Assignee = s.getCommentAssignee(c.ID)
		comments = append(comments, &c)
	}
	return comments, rows.Err()
}

func (s *PostgresStorage) UpdateComment(c *models.Comment) error {
	return s.CreateComment(c)
}

func (s *PostgresStorage) DeleteComment(fileID, commentID string) error {
	s.migrateCommentsSchema()
	_, err := s.pool.Exec(context.Background(),
		`DELETE FROM comments WHERE file_id=$1 AND id=$2`, fileID, commentID)
	if err == nil {
		_, _ = s.pool.Exec(context.Background(),
			`DELETE FROM comment_assignees WHERE comment_id=$1`, commentID)
	}
	return err
}

func (s *PostgresStorage) CreateReply(r *models.CommentReply) error {
	s.migrateCommentsSchema()
	_, err := s.pool.Exec(context.Background(),
		`INSERT INTO comment_replies (id,comment_id,file_id,author_id,body,seq_clock,deleted,created_at,updated_at)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
		 ON CONFLICT (id) DO UPDATE SET body=$5,seq_clock=$6,deleted=$7,updated_at=$9`,
		r.ID, r.CommentID, r.FileID, r.AuthorID, r.Body, r.SeqClock, r.Deleted, r.CreatedAt, r.UpdatedAt,
	)
	return err
}

func (s *PostgresStorage) GetReply(commentID, replyID string) (*models.CommentReply, error) {
	s.migrateCommentsSchema()
	var r models.CommentReply
	err := s.pool.QueryRow(context.Background(),
		`SELECT id,comment_id,file_id,author_id,body,seq_clock,deleted,created_at,updated_at
		 FROM comment_replies WHERE comment_id=$1 AND id=$2`, commentID, replyID,
	).Scan(&r.ID, &r.CommentID, &r.FileID, &r.AuthorID, &r.Body, &r.SeqClock, &r.Deleted, &r.CreatedAt, &r.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("reply not found")
	}
	return &r, nil
}

func (s *PostgresStorage) ListReplies(commentID string) ([]*models.CommentReply, error) {
	s.migrateCommentsSchema()
	rows, err := s.pool.Query(context.Background(),
		`SELECT id,comment_id,file_id,author_id,body,seq_clock,deleted,created_at,updated_at
		 FROM comment_replies WHERE comment_id=$1 ORDER BY created_at ASC`, commentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var replies []*models.CommentReply
	for rows.Next() {
		var r models.CommentReply
		if err := rows.Scan(&r.ID, &r.CommentID, &r.FileID, &r.AuthorID, &r.Body, &r.SeqClock, &r.Deleted, &r.CreatedAt, &r.UpdatedAt); err != nil {
			continue
		}
		replies = append(replies, &r)
	}
	return replies, rows.Err()
}

func (s *PostgresStorage) UpdateReply(r *models.CommentReply) error {
	return s.CreateReply(r)
}

// ============================================================
// Suggestions (OFFICE-27) — Postgres implementations
// ============================================================

// migrateSuggestionsSchema creates the suggestions table when it does not exist.
// Safe to call on every startup; uses CREATE TABLE IF NOT EXISTS.
func (s *PostgresStorage) migrateSuggestionsSchema() {
	_, _ = s.pool.Exec(context.Background(), `
CREATE TABLE IF NOT EXISTS suggestions (
    id          TEXT NOT NULL,
    file_id     TEXT NOT NULL,
    kind        TEXT NOT NULL,
    state       TEXT NOT NULL DEFAULT 'pending',
    author_id   TEXT NOT NULL DEFAULT '',
    from_pos    INTEGER NOT NULL DEFAULT 0,
    to_pos      INTEGER NOT NULL DEFAULT 0,
    text        TEXT NOT NULL DEFAULT '',
    seq_clock   TEXT NOT NULL DEFAULT '',
    reviewer_id TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (file_id, id)
)`)
}

func (s *PostgresStorage) CreateSuggestion(sg *models.Suggestion) error {
	s.migrateSuggestionsSchema()
	now := time.Now().UTC()
	sg.CreatedAt = now
	sg.UpdatedAt = now
	_, err := s.pool.Exec(context.Background(), `
INSERT INTO suggestions (id, file_id, kind, state, author_id, from_pos, to_pos, text, seq_clock, reviewer_id, created_at, updated_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
		sg.ID, sg.FileID, string(sg.Kind), string(sg.State), sg.AuthorID,
		sg.From, sg.To, sg.Text, sg.SeqClock, sg.ReviewerID,
		sg.CreatedAt, sg.UpdatedAt,
	)
	return err
}

func (s *PostgresStorage) GetSuggestion(fileID, suggestionID string) (*models.Suggestion, error) {
	s.migrateSuggestionsSchema()
	row := s.pool.QueryRow(context.Background(), `
SELECT id, file_id, kind, state, author_id, from_pos, to_pos, text, seq_clock, reviewer_id, created_at, updated_at
FROM suggestions WHERE file_id=$1 AND id=$2`, fileID, suggestionID)
	var sg models.Suggestion
	var kind, state string
	err := row.Scan(&sg.ID, &sg.FileID, &kind, &state, &sg.AuthorID,
		&sg.From, &sg.To, &sg.Text, &sg.SeqClock, &sg.ReviewerID,
		&sg.CreatedAt, &sg.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("suggestion not found")
	}
	sg.Kind = models.SuggestionKind(kind)
	sg.State = models.SuggestionState(state)
	return &sg, nil
}

func (s *PostgresStorage) ListSuggestions(fileID string) ([]*models.Suggestion, error) {
	s.migrateSuggestionsSchema()
	rows, err := s.pool.Query(context.Background(), `
SELECT id, file_id, kind, state, author_id, from_pos, to_pos, text, seq_clock, reviewer_id, created_at, updated_at
FROM suggestions WHERE file_id=$1 ORDER BY created_at ASC`, fileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*models.Suggestion
	for rows.Next() {
		var sg models.Suggestion
		var kind, state string
		if err := rows.Scan(&sg.ID, &sg.FileID, &kind, &state, &sg.AuthorID,
			&sg.From, &sg.To, &sg.Text, &sg.SeqClock, &sg.ReviewerID,
			&sg.CreatedAt, &sg.UpdatedAt); err != nil {
			return nil, err
		}
		sg.Kind = models.SuggestionKind(kind)
		sg.State = models.SuggestionState(state)
		out = append(out, &sg)
	}
	if out == nil {
		out = []*models.Suggestion{}
	}
	return out, nil
}

func (s *PostgresStorage) UpdateSuggestion(sg *models.Suggestion) error {
	s.migrateSuggestionsSchema()
	sg.UpdatedAt = time.Now().UTC()
	_, err := s.pool.Exec(context.Background(), `
UPDATE suggestions SET state=$1, reviewer_id=$2, seq_clock=$3, updated_at=$4
WHERE file_id=$5 AND id=$6`,
		string(sg.State), sg.ReviewerID, sg.SeqClock, sg.UpdatedAt,
		sg.FileID, sg.ID,
	)
	return err
}

func (s *PostgresStorage) DeleteSuggestion(fileID, suggestionID string) error {
	s.migrateSuggestionsSchema()
	tag, err := s.pool.Exec(context.Background(), `
DELETE FROM suggestions WHERE file_id=$1 AND id=$2`, fileID, suggestionID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("suggestion not found")
	}
	return nil
}

// ============================================================
// Share links (anonymous, read-only, token-gated doc access)
// ============================================================

// The share_links.token column holds the hex SHA-256 of the share-link token,
// NOT the token — see signing.HashShareLinkToken and migrateShareLinkHashes.
// The column keeps its original name because renaming it would mean an ALTER on
// a schema that is already deployed; every query below aliases it to token_hash
// so the Go side never reads as though a live token were in hand.

func (s *PostgresStorage) CreateShareLink(l *models.ShareLink) error {
	if l.Token == "" {
		return fmt.Errorf("share link: no token to hash")
	}
	// Derive the hash HERE rather than trusting the caller, so no future call
	// site can persist a link whose lookup key is its plaintext.
	l.TokenHash = signing.HashShareLinkToken(l.Token)
	_, err := s.pool.Exec(context.Background(),
		`INSERT INTO share_links (id, file_id, token, created_by, password_hash, expires_at, revoked, created_at)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
		l.ID, l.FileID, l.TokenHash, l.CreatedBy, l.PasswordHash, l.ExpiresAt, l.Revoked, l.CreatedAt,
	)
	return err
}

// GetShareLinkByToken takes the RAW token as presented on the view route and
// resolves it by hash. The returned model's Token is empty — the database has
// no way to produce it, which is the point.
func (s *PostgresStorage) GetShareLinkByToken(token string) (*models.ShareLink, error) {
	s.migrateShareLinkHashes()
	var l models.ShareLink
	err := s.pool.QueryRow(context.Background(),
		`SELECT id, file_id, token AS token_hash, created_by, password_hash, expires_at, revoked, created_at
		 FROM share_links WHERE token=$1`, signing.HashShareLinkToken(token),
	).Scan(&l.ID, &l.FileID, &l.TokenHash, &l.CreatedBy, &l.PasswordHash, &l.ExpiresAt, &l.Revoked, &l.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("share link not found")
	}
	l.HasPassword = l.PasswordHash != ""
	return &l, nil
}

func (s *PostgresStorage) ListShareLinks(fileID string) ([]*models.ShareLink, error) {
	s.migrateShareLinkHashes()
	rows, err := s.pool.Query(context.Background(),
		`SELECT id, file_id, token AS token_hash, created_by, password_hash, expires_at, revoked, created_at
		 FROM share_links WHERE file_id=$1 ORDER BY created_at DESC`, fileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var links []*models.ShareLink
	for rows.Next() {
		var l models.ShareLink
		if err := rows.Scan(&l.ID, &l.FileID, &l.TokenHash, &l.CreatedBy, &l.PasswordHash, &l.ExpiresAt, &l.Revoked, &l.CreatedAt); err != nil {
			return nil, err
		}
		l.HasPassword = l.PasswordHash != ""
		links = append(links, &l)
	}
	return links, rows.Err()
}

// migrateShareLinkHashes converts any row still holding a PLAINTEXT token into
// its SHA-256 hash, once per process.
//
// This is a DATA migration, not a schema one: no column is added, renamed, or
// dropped, so a deployed database needs no coordinated schema change and an old
// binary reading the same table still finds the row it indexes on (it would
// simply fail to resolve tokens, which is the correct behaviour for a binary
// that predates the fix).
//
// EXISTING LINKS KEEP WORKING: a URL already in a user's hands carries the raw
// token, the view route hashes it, and the converted row matches. What the
// change does remove — visibly — is the owner's ability to re-read an old
// link's URL from the store, because no row holds one any more.
//
// The predicate is exact, not heuristic. A stored hash is 64 lowercase hex
// characters; a raw token is 32 bytes base64url-encoded without padding, i.e.
// 43 characters, and cannot collide with that shape. So the UPDATE is
// idempotent and re-running it can never double-hash a row.
//
// sha256() is a Postgres 11+ built-in, so this needs no extension.
func (s *PostgresStorage) migrateShareLinkHashes() {
	s.shareLinkHashOnce.Do(func() {
		tag, err := s.pool.Exec(context.Background(), `
			UPDATE share_links
			   SET token = encode(sha256(token::bytea), 'hex')
			 WHERE token !~ '^[0-9a-f]{64}$'`)
		if err != nil {
			// Do not fail the request: the rows that are already hashed still
			// resolve. But say so loudly — a silently un-migrated table means
			// old links stop resolving AND plaintext tokens stay on disk.
			log.Printf("[storage] share-link token hash backfill FAILED (old links will not resolve and plaintext tokens remain in share_links.token): %v", err)
			return
		}
		if n := tag.RowsAffected(); n > 0 {
			log.Printf("[storage] share-link token hash backfill: converted %d plaintext token(s) to SHA-256; those links keep working, but their URLs can no longer be re-read from the store", n)
		}
	})
}

func (s *PostgresStorage) RevokeShareLink(fileID, linkID string) error {
	cmd, err := s.pool.Exec(context.Background(),
		`UPDATE share_links SET revoked=TRUE WHERE file_id=$1 AND id=$2`, fileID, linkID)
	if err != nil {
		return err
	}
	if cmd.RowsAffected() == 0 {
		return fmt.Errorf("share link not found")
	}
	return nil
}
