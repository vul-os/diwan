package storage

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"diwan/backend/config"
	"diwan/backend/models"
)

type LocalStorage struct {
	dataDir        string
	versionsDir    string
	envelopesDir   string
	signersDir     string
	auditDir       string
	commentsDir    string
	repliesDir     string
	sealedDir      string // OFFICE-46: sealed PDF store
	suggestionsDir string // OFFICE-27: track-changes sidecar
	foldersDir     string // parity: folder tree
}

func NewLocalStorage(cfg *config.Config) (*LocalStorage, error) {
	dir := cfg.Server.DataDir
	for _, sub := range []string{"", "versions", "envelopes", "signers", "audit", "comments", "replies", "sealed", "suggestions", "folders"} {
		d := filepath.Join(dir, sub)
		if err := os.MkdirAll(d, 0755); err != nil {
			return nil, fmt.Errorf("create dir %s: %w", d, err)
		}
	}
	s := &LocalStorage{
		dataDir:        dir,
		versionsDir:    filepath.Join(dir, "versions"),
		envelopesDir:   filepath.Join(dir, "envelopes"),
		signersDir:     filepath.Join(dir, "signers"),
		auditDir:       filepath.Join(dir, "audit"),
		commentsDir:    filepath.Join(dir, "comments"),
		repliesDir:     filepath.Join(dir, "replies"),
		sealedDir:      filepath.Join(dir, "sealed"),
		suggestionsDir: filepath.Join(dir, "suggestions"),
		foldersDir:     filepath.Join(dir, "folders"),
	}
	// Convert any pre-fix share-link record still keyed by its PLAINTEXT token,
	// so a deployment stops storing live capabilities the moment it starts this
	// binary — not the first time somebody happens to open a share link. This is
	// a hard error: a half-converted directory is exactly the state that would
	// make links disappear, and it must not be started over silently.
	if err := s.migrateShareLinks(); err != nil {
		return nil, err
	}
	return s, nil
}

// ---- helpers ----

// idPattern constrains any identifier used to build a storage path to a safe
// single path segment. It permits only ASCII letters, digits, '_' and '-', so
// it rejects empty ids, "." / "..", path separators, and NUL/control bytes.
var idPattern = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

// errInvalidID is returned when a client- or body-supplied identifier would
// escape the storage directory (path traversal) or is otherwise malformed.
var errInvalidID = fmt.Errorf("invalid id")

// validID reports whether id is a safe single path segment (see idPattern).
// Any id that reaches a path helper is validated with this so a crafted id such
// as "../../etc/passwd" can never be joined into a filesystem path.
func validID(id string) bool { return idPattern.MatchString(id) }

func (s *LocalStorage) filePath(id string) (string, error) {
	if !validID(id) {
		return "", errInvalidID
	}
	return filepath.Join(s.dataDir, id+".json"), nil
}

func (s *LocalStorage) versionPath(fileID, versionID string) (string, error) {
	if !validID(fileID) || !validID(versionID) {
		return "", errInvalidID
	}
	return filepath.Join(s.versionsDir, fileID+"_"+versionID+".json"), nil
}

func (s *LocalStorage) envelopePath(id string) (string, error) {
	if !validID(id) {
		return "", errInvalidID
	}
	return filepath.Join(s.envelopesDir, id+".json"), nil
}

func (s *LocalStorage) signerPath(id string) (string, error) {
	if !validID(id) {
		return "", errInvalidID
	}
	return filepath.Join(s.signersDir, id+".json"), nil
}

// auditDir/<envelopeID>/<eventID>.json — kept in a per-envelope sub-directory
// so ListAuditEvents can scan only relevant files.
func (s *LocalStorage) auditEventPath(envelopeID, eventID string) (string, error) {
	if !validID(envelopeID) || !validID(eventID) {
		return "", errInvalidID
	}
	return filepath.Join(s.auditDir, envelopeID, eventID+".json"), nil
}

// ============================================================
// File CRUD
// ============================================================

