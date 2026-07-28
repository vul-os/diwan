package storage

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"sync"
	"time"

	"diwan/backend/models"
	"diwan/backend/signing"
)

// Share links are persisted as sharelinks/<sha256(token)>.json — keyed by the
// HASH of the token, never the token itself, so the anonymous view route keeps
// its O(1) lookup (hash the presented token, open that file) while the store on
// disk holds no working capability. This is the same discipline backend/invites
// applies to registration tokens; share links used to be the odd one out,
// writing the live token as both the filename and a `token` field.
//
// The file id lives inside the record; ListShareLinks scans and filters by file
// id.
//
// The bcrypt password hash MUST be persisted on disk (it is the whole gate), but
// models.ShareLink marks PasswordHash json:"-" so it is never leaked to HTTP
// clients. We therefore serialize through an internal persistedShareLink type
// that DOES include the hash — the "-" tag only governs the API projection, not
// the store's on-disk format. That type deliberately has NO token field: there
// is nothing to write there any more.

type persistedShareLink struct {
	ID     string `json:"id"`
	FileID string `json:"file_id"`
	// TokenHash duplicates the filename. It is written so a record is
	// self-describing when read in isolation (a support dump, a backup diff),
	// and so the legacy migration below has an unambiguous marker of a record
	// that has already been converted.
	TokenHash    string     `json:"token_hash"`
	CreatedBy    string     `json:"created_by"`
	PasswordHash string     `json:"password_hash"`
	ExpiresAt    *time.Time `json:"expires_at,omitempty"`
	Revoked      bool       `json:"revoked"`
	CreatedAt    time.Time  `json:"created_at"`

	// Token is the pre-hash on-disk field, retained ONLY so migrateShareLinks
	// can read a legacy record and derive its hash. Nothing writes it: the
	// field is `omitempty` and toPersisted never sets it, so a re-serialized
	// record drops it permanently.
	Token string `json:"token,omitempty"`
}

func toPersisted(l *models.ShareLink) persistedShareLink {
	return persistedShareLink{
		ID: l.ID, FileID: l.FileID, TokenHash: l.TokenHash, CreatedBy: l.CreatedBy,
		PasswordHash: l.PasswordHash, ExpiresAt: l.ExpiresAt, Revoked: l.Revoked,
		CreatedAt: l.CreatedAt,
	}
}

func (p persistedShareLink) toModel() *models.ShareLink {
	return &models.ShareLink{
		ID: p.ID, FileID: p.FileID, TokenHash: p.TokenHash, CreatedBy: p.CreatedBy,
		PasswordHash: p.PasswordHash, HasPassword: p.PasswordHash != "",
		ExpiresAt: p.ExpiresAt, Revoked: p.Revoked, CreatedAt: p.CreatedAt,
		// Token is deliberately left empty: the store does not know it.
	}
}

func (s *LocalStorage) shareLinksDir() string {
	return filepath.Join(s.dataDir, "sharelinks")
}

// shareLinkPathByHash builds the record path for an already-hashed token.
func (s *LocalStorage) shareLinkPathByHash(hash string) (string, error) {
	if !validID(hash) {
		return "", errInvalidID
	}
	return filepath.Join(s.shareLinksDir(), hash+".json"), nil
}

func (s *LocalStorage) CreateShareLink(l *models.ShareLink) error {
	if l.Token == "" {
		return fmt.Errorf("share link: no token to hash")
	}
	// Derive the hash HERE rather than trusting the caller to have done it, so
	// no future call site can persist a link whose lookup key is its plaintext.
	l.TokenHash = signing.HashShareLinkToken(l.Token)
	path, err := s.shareLinkPathByHash(l.TokenHash)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(s.shareLinksDir(), 0755); err != nil {
		return fmt.Errorf("create sharelinks dir: %w", err)
	}
	data, err := json.MarshalIndent(toPersisted(l), "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0600)
}

// GetShareLinkByToken takes the RAW token as presented on the view route and
// resolves it by hash. The returned model's Token is empty — the store has no
// way to produce it, which is the point.
func (s *LocalStorage) GetShareLinkByToken(token string) (*models.ShareLink, error) {
	if err := s.migrateShareLinks(); err != nil {
		return nil, err
	}
	return s.getShareLinkByHash(signing.HashShareLinkToken(token))
}

func (s *LocalStorage) getShareLinkByHash(hash string) (*models.ShareLink, error) {
	path, err := s.shareLinkPathByHash(hash)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("share link not found")
		}
		return nil, err
	}
	var p persistedShareLink
	if err := json.Unmarshal(data, &p); err != nil {
		return nil, err
	}
	return p.toModel(), nil
}

