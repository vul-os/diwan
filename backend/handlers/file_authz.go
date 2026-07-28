package handlers

// file_authz.go — per-file authorization shared by every file-scoped handler
// (files, versions, activity, comments, suggestions, exports). This closes the
// P0 hole where Get/Update/Delete ignored the authenticated identity and List
// returned all files globally.
//
// The verified identity comes from requesterID(c) (JWT sub), and a denied request
// returns 404 — NOT 403 — so the response never leaks whether a file the caller
// cannot see actually exists.

import (
	"log"
	"net/http"
	"os"
	"sync"

	"diwan/backend/fileacl"
	"diwan/backend/middleware"
	"diwan/backend/storage"

	"github.com/gin-gonic/gin"
)

// FileAuthz wraps a fileacl.Store and provides gin-aware access enforcement.
//
// authEnabled is the MULTI-TENANT posture flag. It is true whenever ANY identity
// source is active — native product-JWT auth (cfg.Auth.Enabled) OR SSO session
// introspection (IDENTITY_URL wired). It is NOT native auth alone: an SSO-only
// deployment has cfg.Auth.Enabled == false yet is a first-class multi-user
// deployment, so the caller passes cfg.Auth.Enabled || sessionIntrospector != nil.
// It changes the fail-safe posture:
//
//   - single-user (OSS local mode, NO identity source): a degraded/nil store or
//     an unowned/legacy file fails OPEN so the operator is never locked out of
//     pre-existing documents.
//   - multi-tenant (native auth OR SSO): NO fail-open. A nil/degraded store
//     denies, and an unowned file is NOT globally readable (it is denied for
//     non-owners) so a missing owner record can never leak another tenant's
//     document.
type FileAuthz struct {
	acl         fileacl.Store
	authEnabled bool
}

// fileACLDBPath resolves the ACL SQLite DSN from env, defaulting to a durable
// file under the data dir.
func fileACLDBPath() string {
	if v := os.Getenv("VULOS_FILEACL_DB"); v != "" {
		return v
	}
	return "./data/fileacl.db"
}

var (
	defaultFileAuthz *FileAuthz
	fileAuthzOnce    sync.Once
)

// SharedFileAuthz returns a process-wide FileAuthz backed by durable SQLite.
// If the DB cannot be opened it falls back to an in-memory NullStore so the app
// still boots (degraded: ACLs do not persist) rather than crashing.
func SharedFileAuthz() *FileAuthz {
	fileAuthzOnce.Do(func() {
		if st, err := fileacl.NewSQLiteStore(fileACLDBPath()); err == nil {
			defaultFileAuthz = &FileAuthz{acl: st}
		} else {
			defaultFileAuthz = &FileAuthz{acl: fileacl.NewNullStore()}
		}
	})
	return defaultFileAuthz
}

// InitFileAuthz wires the process-wide FileAuthz to the ACL store that travels
// with the active storage backend. When the backend implements
// storage.ACLProvider (Postgres), its co-located ACL store is used so ownership
// is in the SAME database (transactional + replicated) as the files. Otherwise
// (sqlite/local backend) the separate sqlite ACL store is used. Call ONCE from
// main() before constructing the file handlers; it pins the sync.Once so later
// SharedFileAuthz() calls return the same authorizer.
//
// authEnabled MUST be the MULTI-TENANT posture: cfg.Auth.Enabled OR an SSO
// session introspector is wired (IDENTITY_URL set). In that posture the ACL
// store is load-bearing for cross-tenant isolation, so a failure to open it is
// FATAL (we refuse to boot in a degraded, fail-open posture) — this covers the
// SSO-only deployment where native auth is off but the box still brokers many
// users. Only in true single-user mode (no identity source at all) is a degraded
// in-memory NullStore acceptable.
func InitFileAuthz(store storage.Storage, authEnabled bool) *FileAuthz {
	fileAuthzOnce.Do(func() {
		if p, ok := store.(storage.ACLProvider); ok {
			defaultFileAuthz = &FileAuthz{acl: p.ACLStore(), authEnabled: authEnabled}
			return
		}
		if st, err := fileacl.NewSQLiteStore(fileACLDBPath()); err == nil {
			defaultFileAuthz = &FileAuthz{acl: st, authEnabled: authEnabled}
		} else if authEnabled {
			// Multi-tenant mode: never run with a degraded, fail-open ACL store.
			log.Fatalf("file ACL store open failed (%s) with auth enabled: %v "+
				"(refusing to boot without per-file isolation)", fileACLDBPath(), err)
		} else {
			defaultFileAuthz = &FileAuthz{acl: fileacl.NewNullStore(), authEnabled: false}
		}
	})
	return defaultFileAuthz
}

