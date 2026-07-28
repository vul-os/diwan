package models

import "time"

type FileType string

const (
	FileTypeDoc   FileType = "doc"
	FileTypeSheet FileType = "sheet"
	FileTypeSlide FileType = "slide"
	// FileTypeWhiteboard is an Excalidraw scene (elements + image blobs) synced,
	// like Docs, over Office's distributed peer-to-peer collab engine. Its content
	// is a plain JSON scene ({elements:[…], files:{…}}); the schema-agnostic
	// docindex extractor picks up text elements for search with no special-casing.
	FileTypeWhiteboard FileType = "whiteboard"
)

type File struct {
	ID      string      `json:"id"`
	Name    string      `json:"name"`
	Type    FileType    `json:"type"`
	Content interface{} `json:"content"`
	// Rev is a monotonically increasing revision counter used for optimistic
	// concurrency (P2). GET returns the current rev; a PUT must echo the rev it
	// last read, and the store rejects a stale PUT with a conflict (compare-and-
	// swap) so a concurrent editor's save can't silently overwrite a newer one.
	// rev 0 means "unknown / force" (legacy clients that don't send it).
	Rev int64 `json:"rev"`
	// ParentID is the id of the folder this file lives in ("" = root). Folders
	// form a tree per-owner; a file's parent is only ever a folder OWNED by the
	// same account (enforced server-side), so folder organization can never leak
	// or move another account's file into a foreign tree (see FileHandler.Move).
	ParentID string `json:"parent_id,omitempty"`
	// Starred marks a file as a favorite for quick access. Per-account UX flag.
	Starred bool `json:"starred,omitempty"`
	// Trashed soft-deletes a file: it disappears from normal listings and moves
	// to the Trash view, from which it can be Restored or PERMANENTLY deleted.
	// A hard DELETE is only permitted from trash (or as the legacy direct path).
	Trashed   bool       `json:"trashed,omitempty"`
	TrashedAt *time.Time `json:"trashed_at,omitempty"`
	CreatedAt time.Time  `json:"created_at"`
	UpdatedAt time.Time  `json:"updated_at"`
	// EditorID is a TRANSIENT, request-scoped field: the verified account id of
	// the caller performing an UpdateFile. It is NEVER persisted on the file row —
	// the store reads it only to stamp the version snapshot's Author (who made the
	// edit that superseded the prior content). Stamped server-side from the
	// verified requester, never trusted from the client body.
	EditorID string `json:"-"`
}

// Folder is a container in the per-account file tree. Folders themselves are
// ACL-owned exactly like files (an owner is recorded on create), so a folder —
// and everything filed under it — is private by default and can never be seen
// or reparented by another account. A folder may nest under another folder via
// ParentID ("" = root). Trashed folders behave like trashed files.
type Folder struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	ParentID  string     `json:"parent_id,omitempty"`
	Starred   bool       `json:"starred,omitempty"`
	Trashed   bool       `json:"trashed,omitempty"`
	TrashedAt *time.Time `json:"trashed_at,omitempty"`
	CreatedAt time.Time  `json:"created_at"`
	UpdatedAt time.Time  `json:"updated_at"`
}

// CreateFolderRequest is the body for POST /api/folders.
type CreateFolderRequest struct {
	Name     string `json:"name" binding:"required"`
	ParentID string `json:"parent_id,omitempty"`
}

// UpdateFolderRequest is the body for PUT /api/folders/:id (rename / reparent /
// star / trash toggle). All fields optional; only supplied ones are applied.
type UpdateFolderRequest struct {
	Name     *string `json:"name,omitempty"`
	ParentID *string `json:"parent_id,omitempty"`
	Starred  *bool   `json:"starred,omitempty"`
}

// MoveFileRequest is the body for POST /api/files/:id/move — reparent and/or
// toggle star/trash. All fields are optional pointers so an omitted field is
// left unchanged.
type MoveFileRequest struct {
	ParentID *string `json:"parent_id,omitempty"` // target folder id ("" = root)
	Starred  *bool   `json:"starred,omitempty"`
	Trashed  *bool   `json:"trashed,omitempty"` // true = to trash, false = restore
}