func (s *LocalStorage) ListFiles() ([]*models.File, error) {
	entries, err := os.ReadDir(s.dataDir)
	if err != nil {
		return nil, err
	}

	var files []*models.File
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		id := entry.Name()[:len(entry.Name())-5]
		file, err := s.GetFile(id)
		if err != nil {
			continue
		}
		files = append(files, file)
	}

	sort.Slice(files, func(i, j int) bool {
		return files[i].UpdatedAt.After(files[j].UpdatedAt)
	})
	return files, nil
}

func (s *LocalStorage) GetFile(id string) (*models.File, error) {
	path, err := s.filePath(id)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("file not found")
		}
		return nil, err
	}
	var file models.File
	if err := json.Unmarshal(data, &file); err != nil {
		return nil, err
	}
	return &file, nil
}

func (s *LocalStorage) CreateFile(file *models.File) error {
	file.CreatedAt = time.Now()
	file.UpdatedAt = time.Now()
	file.Rev = 1 // first revision (P2 optimistic concurrency)
	data, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return err
	}
	path, err := s.filePath(file.ID)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

func (s *LocalStorage) UpdateFile(file *models.File) error {
	existing, err := s.GetFile(file.ID)
	if err != nil {
		return err
	}

	// P2 optimistic concurrency: if the caller supplied a rev (>0), it must match
	// the stored rev — otherwise a concurrent writer already advanced it and this
	// PUT is stale. Reject with ErrRevConflict (→ 409) rather than clobbering.
	// A zero rev is an unconditional write (legacy client / explicit force).
	if file.Rev > 0 && file.Rev != existing.Rev {
		return ErrRevConflict
	}

	// Snapshot the current content before overwriting. Author records who made
	// the edit that superseded this snapshot (the current saver), stamped from the
	// verified requester by the handler — never from the client body.
	snap := &models.FileVersion{
		ID:        fmt.Sprintf("%d", time.Now().UnixNano()),
		FileID:    existing.ID,
		Name:      existing.Name,
		Author:    file.EditorID,
		Content:   existing.Content,
		CreatedAt: time.Now(),
	}
	_ = s.CreateVersion(snap)
	_ = s.PruneVersions(existing.ID, DefaultVersionCap)

	file.CreatedAt = existing.CreatedAt
	file.UpdatedAt = time.Now()
	file.Rev = existing.Rev + 1 // advance the revision on every committed write
	// Preserve organization metadata (folder/star/trash) across a content PUT:
	// the content-update path only carries Name/Content/Rev, so without this the
	// file's placement and favorite/trash state would be silently wiped on save.
	// Reparent/star/trash mutations go through the dedicated Move path instead.
	file.ParentID = existing.ParentID
	file.Starred = existing.Starred
	file.Trashed = existing.Trashed
	file.TrashedAt = existing.TrashedAt
	data, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return err
	}
	path, err := s.filePath(file.ID)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

func (s *LocalStorage) DeleteFile(id string) error {
	path, err := s.filePath(id)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("file not found")
		}
		return err
	}
	return nil
}

// UpdateFileMeta persists only the organization metadata (folder/star/trash)
// without snapshotting a version or advancing the content rev.
func (s *LocalStorage) UpdateFileMeta(id, parentID string, starred, trashed bool, trashedAt *time.Time) error {
	existing, err := s.GetFile(id)
	if err != nil {
		return err
	}
	existing.ParentID = parentID
	existing.Starred = starred
	existing.Trashed = trashed
	existing.TrashedAt = trashedAt
	existing.UpdatedAt = time.Now()
	data, err := json.MarshalIndent(existing, "", "  ")
	if err != nil {
		return err
	}
	path, err := s.filePath(id)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

// ============================================================
// Folders (parity: file organization) — folders/<id>.json
// ============================================================

func (s *LocalStorage) folderPath(id string) (string, error) {
	if !validID(id) {
		return "", errInvalidID
	}
	return filepath.Join(s.foldersDir, id+".json"), nil
}

func (s *LocalStorage) ListFolders() ([]*models.Folder, error) {
	entries, err := os.ReadDir(s.foldersDir)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var folders []*models.Folder
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		id := entry.Name()[:len(entry.Name())-5]
		f, err := s.GetFolder(id)
		if err != nil {
			continue
		}
		folders = append(folders, f)
	}
	sort.Slice(folders, func(i, j int) bool {
		return folders[i].Name < folders[j].Name
	})
	return folders, nil
}