// NewFileAuthz builds a FileAuthz over a caller-supplied store (tests).
func NewFileAuthz(acl fileacl.Store) *FileAuthz {
	return &FileAuthz{acl: acl}
}

// NewFileAuthzWithAuth builds a FileAuthz over a caller-supplied store with an
// explicit auth posture (tests that exercise the multi-tenant fail-closed path).
func NewFileAuthzWithAuth(acl fileacl.Store, authEnabled bool) *FileAuthz {
	return &FileAuthz{acl: acl, authEnabled: authEnabled}
}

// Store exposes the underlying ACL store for owner-recording on file create
// and share management.
func (a *FileAuthz) Store() fileacl.Store { return a.acl }

// multiTenant reports whether auth is enabled (nil-safe). In multi-tenant mode
// the ACL store is load-bearing and there is NO fail-open.
func (a *FileAuthz) multiTenant() bool { return a != nil && a.authEnabled }

// canAccess reports whether the caller may touch fileID. Admins always pass.
func (a *FileAuthz) canAccess(c *gin.Context, fileID string) bool {
	if a == nil || a.acl == nil {
		// No authorizer wired (degraded). When auth is enabled this MUST fail
		// closed: a degraded ACL store can never grant cross-tenant access. When
		// auth is disabled (single-user) fail open so the operator isn't locked out.
		return !a.multiTenant()
	}
	if c.GetBool(middleware.CtxIsAdmin) {
		return true
	}
	allowed, recorded, err := a.acl.CanAccess(fileID, requesterID(c))
	if err != nil {
		// On a storage error, fail closed for safety.
		return false
	}
	// When auth is enabled, an UNOWNED/legacy file (no recorded owner) must NOT
	// be globally readable — that would leak any file whose owner record is
	// missing. Deny non-owners in multi-tenant mode; the fail-safe "unowned ⇒
	// allow" is only for single-user/local (auth-disabled) mode.
	if a.authEnabled && !recorded {
		return false
	}
	return allowed
}

// require enforces access on a file op. On denial it writes a 404 (no existence
// leak) and returns false. Callers should `return` immediately when it is false.
func (a *FileAuthz) require(c *gin.Context, fileID string) bool {
	if a.canAccess(c, fileID) {
		return true
	}
	c.JSON(http.StatusNotFound, gin.H{"error": "file not found"})
	return false
}

// recordOwner stamps the creating identity as the owner of a new file. Called
// from FileHandler.Create. It returns an error so the caller can fail the create
// when ownership could not be recorded: in multi-tenant mode an unowned file is
// NOT globally readable, so a swallowed SetOwner error would otherwise leave the
// new document INACCESSIBLE to its creator (and a regression of the old fail-open
// behaviour would leave it accessible to everyone). Either way the create must
// not silently succeed with no owner.
//
// In single-user / auth-disabled mode a nil store is fine (no isolation needed).
func (a *FileAuthz) recordOwner(c *gin.Context, fileID string) error {
	if a == nil || a.acl == nil {
		return nil
	}
	return a.acl.SetOwner(fileID, requesterID(c))
}