// FileVersion is an immutable snapshot of a file's content taken before each save.
type FileVersion struct {
	ID     string `json:"id"`
	FileID string `json:"file_id"`
	Name   string `json:"name"`            // file name at snapshot time
	Label  string `json:"label,omitempty"` // optional user-defined label e.g. "v1 final draft"
	// Author records the account id that produced the edit which this snapshot
	// captured (the identity of the save that superseded it). Empty for legacy
	// snapshots created before authorship was recorded, and for the single-user /
	// auth-disabled "self" identity when no account is bound. Never trusted from
	// the client — always stamped server-side from the verified requester id.
	Author    string      `json:"author,omitempty"`
	Content   interface{} `json:"content"`
	CreatedAt time.Time   `json:"created_at"`
}

// ActivityEventKind classifies an entry in the document activity feed.
type ActivityEventKind string

const (
	ActivityEdit     ActivityEventKind = "edit"
	ActivityComment  ActivityEventKind = "comment"
	ActivitySign     ActivityEventKind = "sign"
	ActivitySnapshot ActivityEventKind = "snapshot"
)

// ActivityEvent is one entry in the per-document activity feed (OFFICE-28).
// It is derived/assembled by the handler — not stored as its own record.
type ActivityEvent struct {
	Kind      ActivityEventKind `json:"kind"`
	ID        string            `json:"id"`
	FileID    string            `json:"file_id"`
	Author    string            `json:"author,omitempty"` // display name / author_id / signer name
	Summary   string            `json:"summary"`          // human-readable description
	Label     string            `json:"label,omitempty"`  // snapshot label when kind=snapshot
	RefID     string            `json:"ref_id,omitempty"` // version id / comment id / signer id
	Timestamp time.Time         `json:"timestamp"`
}

// LabelVersionRequest is the request body for PUT /api/files/:id/versions/:vid/label.
type LabelVersionRequest struct {
	Label string `json:"label" binding:"required"`
}

// ShareLink is an anonymous, read-only, token-gated access grant to a single
// document. Unlike an account-share (which grants a named Vulos account a role),
// a share link lets anyone holding the (unguessable, signed) token open the doc
// in a read-only viewer — optionally until an expiry, and optionally behind a
// password. It NEVER conveys write access and is independent of the ACL roster.
//
// Security invariants (enforced server-side, never by the client):
//   - Token is an opaque capability minted server-side from crypto/rand;
//     possession alone grants access, so it MUST be unguessable and revocable.
//   - The token is stored ONLY as a SHA-256 hash (TokenHash), never in the
//     clear — reading the share-link store yields hashes, not usable links.
//     The raw token exists in memory for exactly one request: the mint.
//   - PasswordHash, when set, is a bcrypt hash — the plaintext is never stored
//     and the view route rejects access until the correct password is supplied.
//   - ExpiresAt, when non-nil, hard-bounds the link's lifetime; an expired link
//     is treated as if it did not exist.
//   - Revoked links are dead permanently (the owner can kill a leaked link).
//   - The view route this backs is READ-ONLY: it returns document content only,
//     with no path to edit, share, or escalate.
type ShareLink struct {
	ID     string `json:"id"`
	FileID string `json:"file_id"`
	// Token is the raw opaque credential embedded in the share URL. It is
	// populated on exactly one code path — the mint response, so the owner can
	// copy the URL once — and is empty on every read path, because no backend
	// stores it. `omitempty` therefore keeps it out of list/read JSON entirely
	// rather than emitting a misleading `"token": ""`.
	Token string `json:"token,omitempty"`
	// TokenHash is the hex SHA-256 of Token (signing.HashShareLinkToken) and is
	// the persisted lookup key. Never serialized to clients: it is not a secret
	// in the token's sense, but it is also of no use to any client, and shipping
	// it invites someone to treat it as the link.
	TokenHash string `json:"-"`
	// CreatedBy records the owner account that minted the link (audit/authz).
	CreatedBy string `json:"created_by"`
	// PasswordHash is the bcrypt hash of the link password, or "" for no password.
	// Never serialized to clients (the hash must not leak); `json:"-"`.
	PasswordHash string `json:"-"`
	// HasPassword is a derived, safe-to-expose flag telling the UI/view route
	// whether a password prompt is required, without exposing the hash.
	HasPassword bool       `json:"has_password"`
	ExpiresAt   *time.Time `json:"expires_at,omitempty"`
	Revoked     bool       `json:"revoked"`
	CreatedAt   time.Time  `json:"created_at"`
}