func (s *LocalStorage) GetFolder(id string) (*models.Folder, error) {
	path, err := s.folderPath(id)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("folder not found")
		}
		return nil, err
	}
	var f models.Folder
	if err := json.Unmarshal(data, &f); err != nil {
		return nil, err
	}
	return &f, nil
}

func (s *LocalStorage) CreateFolder(f *models.Folder) error {
	now := time.Now()
	f.CreatedAt = now
	f.UpdatedAt = now
	data, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	path, err := s.folderPath(f.ID)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

func (s *LocalStorage) UpdateFolder(f *models.Folder) error {
	existing, err := s.GetFolder(f.ID)
	if err != nil {
		return err
	}
	f.CreatedAt = existing.CreatedAt
	f.UpdatedAt = time.Now()
	data, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	path, err := s.folderPath(f.ID)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

func (s *LocalStorage) DeleteFolder(id string) error {
	path, err := s.folderPath(id)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("folder not found")
		}
		return err
	}
	return nil
}

// ============================================================
// Version history (OFFICE-08)
// ============================================================

func (s *LocalStorage) CreateVersion(v *models.FileVersion) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	path, err := s.versionPath(v.FileID, v.ID)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

func (s *LocalStorage) ListVersions(fileID string) ([]*models.FileVersion, error) {
	entries, err := os.ReadDir(s.versionsDir)
	if err != nil {
		return nil, err
	}
	prefix := fileID + "_"
	var versions []*models.FileVersion
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasPrefix(name, prefix) || filepath.Ext(name) != ".json" {
			continue
		}
		base := strings.TrimSuffix(name, ".json")
		versionID := strings.TrimPrefix(base, prefix)
		v, err := s.GetVersion(fileID, versionID)
		if err != nil {
			continue
		}
		versions = append(versions, v)
	}
	sort.Slice(versions, func(i, j int) bool {
		return versions[i].CreatedAt.After(versions[j].CreatedAt)
	})
	return versions, nil
}

func (s *LocalStorage) GetVersion(fileID, versionID string) (*models.FileVersion, error) {
	path, err := s.versionPath(fileID, versionID)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("version not found")
		}
		return nil, err
	}
	var v models.FileVersion
	if err := json.Unmarshal(data, &v); err != nil {
		return nil, err
	}
	return &v, nil
}

func (s *LocalStorage) PruneVersions(fileID string, cap int) error {
	versions, err := s.ListVersions(fileID)
	if err != nil {
		return err
	}
	// versions is newest-first; remove tail beyond cap
	for i := cap; i < len(versions); i++ {
		if path, err := s.versionPath(fileID, versions[i].ID); err == nil {
			_ = os.Remove(path)
		}
	}
	return nil
}

// LabelVersion sets a user-defined label on a version (OFFICE-28).
func (s *LocalStorage) LabelVersion(fileID, versionID, label string) error {
	v, err := s.GetVersion(fileID, versionID)
	if err != nil {
		return err
	}
	v.Label = label
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	path, err := s.versionPath(fileID, versionID)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

// ============================================================
// Signing — Envelope CRUD (OFFICE-40)
// ============================================================

func (s *LocalStorage) CreateEnvelope(env *models.Envelope) error {
	now := time.Now()
	env.CreatedAt = now
	env.UpdatedAt = now
	data, err := json.MarshalIndent(env, "", "  ")
	if err != nil {
		return err
	}
	path, err := s.envelopePath(env.ID)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

func (s *LocalStorage) GetEnvelope(id string) (*models.Envelope, error) {
	path, err := s.envelopePath(id)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("envelope not found")
		}
		return nil, err
	}
	var env models.Envelope
	if err := json.Unmarshal(data, &env); err != nil {
		return nil, err
	}
	return &env, nil
}

