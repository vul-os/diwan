package handlers

import (
	"encoding/base64"
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"diwan/backend/billing"
	"diwan/backend/storage"
	"diwan/backend/updatelog"

	"github.com/gin-gonic/gin"
)

// compactWarnThrottle rate-limits the "un-compacted tail" WARN so a hot document
// that keeps appending above the threshold logs at most once per interval per
// file (the compact HINT is still returned on every over-threshold append; only
// the operator log line is throttled).
var (
	compactWarnMu   sync.Mutex
	compactWarnLast = map[string]time.Time{}
)

const compactWarnInterval = 5 * time.Minute

func shouldWarnCompaction(fileID string) bool {
	compactWarnMu.Lock()
	defer compactWarnMu.Unlock()
	now := time.Now()
	if last, ok := compactWarnLast[fileID]; ok && now.Sub(last) < compactWarnInterval {
		return false
	}
	compactWarnLast[fileID] = now
	return true
}

// Per-frame ceilings. A single incremental update must fit inside the P2P
// fabric's per-frame cap once base64-inflated (see src/lib/crdt/ydoc.js
// MAX_UPDATE_BYTES = 128 KiB); we allow a little headroom on the REST path. A
// snapshot is the whole compacted document and may be larger.
const (
	maxUpdateFrameBytes   = 256 * 1024
	maxSnapshotFrameBytes = 8 * 1024 * 1024
)

// UpdateLogHandler serves the per-file append-only CRDT update log
// (GET/POST /api/files/:id/updates). It reuses the SAME per-file ACL as the
// document store: read access to GET, editor to POST. Identity is the
// server-verified requester, never a client header.
type UpdateLogHandler struct {
	log   updatelog.Store
	store storage.Storage
	authz *FileAuthz
}

// NewUpdateLogHandler wires the handler to an update-log store + the shared
// file authorizer. The document store is used only to confirm a file exists.
func NewUpdateLogHandler(log updatelog.Store, store storage.Storage) *UpdateLogHandler {
	return &UpdateLogHandler{log: log, store: store, authz: SharedFileAuthz()}
}

// NewUpdateLogHandlerWithAuthz builds the handler over a caller-supplied
// authorizer (tests share one FileAuthz across the file + update-log handlers).
func NewUpdateLogHandlerWithAuthz(log updatelog.Store, store storage.Storage, authz *FileAuthz) *UpdateLogHandler {
	return &UpdateLogHandler{log: log, store: store, authz: authz}
}

// List returns the snapshot + frames a caller is missing.
//
// GET /api/files/:id/updates[?since=<seq>]
func (h *UpdateLogHandler) List(c *gin.Context) {
	id := c.Param("id")
	// Read access is required (a denied/absent file returns 404 — no existence leak).
	if !h.authz.require(c, id) {
		return
	}
	var since int64
	if raw := strings.TrimSpace(c.Query("since")); raw != "" {
		n, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || n < 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "since must be a non-negative integer"})
			return
		}
		since = n
	}
	log, err := h.log.Load(id, since)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, log)
}

// Append adds an opaque CRDT frame to a file's log.
//
// POST /api/files/:id/updates { "kind": "update"|"snapshot", "data": "<base64>", "floor": <seq> }
func (h *UpdateLogHandler) Append(c *gin.Context) {
	id := c.Param("id")
	// Only editors/owners may append (viewers/commenters are read-only).
	if !h.authz.requireEditor(c, id) {
		return
	}
	account := requesterID(c)

	// OFFICE ACCESS GATE: a suspended / office-disabled account may not mutate.
	if d := billing.GateOffice(c.Request.Context(), account); !d.Allowed() {
		c.JSON(d.Code, gin.H{"error": d.Reason})
		return
	}

	var req struct {
		Kind  string `json:"kind"`
		Data  string `json:"data" binding:"required"`
		Floor int64  `json:"floor"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	kind := req.Kind
	if kind == "" {
		kind = updatelog.FrameKindUpdate
	}
	if kind != updatelog.FrameKindUpdate && kind != updatelog.FrameKindSnapshot {
		c.JSON(http.StatusBadRequest, gin.H{"error": "kind must be 'update' or 'snapshot'"})
		return
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(req.Data))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "data must be base64"})
		return
	}
	cap := maxUpdateFrameBytes
	if kind == updatelog.FrameKindSnapshot {
		cap = maxSnapshotFrameBytes
	}
	if len(raw) == 0 || len(raw) > cap {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "frame size out of bounds"})
		return
	}

	// STORAGE GATE: update-log frames are durable bytes exactly like a whole-doc
	// PUT, so they must pass the SAME storage quota — otherwise the append path is
	// a quota bypass (a suspended / over-limit account could keep writing frames
	// forever). Atomically check AND reserve the appended bytes BEFORE persisting;
	// commit on success, release if the append fails. Standalone / unlimited →
	// no-op (the seam default), consistent with GateStorage everywhere else.
	d, res := billing.GateStorage(c.Request.Context(), account, int64(len(raw)))
	if !d.Allowed() {
		c.JSON(d.Code, gin.H{"error": d.Reason})
		return
	}

	frame, err := h.log.Append(id, kind, raw, account, req.Floor)
	if err != nil {
		res.Release()
		// A stale snapshot (floor regressed) is a client-reconcilable conflict.
		if strings.Contains(err.Error(), "stale snapshot") {
			c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
			return
		}
		if errors.Is(err, storage.ErrRevConflict) {
			c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	// The frame is durable — promote the reservation to committed usage and emit
	// the storage Usage event through the seam.
	res.Commit(c.Request.Context())

	// SERVER-SIDE COMPACTION SAFETY NET (advisory only). The server CANNOT fold
	// opaque CRDT frames into a snapshot itself — it cannot interpret them, so it
	// can never fabricate the compacted state. What it CAN do is detect that a log
	// has grown a large un-compacted tail (e.g. many short-lived clients each
	// appending a few frames, so no single client ever hits its own snapshotEvery)
	// and NUDGE the appending client to post a snapshot now. Client-driven
	// compaction stays primary; this is a conservative retention signal. Only on
	// update appends (a snapshot just compacted, so there is nothing to advise).
	resp := gin.H{"seq": frame.Seq, "kind": frame.Kind, "floor": frame.Floor}
	if kind == updatelog.FrameKindUpdate {
		if pending, perr := h.log.Pending(id); perr == nil && pending >= updatelog.CompactAdviseThreshold {
			resp["compact"] = true
			if shouldWarnCompaction(id) {
				log.Printf("[persistence] update-log for file=%s has %d un-compacted frames "+
					"(>= %d) — advising client to snapshot", id, pending, updatelog.CompactAdviseThreshold)
			}
		}
	}
	c.JSON(http.StatusOK, resp)
}