// CreateShareLinkRequest is the body for POST /api/files/:id/share-links.
type CreateShareLinkRequest struct {
	// Password, when non-empty, gates the link behind a bcrypt-verified prompt.
	Password string `json:"password,omitempty"`
	// ExpiresInSeconds, when > 0, bounds the link lifetime (TTL from now). 0/omitted
	// mints a non-expiring link.
	ExpiresInSeconds int64 `json:"expires_in_seconds,omitempty"`
}

// TransferOwnerRequest is the body for POST /api/files/:id/transfer-owner.
type TransferOwnerRequest struct {
	// NewOwner is the account id that will become the file's sole owner. The
	// current owner is demoted to editor so they retain access unless they
	// explicitly remove themselves.
	NewOwner string `json:"new_owner" binding:"required"`
}

type CreateFileRequest struct {
	Name    string      `json:"name" binding:"required"`
	Type    FileType    `json:"type" binding:"required"`
	Content interface{} `json:"content"`
}

type UpdateFileRequest struct {
	Name    string      `json:"name"`
	Content interface{} `json:"content"`
	// Rev is the revision the client last read (optimistic concurrency, P2). When
	// > 0 the store performs a compare-and-swap and returns ErrRevConflict if the
	// stored rev has moved on. When 0/omitted the write is unconditional (legacy
	// clients / first-write-wins fallback) so existing callers keep working.
	Rev int64 `json:"rev,omitempty"`
}

type LoginRequest struct {
	Password string `json:"password" binding:"required"`
	// AccountID optionally binds the session to a Vulos account id. It becomes
	// the JWT subject so downstream handlers can derive identity from the
	// verified token instead of trusting a client-supplied header.
	AccountID string `json:"account_id,omitempty"`
}

type LoginResponse struct {
	Token   string `json:"token"`
	Message string `json:"message"`
}

type ErrorResponse struct {
	Error             string `json:"error"`
	RemainingAttempts int    `json:"remaining_attempts,omitempty"`
	LockedUntil       string `json:"locked_until,omitempty"`
}

type AuthStatusResponse struct {
	Enabled       bool `json:"enabled"`
	Authenticated bool `json:"authenticated"`
}

// ---- Comments (OFFICE-26) ----

// CommentAnchorType identifies what object a comment is attached to.
type CommentAnchorType string

const (
	AnchorTextRange CommentAnchorType = "text_range" // Docs: from/to character offsets
	AnchorCell      CommentAnchorType = "cell"       // Sheets: sheet/row/col
	AnchorSlide     CommentAnchorType = "slide"      // Slides: slide id
)

// CommentAnchor describes the location a comment is pinned to.
type CommentAnchor struct {
	Type CommentAnchorType `json:"type"`
	// text_range fields
	From int `json:"from,omitempty"`
	To   int `json:"to,omitempty"`
	// cell fields
	Sheet string `json:"sheet,omitempty"`
	Row   int    `json:"row,omitempty"`
	Col   int    `json:"col,omitempty"`
	// slide field
	SlideID string `json:"slide_id,omitempty"`
	// human-readable snapshot of the anchored text/cell (used if anchor orphans)
	Snapshot string `json:"snapshot,omitempty"`
}

// CommentState is the lifecycle of a comment thread.
type CommentState string

const (
	CommentOpen     CommentState = "open"
	CommentResolved CommentState = "resolved"
)