func (s *LocalStorage) ListEnvelopes() ([]*models.Envelope, error) {
	entries, err := os.ReadDir(s.envelopesDir)
	if err != nil {
		return nil, err
	}
	var envs []*models.Envelope
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		id := entry.Name()[:len(entry.Name())-5]
		env, err := s.GetEnvelope(id)
		if err != nil {
			continue
		}
		envs = append(envs, env)
	}
	sort.Slice(envs, func(i, j int) bool {
		return envs[i].UpdatedAt.After(envs[j].UpdatedAt)
	})
	return envs, nil
}

func (s *LocalStorage) UpdateEnvelope(env *models.Envelope) error {
	existing, err := s.GetEnvelope(env.ID)
	if err != nil {
		return err
	}
	env.CreatedAt = existing.CreatedAt
	env.UpdatedAt = time.Now()
	data, err := json.MarshalIndent(env, "", "  ")
	if err != nil {
		return err
	}
	path, err := s.envelopePath(env.ID)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

func (s *LocalStorage) DeleteEnvelope(id string) error {
	path, err := s.envelopePath(id)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("envelope not found")
		}
		return err
	}
	return nil
}

// ============================================================
// Signing — Signer management (OFFICE-40)
// ============================================================

func (s *LocalStorage) UpsertSigner(sg *models.Signer) error {
	now := time.Now()
	// If the signer already exists, preserve CreatedAt.
	if existing, err := s.GetSigner(sg.ID); err == nil {
		sg.CreatedAt = existing.CreatedAt
	} else {
		sg.CreatedAt = now
	}
	sg.UpdatedAt = now
	data, err := json.MarshalIndent(sg, "", "  ")
	if err != nil {
		return err
	}
	path, err := s.signerPath(sg.ID)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

func (s *LocalStorage) GetSigner(id string) (*models.Signer, error) {
	path, err := s.signerPath(id)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("signer not found")
		}
		return nil, err
	}
	var sg models.Signer
	if err := json.Unmarshal(data, &sg); err != nil {
		return nil, err
	}
	return &sg, nil
}

func (s *LocalStorage) ListSignersByEnvelope(envelopeID string) ([]*models.Signer, error) {
	entries, err := os.ReadDir(s.signersDir)
	if err != nil {
		return nil, err
	}
	var signers []*models.Signer
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		id := entry.Name()[:len(entry.Name())-5]
		sg, err := s.GetSigner(id)
		if err != nil {
			continue
		}
		if sg.EnvelopeID == envelopeID {
			signers = append(signers, sg)
		}
	}
	sort.Slice(signers, func(i, j int) bool {
		return signers[i].Order < signers[j].Order
	})
	return signers, nil
}

// ============================================================
// Signing — Token index (OFFICE-42)
// ============================================================
// Tokens are stored as <dataDir>/tokens/<token>.json → {envelope_id, signer_id}.

func (s *LocalStorage) tokenPath(token string) (string, error) {
	if !validID(token) {
		return "", errInvalidID
	}
	return filepath.Join(s.dataDir, "tokens", token+".json"), nil
}

type localTokenRef struct {
	EnvelopeID string `json:"envelope_id"`
	SignerID   string `json:"signer_id"`
}

func (s *LocalStorage) StoreSignerToken(token, envelopeID, signerID string) error {
	path, err := s.tokenPath(token)
	if err != nil {
		return err
	}
	dir := filepath.Join(s.dataDir, "tokens")
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("create tokens dir: %w", err)
	}
	ref := localTokenRef{EnvelopeID: envelopeID, SignerID: signerID}
	data, err := json.Marshal(ref)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

func (s *LocalStorage) ResolveToken(token string) (string, string, error) {
	path, err := s.tokenPath(token)
	if err != nil {
		return "", "", err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", "", fmt.Errorf("token not found")
		}
		return "", "", err
	}
	var ref localTokenRef
	if err := json.Unmarshal(data, &ref); err != nil {
		return "", "", err
	}
	return ref.EnvelopeID, ref.SignerID, nil
}