// requireOwner enforces that the requester is the file's owner (or an admin).
// It first verifies basic access via require — returning false with 404 if the
// caller has no access at all (no existence leak). When the caller does have
// access but is not the owner, it returns 403 so the caller knows the operation
// is not permitted at their privilege level.
//
// In single-user / auth-disabled mode this is a no-op beyond the base require().
func (a *FileAuthz) requireOwner(c *gin.Context, fileID string) bool {
	// Basic access check — returns 404 on full denial.
	if !a.require(c, fileID) {
		return false
	}
	// In single-user / auth-disabled mode, ownership enforcement is not
	// meaningful (there is only one effective user).
	if a == nil || !a.authEnabled {
		return true
	}
	// Admins bypass ownership checks.
	if c.GetBool(middleware.CtxIsAdmin) {
		return true
	}
	role, ok, err := a.acl.GetRole(fileID, requesterID(c))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "ACL check failed"})
		return false
	}
	// Unowned / legacy file (no ACL record): in multi-tenant mode require()
	// already denied above; we should not reach here, but allow defensively.
	if !ok {
		return true
	}
	if role != fileacl.RoleOwner {
		c.JSON(http.StatusForbidden, gin.H{"error": "only the document owner may perform this action"})
		return false
	}
	return true
}

// requireEditor enforces that the requester has at least editor rights (editor
// or owner, or admin). Viewers may read but not mutate content.
// Returns false with 404 if the caller has no access, or 403 if they are a
// read-only viewer.
func (a *FileAuthz) requireEditor(c *gin.Context, fileID string) bool {
	// Basic access check — returns 404 on full denial.
	if !a.require(c, fileID) {
		return false
	}
	if a == nil || !a.authEnabled {
		return true
	}
	if c.GetBool(middleware.CtxIsAdmin) {
		return true
	}
	role, ok, err := a.acl.GetRole(fileID, requesterID(c))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "ACL check failed"})
		return false
	}
	if !ok {
		// No ACL record (unowned/legacy): require() already passed, allow.
		return true
	}
	// Fail closed: only owners and editors may mutate content. Viewers and
	// commenters (and any future non-edit role) are read-only for the body.
	if role != fileacl.RoleOwner && role != fileacl.RoleEditor {
		c.JSON(http.StatusForbidden, gin.H{"error": "your role does not permit modifying content"})
		return false
	}
	return true
}

// requireCommenter enforces that the requester has at least commenter rights
// (commenter, editor, or owner, or admin). Plain viewers may read a file's
// comments/suggestions but must NOT be able to create, edit, or delete them —
// fileacl.RoleCommenter is exactly the role designed for this, but until this
// method existed every comment/suggestion mutation only called require() (plain
// read access), so a viewer-shared user could comment/suggest despite being
// read-only (ACL bypass). Returns false with 404 if the caller has no access,
// or 403 if they are a read-only viewer.
func (a *FileAuthz) requireCommenter(c *gin.Context, fileID string) bool {
	// Basic access check — returns 404 on full denial.
	if !a.require(c, fileID) {
		return false
	}
	if a == nil || !a.authEnabled {
		return true
	}
	if c.GetBool(middleware.CtxIsAdmin) {
		return true
	}
	role, ok, err := a.acl.GetRole(fileID, requesterID(c))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "ACL check failed"})
		return false
	}
	if !ok {
		// No ACL record (unowned/legacy): require() already passed, allow.
		return true
	}
	// Fail closed: viewers may read but not comment/suggest.
	if role == fileacl.RoleViewer {
		c.JSON(http.StatusForbidden, gin.H{"error": "your role does not permit commenting on this file"})
		return false
	}
	return true
}

// canAccessEnvelopeACL reports whether the caller may touch an envelope. The
// e-signature subsystem ties an envelope to the per-file ACL: access is granted
// when the caller can access the envelope's SourceFileID (the document being
// signed) OR the envelope id itself (recorded as ACL-owned by the creator so
// envelopes with an empty/unowned SourceFileID are still private). Admins pass
// via canAccess. This is the single authorization predicate shared by the
// envelope CRUD, send, seal, and orchestration handlers.
func (a *FileAuthz) canAccessEnvelopeACL(c *gin.Context, sourceFileID, envelopeID string) bool {
	if a == nil || a.acl == nil {
		// Degraded: fail open only in single-user mode; fail closed under auth.
		return !a.multiTenant()
	}
	if sourceFileID != "" && a.canAccess(c, sourceFileID) {
		return true
	}
	return a.canAccess(c, envelopeID)
}
