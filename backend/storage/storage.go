package storage

import (
	"errors"
	"log"
	"os"
	"strings"
	"time"

	"diwan/backend/config"
	"diwan/backend/models"
)

// ErrRevConflict is returned by UpdateFile when the caller supplied a stale rev
// (optimistic-concurrency compare-and-swap failed). Handlers map it to 409
// Conflict so the client can reload the latest and reconcile (P2). Compare with
// errors.Is(err, ErrRevConflict).
var ErrRevConflict = errors.New("revision conflict")

// databaseURL returns the first non-empty value of DATABASE_URL or
// VULOS_DATABASE_URL (in that order), or "" if neither is set.
// Either variable selects the Postgres backend and sets the schema to "office"
// so all products can share a single Neon / Postgres instance.
func databaseURL() string {
	if v := strings.TrimSpace(os.Getenv("DATABASE_URL")); v != "" {
		return v
	}
	return strings.TrimSpace(os.Getenv("VULOS_DATABASE_URL"))
}

// DefaultVersionCap is the maximum number of versions retained per file.
const DefaultVersionCap = 50

type Storage interface {
	// --- File CRUD ---
	ListFiles() ([]*models.File, error)
	GetFile(id string) (*models.File, error)
	CreateFile(file *models.File) error
	UpdateFile(file *models.File) error
	DeleteFile(id string) error
	// UpdateFileMeta persists ONLY the organization metadata (parent folder,
	// star, trash) of a file. Unlike UpdateFile it does NOT snapshot a version,
	// touch content, or advance the optimistic-concurrency rev — a move/star/
	// trash is metadata, not a content edit. The file must already exist.
	UpdateFileMeta(id, parentID string, starred, trashed bool, trashedAt *time.Time) error

	// --- Folders (parity: file organization) ---
	// Folders form a per-account tree; ACL ownership is recorded separately by
	// the handler (fileacl), exactly like files. The store is ACL-agnostic.
	ListFolders() ([]*models.Folder, error)
	GetFolder(id string) (*models.Folder, error)
	CreateFolder(f *models.Folder) error
	UpdateFolder(f *models.Folder) error
	DeleteFolder(id string) error

	// --- Version history (OFFICE-08 / OFFICE-28) ---
	// Snapshots created before each UpdateFile.
	ListVersions(fileID string) ([]*models.FileVersion, error)
	GetVersion(fileID, versionID string) (*models.FileVersion, error)
	CreateVersion(v *models.FileVersion) error
	// PruneVersions removes oldest versions so at most cap remain.
	PruneVersions(fileID string, cap int) error
	// LabelVersion sets a human-readable label on an existing version (OFFICE-28).
	LabelVersion(fileID, versionID, label string) error

	// --- Share links (anonymous, read-only, token-gated doc access) ---
	// A share link is independent of the ACL roster: it grants read-only access
	// to a single file to anyone holding its signed token, optionally until an
	// expiry and/or behind a password. The store is credential-agnostic (it does
	// not verify tokens/passwords — the handler does); it only persists records.
	CreateShareLink(l *models.ShareLink) error
	// GetShareLinkByToken resolves a link by its opaque token. Returns an error if
	// no such link exists. Callers MUST still check Revoked/ExpiresAt.
	GetShareLinkByToken(token string) (*models.ShareLink, error)
	// ListShareLinks returns all links for a file (owner management view).
	ListShareLinks(fileID string) ([]*models.ShareLink, error)
	// RevokeShareLink marks a link revoked (dead permanently). Idempotent.
	RevokeShareLink(fileID, linkID string) error

	// --- Signing envelope CRUD (OFFICE-40) ---
	CreateEnvelope(env *models.Envelope) error
	GetEnvelope(id string) (*models.Envelope, error)
	ListEnvelopes() ([]*models.Envelope, error)
	UpdateEnvelope(env *models.Envelope) error
	DeleteEnvelope(id string) error

	// --- Signer management (OFFICE-40) ---
	UpsertSigner(s *models.Signer) error
	GetSigner(id string) (*models.Signer, error)
	ListSignersByEnvelope(envelopeID string) ([]*models.Signer, error)

	// --- Append-only audit log (OFFICE-40) ---
	// AppendAuditEvent inserts a new event; implementations MUST NOT
	// expose any update or delete path for audit records.
	AppendAuditEvent(ev *models.AuditEvent) error
	ListAuditEvents(envelopeID string) ([]*models.AuditEvent, error)

	// --- Signer token index (OFFICE-42) ---
	// StoreSignerToken persists a token → {envelopeID, signerID} mapping.
	StoreSignerToken(token, envelopeID, signerID string) error
	// ResolveToken looks up a token and returns the envelope + signer it scopes.
	ResolveToken(token string) (envelopeID, signerID string, err error)

	// --- Sealed PDF store (OFFICE-46) ---
	// StoreSealedPDF persists the final sealed PDF bytes for an envelope.
	StoreSealedPDF(envelopeID string, data []byte) error
	// GetSealedPDF retrieves previously stored sealed PDF bytes.
	// Returns an error if not yet generated.
	GetSealedPDF(envelopeID string) ([]byte, error)

	// --- Comments (OFFICE-26) ---
	CreateComment(c *models.Comment) error
	GetComment(fileID, commentID string) (*models.Comment, error)
	ListComments(fileID string) ([]*models.Comment, error)
	UpdateComment(c *models.Comment) error
	DeleteComment(fileID, commentID string) error

	CreateReply(r *models.CommentReply) error
	GetReply(commentID, replyID string) (*models.CommentReply, error)
	ListReplies(commentID string) ([]*models.CommentReply, error)
	UpdateReply(r *models.CommentReply) error

	// --- Suggestions / track-changes (OFFICE-27) ---
	CreateSuggestion(s *models.Suggestion) error
	GetSuggestion(fileID, suggestionID string) (*models.Suggestion, error)
	ListSuggestions(fileID string) ([]*models.Suggestion, error)
	UpdateSuggestion(s *models.Suggestion) error
	DeleteSuggestion(fileID, suggestionID string) error
}

func New(cfg *config.Config) (Storage, error) {
	// DATABASE_URL / VULOS_DATABASE_URL take precedence over config.yaml
	// storage.type so that the cloud hosting environment can inject a single
	// shared Neon URL without changing the checked-in config file.
	if dsn := databaseURL(); dsn != "" {
		log.Printf("[storage] DATABASE_URL set — selecting postgres backend (schema: office)")
		cfg.Storage.Type = "postgres"
		cfg.Storage.Postgres.DSN = dsn
	}
	switch cfg.Storage.Type {
	case "postgres":
		return NewPostgresStorage(cfg)
	default:
		return NewLocalStorage(cfg)
	}
}