// ============================================================
// Signing — Append-only audit log (OFFICE-40)
// ============================================================
// AppendAuditEvent writes a new, immutable event file.
// There is intentionally no UpdateAuditEvent or DeleteAuditEvent method.
func (s *LocalStorage) AppendAuditEvent(ev *models.AuditEvent) error {
	path, err := s.auditEventPath(ev.EnvelopeID, ev.ID)
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("create audit envelope dir: %w", err)
	}
	// Guard: never overwrite an existing audit event.
	if _, err := os.Stat(path); err == nil {
		return fmt.Errorf("audit event %s already exists (append-only)", ev.ID)
	}
	data, err := json.MarshalIndent(ev, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0444) // read-only permissions reinforce immutability
}

func (s *LocalStorage) ListAuditEvents(envelopeID string) ([]*models.AuditEvent, error) {
	dir := filepath.Join(s.auditDir, envelopeID)
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return nil, nil // no events yet — valid state
	}
	if err != nil {
		return nil, err
	}
	var events []*models.AuditEvent
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var ev models.AuditEvent
		if err := json.Unmarshal(data, &ev); err != nil {
			continue
		}
		events = append(events, &ev)
	}
	sort.Slice(events, func(i, j int) bool {
		return events[i].Timestamp.Before(events[j].Timestamp)
	})
	return events, nil
}

// ============================================================
// Sealed PDF store (OFFICE-46)
// ============================================================

func (s *LocalStorage) sealedPath(envelopeID string) (string, error) {
	if !validID(envelopeID) {
		return "", errInvalidID
	}
	return filepath.Join(s.sealedDir, envelopeID+".pdf"), nil
}

func (s *LocalStorage) StoreSealedPDF(envelopeID string, data []byte) error {
	path, err := s.sealedPath(envelopeID)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

func (s *LocalStorage) GetSealedPDF(envelopeID string) ([]byte, error) {
	path, err := s.sealedPath(envelopeID)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("sealed PDF not found")
		}
		return nil, err
	}
	return data, nil
}

// ============================================================
// Comments (OFFICE-26)
// ============================================================
// comments/<fileID>/<commentID>.json
// replies/<commentID>/<replyID>.json

func (s *LocalStorage) commentPath(fileID, commentID string) (string, error) {
	if !validID(fileID) || !validID(commentID) {
		return "", errInvalidID
	}
	return filepath.Join(s.commentsDir, fileID, commentID+".json"), nil
}

func (s *LocalStorage) replyPath(commentID, replyID string) (string, error) {
	if !validID(commentID) || !validID(replyID) {
		return "", errInvalidID
	}
	return filepath.Join(s.repliesDir, commentID, replyID+".json"), nil
}

func (s *LocalStorage) CreateComment(c *models.Comment) error {
	path, err := s.commentPath(c.FileID, c.ID)
	if err != nil {
		return err
	}
	c.CreatedAt = time.Now()
	c.UpdatedAt = time.Now()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

func (s *LocalStorage) GetComment(fileID, commentID string) (*models.Comment, error) {
	path, err := s.commentPath(fileID, commentID)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("comment not found")
		}
		return nil, err
	}
	var c models.Comment
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, err
	}
	return &c, nil
}

func (s *LocalStorage) ListComments(fileID string) ([]*models.Comment, error) {
	dir := filepath.Join(s.commentsDir, fileID)
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var comments []*models.Comment
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		id := entry.Name()[:len(entry.Name())-5]
		c, err := s.GetComment(fileID, id)
		if err != nil {
			continue
		}
		comments = append(comments, c)
	}
	sort.Slice(comments, func(i, j int) bool {
		return comments[i].CreatedAt.Before(comments[j].CreatedAt)
	})
	return comments, nil
}

func (s *LocalStorage) UpdateComment(c *models.Comment) error {
	existing, err := s.GetComment(c.FileID, c.ID)
	if err != nil {
		return err
	}
	c.CreatedAt = existing.CreatedAt
	c.UpdatedAt = time.Now()
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	path, err := s.commentPath(c.FileID, c.ID)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

func (s *LocalStorage) DeleteComment(fileID, commentID string) error {
	path, err := s.commentPath(fileID, commentID)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("comment not found")
		}
		return err
	}
	return nil
}