func (s *LocalStorage) ListShareLinks(fileID string) ([]*models.ShareLink, error) {
	if err := s.migrateShareLinks(); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(s.shareLinksDir())
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var links []*models.ShareLink
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		hash := entry.Name()[:len(entry.Name())-5]
		l, err := s.getShareLinkByHash(hash)
		if err != nil {
			continue
		}
		if l.FileID == fileID {
			links = append(links, l)
		}
	}
	sort.Slice(links, func(i, j int) bool {
		return links[i].CreatedAt.After(links[j].CreatedAt)
	})
	return links, nil
}

func (s *LocalStorage) RevokeShareLink(fileID, linkID string) error {
	// linkID is the record ID; scan the file's links to find its hash.
	links, err := s.ListShareLinks(fileID)
	if err != nil {
		return err
	}
	for _, l := range links {
		if l.ID == linkID {
			l.Revoked = true
			path, perr := s.shareLinkPathByHash(l.TokenHash)
			if perr != nil {
				return perr
			}
			data, merr := json.MarshalIndent(toPersisted(l), "", "  ")
			if merr != nil {
				return merr
			}
			return os.WriteFile(path, data, 0600)
		}
	}
	return fmt.Errorf("share link not found")
}

// ─── Legacy migration: plaintext-token records → hash-keyed records ──────────

// hexHashPattern matches a converted record's filename. A legacy filename is a
// raw token: 32 bytes base64url-encoded without padding, i.e. 43 characters
// drawn from [A-Za-z0-9_-], which can never be 64 lowercase hex characters. The
// two forms are therefore distinguishable with no ambiguity and no flag file.
var hexHashPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// shareLinkMigration remembers which data dirs have already been converted, so
// the scan runs once rather than on every anonymous view-route lookup. It is
// keyed by data dir (not a plain bool) because tests build several stores in
// one process, each over its own t.TempDir().
var shareLinkMigration struct {
	sync.Mutex
	done map[string]bool
}

// migrateShareLinks rewrites any pre-hash record — sharelinks/<rawtoken>.json,
// carrying a `token` field — as sharelinks/<sha256(rawtoken)>.json with no
// token field, then removes the original.
//
// EXISTING LINKS KEEP WORKING. The URL a user already holds contains the raw
// token; the view route hashes it and finds the converted record. What the
// change does break, visibly and deliberately, is the OWNER's ability to
// re-read an old link's URL out of the store: GET /api/files/:id/share-links no
// longer returns a token for any link, old or new, because no backend has one.
// The UI says so (see AccountShareModal) instead of silently rendering
// /view/undefined.
//
// The rewrite is write-new-then-delete-old, so an interrupted migration leaves
// BOTH files and the next pass is a no-op for the already-written one. It is
// never delete-first: that would strand a live link.
func (s *LocalStorage) migrateShareLinks() error {
	dir := s.shareLinksDir()

	shareLinkMigration.Lock()
	defer shareLinkMigration.Unlock()
	if shareLinkMigration.done == nil {
		shareLinkMigration.done = map[string]bool{}
	}
	if shareLinkMigration.done[dir] {
		return nil
	}

	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		shareLinkMigration.done[dir] = true
		return nil
	}
	if err != nil {
		return err
	}

	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		name := entry.Name()[:len(entry.Name())-5]
		if hexHashPattern.MatchString(name) {
			continue // already converted
		}
		legacyPath := filepath.Join(dir, entry.Name())
		data, rerr := os.ReadFile(legacyPath)
		if rerr != nil {
			return fmt.Errorf("sharelink migration: read %s: %w", entry.Name(), rerr)
		}
		var p persistedShareLink
		if uerr := json.Unmarshal(data, &p); uerr != nil {
			// Refuse to start rather than skip the record. Skipping would leave a
			// live plaintext-keyed link in place while reporting success — the
			// exact silent half-migration this rewrite exists to avoid. Name the
			// file so the operator can inspect or remove it (removing it revokes
			// that one link and nothing else).
			return fmt.Errorf("sharelink migration: %s is not a valid share-link record (%w); "+
				"inspect or delete %s and start again — deleting it revokes only that link",
				entry.Name(), uerr, legacyPath)
		}
		// Prefer the record's own token; fall back to the filename, which was
		// the token under the old scheme.
		raw := p.Token
		if raw == "" {
			raw = name
		}
		p.TokenHash = signing.HashShareLinkToken(raw)
		p.Token = ""
		newPath, perr := s.shareLinkPathByHash(p.TokenHash)
		if perr != nil {
			return fmt.Errorf("sharelink migration: %s: %w", entry.Name(), perr)
		}
		out, merr := json.MarshalIndent(p, "", "  ")
		if merr != nil {
			return merr
		}
		if werr := os.WriteFile(newPath, out, 0600); werr != nil {
			return fmt.Errorf("sharelink migration: write %s: %w", filepath.Base(newPath), werr)
		}
		if rmerr := os.Remove(legacyPath); rmerr != nil {
			return fmt.Errorf("sharelink migration: remove %s: %w", entry.Name(), rmerr)
		}
	}

	shareLinkMigration.done[dir] = true
	return nil
}