// Comment is the root of a thread, anchored to a file location.
// SeqClock is a CRDT HLC tick for LWW-merge across peers.
type Comment struct {
	ID       string        `json:"id"`
	FileID   string        `json:"file_id"`
	Anchor   CommentAnchor `json:"anchor"`
	AuthorID string        `json:"author_id"`
	Body     string        `json:"body"`
	State    CommentState  `json:"state"`
	SeqClock string        `json:"seq_clock"`
	// Mentions is the set of account ids @-mentioned in Body. It is a stored
	// reference list (validated server-side against the file's collaborators, so
	// a comment can never mention — and thereby notify — a stranger). The raw
	// Body keeps the "@name" text; the client renders it as a chip. Text is
	// never HTML — it is always escaped on render (React text node), so a
	// crafted mention/body can carry no markup or script.
	Mentions []string `json:"mentions,omitempty"`
	// Assignee is the account id this comment is assigned to as a task (Google-
	// parity "assign"). It is validated server-side against the file's actual
	// collaborators — a comment can never be assigned to a non-participant — and is
	// CLEARED when the thread is resolved (a resolved task has no open assignee).
	// Empty means unassigned. The assignee is notified on assignment.
	Assignee  string    `json:"assignee,omitempty"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// CommentReply is a threaded reply to a Comment.
type CommentReply struct {
	ID        string    `json:"id"`
	CommentID string    `json:"comment_id"`
	FileID    string    `json:"file_id"`
	AuthorID  string    `json:"author_id"`
	Body      string    `json:"body"`
	SeqClock  string    `json:"seq_clock"`
	Deleted   bool      `json:"deleted,omitempty"` // tombstone
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// CommentOp is the wire format for CRDT op exchange between peers/server.
type CommentOp struct {
	Op        string        `json:"op"` // "add_comment"|"edit_comment"|"resolve_comment"|"reopen_comment"|"add_reply"|"edit_reply"|"delete_reply"
	Comment   *Comment      `json:"comment,omitempty"`
	Reply     *CommentReply `json:"reply,omitempty"`
	AppliedAt string        `json:"applied_at"`
}

type CreateCommentRequest struct {
	Anchor   CommentAnchor `json:"anchor" binding:"required"`
	AuthorID string        `json:"author_id"`
	Body     string        `json:"body" binding:"required"`
	// Mentions is the client's list of @-mentioned account ids. It is a HINT
	// only: the server re-validates each id against the file's collaborator set
	// before storing/notifying, so a client can never mention a non-collaborator.
	Mentions []string `json:"mentions,omitempty"`
	// Assignee optionally assigns the new comment (task) to a collaborator. It is
	// a HINT — the server validates it against the file's collaborators (see
	// CommentHandler.validAssignee) and drops it if the account has no access.
	Assignee string `json:"assignee,omitempty"`
}

// ---- Notifications (parity: @-mention surfacing) ----

// NotificationKind classifies an in-app notification entry.
type NotificationKind string

const (
	// NotifyMention is raised when an account is @-mentioned in a comment/reply.
	NotifyMention NotificationKind = "mention"
	// NotifyAssign is raised when a comment (task) is assigned to an account.
	NotifyAssign NotificationKind = "assign"
)

// Notification is a per-account in-app activity entry. It is addressed to a
// single Account (the recipient) and is only ever listed/mutated by that same
// verified account — never cross-account (see NotificationHandler).
type Notification struct {
	ID        string           `json:"id"`
	Account   string           `json:"account"` // recipient account id (owner of this row)
	Kind      NotificationKind `json:"kind"`
	Actor     string           `json:"actor"`             // who triggered it (comment author)
	FileID    string           `json:"file_id,omitempty"` // document context
	FileName  string           `json:"file_name,omitempty"`
	CommentID string           `json:"comment_id,omitempty"`
	Snippet   string           `json:"snippet,omitempty"` // plain-text comment excerpt (escaped on render)
	Read      bool             `json:"read"`
	CreatedAt time.Time        `json:"created_at"`
}

type UpdateCommentRequest struct {
	Body  string       `json:"body"`
	State CommentState `json:"state"`
	// Assignee changes the comment's assignment. A POINTER so the three cases are
	// distinguishable: nil = leave unchanged, "" = explicitly clear, "acct" =
	// (re)assign. The id is validated against the file's collaborators server-side.
	// Note: resolving the thread (State=resolved) always clears the assignee
	// regardless of this field — a resolved task has no open assignee.
	Assignee *string `json:"assignee,omitempty"`
}

type CreateReplyRequest struct {
	AuthorID string   `json:"author_id"`
	Body     string   `json:"body" binding:"required"`
	Mentions []string `json:"mentions,omitempty"`
}

type UpdateReplyRequest struct {
	Body string `json:"body"`
}