func (s *LocalStorage) CreateReply(r *models.CommentReply) error {
	path, err := s.replyPath(r.CommentID, r.ID)
	if err != nil {
		return err
	}
	r.CreatedAt = time.Now()
	r.UpdatedAt = time.Now()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

func (s *LocalStorage) GetReply(commentID, replyID string) (*models.CommentReply, error) {
	path, err := s.replyPath(commentID, replyID)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("reply not found")
		}
		return nil, err
	}
	var r models.CommentReply
	if err := json.Unmarshal(data, &r); err != nil {
		return nil, err
	}
	return &r, nil
}

func (s *LocalStorage) ListReplies(commentID string) ([]*models.CommentReply, error) {
	dir := filepath.Join(s.repliesDir, commentID)
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var replies []*models.CommentReply
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		id := entry.Name()[:len(entry.Name())-5]
		r, err := s.GetReply(commentID, id)
		if err != nil {
			continue
		}
		replies = append(replies, r)
	}
	sort.Slice(replies, func(i, j int) bool {
		return replies[i].CreatedAt.Before(replies[j].CreatedAt)
	})
	return replies, nil
}

func (s *LocalStorage) UpdateReply(r *models.CommentReply) error {
	existing, err := s.GetReply(r.CommentID, r.ID)
	if err != nil {
		return err
	}
	r.CreatedAt = existing.CreatedAt
	r.UpdatedAt = time.Now()
	data, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	path, err := s.replyPath(r.CommentID, r.ID)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

// ============================================================
// Suggestions / track-changes (OFFICE-27)
// ============================================================
// suggestions/<fileID>/<suggestionID>.json

func (s *LocalStorage) suggestionPath(fileID, suggestionID string) (string, error) {
	if !validID(fileID) || !validID(suggestionID) {
		return "", errInvalidID
	}
	return filepath.Join(s.suggestionsDir, fileID, suggestionID+".json"), nil
}

func (s *LocalStorage) CreateSuggestion(sg *models.Suggestion) error {
	path, err := s.suggestionPath(sg.FileID, sg.ID)
	if err != nil {
		return err
	}
	sg.CreatedAt = time.Now()
	sg.UpdatedAt = time.Now()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(sg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

func (s *LocalStorage) GetSuggestion(fileID, suggestionID string) (*models.Suggestion, error) {
	path, err := s.suggestionPath(fileID, suggestionID)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("suggestion not found")
		}
		return nil, err
	}
	var sg models.Suggestion
	if err := json.Unmarshal(data, &sg); err != nil {
		return nil, err
	}
	return &sg, nil
}

func (s *LocalStorage) ListSuggestions(fileID string) ([]*models.Suggestion, error) {
	dir := filepath.Join(s.suggestionsDir, fileID)
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var suggestions []*models.Suggestion
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		id := entry.Name()[:len(entry.Name())-5]
		sg, err := s.GetSuggestion(fileID, id)
		if err != nil {
			continue
		}
		suggestions = append(suggestions, sg)
	}
	sort.Slice(suggestions, func(i, j int) bool {
		return suggestions[i].CreatedAt.Before(suggestions[j].CreatedAt)
	})
	return suggestions, nil
}

func (s *LocalStorage) UpdateSuggestion(sg *models.Suggestion) error {
	existing, err := s.GetSuggestion(sg.FileID, sg.ID)
	if err != nil {
		return err
	}
	sg.CreatedAt = existing.CreatedAt
	sg.UpdatedAt = time.Now()
	data, err := json.MarshalIndent(sg, "", "  ")
	if err != nil {
		return err
	}
	path, err := s.suggestionPath(sg.FileID, sg.ID)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

func (s *LocalStorage) DeleteSuggestion(fileID, suggestionID string) error {
	path, err := s.suggestionPath(fileID, suggestionID)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("suggestion not found")
		}
		return err
	}
	return nil
}
