package handlers

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"sync"
	"testing"

	"diwan/backend/billing"
	"diwan/backend/fileacl"
	"diwan/backend/middleware"
	"diwan/backend/seam"
	"diwan/backend/updatelog"

	"github.com/gin-gonic/gin"
)

// newUpdateLogSetup builds a FileHandler and an UpdateLogHandler that SHARE one
// ACL store + authorizer, so ownership recorded by creating a file is honoured
// by the update-log routes.
func newUpdateLogSetup(t *testing.T) (*FileHandler, *UpdateLogHandler) {
	t.Helper()
	st := newMemStorage()
	acl := fileacl.NewNullStore()
	authz := NewFileAuthz(acl)
	fh := NewFileHandlerWithAuthz(st, authz)
	ul, err := updatelog.NewLocalStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewLocalStore: %v", err)
	}
	uh := NewUpdateLogHandlerWithAuthz(ul, st, authz)
	return fh, uh
}

func updatesRouter(fh *FileHandler, uh *UpdateLogHandler, user string) *gin.Engine {
	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Set(middleware.CtxAuthenticated, true)
		c.Set(middleware.CtxUserID, user)
		c.Next()
	})
	r.POST("/files", fh.Create)
	r.GET("/files/:id/updates", uh.List)
	r.POST("/files/:id/updates", uh.Append)
	return r
}

func b64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

func TestUpdateLogAppendAndList(t *testing.T) {
	fh, uh := newUpdateLogSetup(t)
	r := updatesRouter(fh, uh, "alice")
	id := createFileAs(t, fh, "alice")

	// Append two update frames.
	for i, payload := range []string{"u1", "u2"} {
		w := doReq(r, http.MethodPost, "/files/"+id+"/updates", gin.H{"kind": "update", "data": b64([]byte(payload))})
		if w.Code != http.StatusOK {
			t.Fatalf("append %d: expected 200, got %d (%s)", i, w.Code, w.Body.String())
		}
		var resp struct {
			Seq int64 `json:"seq"`
		}
		_ = json.Unmarshal(w.Body.Bytes(), &resp)
		if resp.Seq != int64(i+1) {
			t.Fatalf("append %d: seq = %d, want %d", i, resp.Seq, i+1)
		}
	}

	// Full load returns both frames.
	w := doReq(r, http.MethodGet, "/files/"+id+"/updates", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("list: expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	var log updatelog.Log
	if err := json.Unmarshal(w.Body.Bytes(), &log); err != nil {
		t.Fatalf("decode log: %v", err)
	}
	if log.Head != 2 || len(log.Frames) != 2 {
		t.Fatalf("list: head=%d frames=%d", log.Head, len(log.Frames))
	}
	got, _ := updatelog.DecodeFrame(log.Frames[0])
	if string(got) != "u1" {
		t.Fatalf("frame 0 data = %q, want u1", got)
	}
}

func TestUpdateLogSnapshotCompaction(t *testing.T) {
	fh, uh := newUpdateLogSetup(t)
	r := updatesRouter(fh, uh, "alice")
	id := createFileAs(t, fh, "alice")

	for _, p := range []string{"a", "b", "c"} {
		doReq(r, http.MethodPost, "/files/"+id+"/updates", gin.H{"kind": "update", "data": b64([]byte(p))})
	}
	// Snapshot up to floor 3.
	w := doReq(r, http.MethodPost, "/files/"+id+"/updates", gin.H{"kind": "snapshot", "data": b64([]byte("STATE")), "floor": 3})
	if w.Code != http.StatusOK {
		t.Fatalf("snapshot: expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	w = doReq(r, http.MethodGet, "/files/"+id+"/updates", nil)
	var log updatelog.Log
	_ = json.Unmarshal(w.Body.Bytes(), &log)
	if log.Snapshot == nil {
		t.Fatal("expected a snapshot after compaction")
	}
	if len(log.Frames) != 0 {
		t.Fatalf("expected all frames pruned, got %d", len(log.Frames))
	}
}

// A non-editor (no access) must get 404 on both list and append — no existence leak.
func TestUpdateLogAclEnforced(t *testing.T) {
	fh, uh := newUpdateLogSetup(t)
	alice := updatesRouter(fh, uh, "alice")
	id := createFileAs(t, fh, "alice")

	bob := updatesRouter(fh, uh, "bob")
	if w := doReq(bob, http.MethodGet, "/files/"+id+"/updates", nil); w.Code != http.StatusNotFound {
		t.Fatalf("list as non-owner: expected 404, got %d", w.Code)
	}
	if w := doReq(bob, http.MethodPost, "/files/"+id+"/updates", gin.H{"kind": "update", "data": b64([]byte("x"))}); w.Code != http.StatusNotFound {
		t.Fatalf("append as non-owner: expected 404, got %d", w.Code)
	}
	// Sanity: the owner still can.
	if w := doReq(alice, http.MethodPost, "/files/"+id+"/updates", gin.H{"kind": "update", "data": b64([]byte("ok"))}); w.Code != http.StatusOK {
		t.Fatalf("append as owner: expected 200, got %d (%s)", w.Code, w.Body.String())
	}
}

// --- storage-quota metering on frame appends (phase 2, task 3) ---

type stubEnt struct{ ent seam.Entitlement }

func (s stubEnt) For(context.Context, string) (seam.Entitlement, error) { return s.ent, nil }
func (s stubEnt) Allowed(context.Context, string, string) bool          { return true }

type recUsage struct {
	mu sync.Mutex
	ev []seam.UsageEvent
}

func (r *recUsage) Report(_ context.Context, ev seam.UsageEvent) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.ev = append(r.ev, ev)
}
func (r *recUsage) count() int { r.mu.Lock(); defer r.mu.Unlock(); return len(r.ev) }

func withBilling(t *testing.T, ent seam.Entitlement) *recUsage {
	t.Helper()
	u := &recUsage{}
	billing.Configure(seam.Provider{Entitlements: stubEnt{ent: ent}, Usage: u})
	t.Cleanup(func() {
		billing.Configure(seam.NewStandaloneProvider(func() ([]byte, error) { return nil, nil }, false))
	})
	return u
}

// A frame append is subject to the SAME storage quota as a whole-doc PUT: an
// over-cap append is rejected 402 (no quota bypass), and a successful append
// meters the appended bytes through the Usage seam.
func TestUpdateLogMetersAndGatesStorage(t *testing.T) {
	fh, uh := newUpdateLogSetup(t)
	r := updatesRouter(fh, uh, "alice")
	id := createFileAs(t, fh, "alice")
	// Install the tight cap AFTER creating the file (Configure resets the
	// per-process usage counters). Cap at 4 bytes so the first small frame fits
	// and the second overflows.
	usage := withBilling(t, seam.Entitlement{MaxStorageBytes: 4})

	// 3-byte frame fits under the 4-byte cap → 200, and is metered.
	if w := doReq(r, http.MethodPost, "/files/"+id+"/updates", gin.H{"kind": "update", "data": b64([]byte("abc"))}); w.Code != http.StatusOK {
		t.Fatalf("first append: expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	if usage.count() != 1 {
		t.Fatalf("expected 1 metered storage event, got %d", usage.count())
	}

	// A second frame would push committed+new over the cap → 402 (bypass closed).
	if w := doReq(r, http.MethodPost, "/files/"+id+"/updates", gin.H{"kind": "update", "data": b64([]byte("de"))}); w.Code != http.StatusPaymentRequired {
		t.Fatalf("over-cap append: expected 402, got %d (%s)", w.Code, w.Body.String())
	}
	// The rejected append reserved nothing durable — still exactly one metered event.
	if usage.count() != 1 {
		t.Fatalf("over-cap append must not meter; got %d events", usage.count())
	}
}

// A suspended account cannot append frames (the office gate already blocks it,
// but the storage gate is a second fail-closed guard).
func TestUpdateLogSuspendedBlocked(t *testing.T) {
	fh, uh := newUpdateLogSetup(t)
	r := updatesRouter(fh, uh, "alice")
	id := createFileAs(t, fh, "alice")
	withBilling(t, seam.Entitlement{Suspended: true})
	if w := doReq(r, http.MethodPost, "/files/"+id+"/updates", gin.H{"kind": "update", "data": b64([]byte("x"))}); w.Code == http.StatusOK {
		t.Fatalf("suspended append should be blocked, got 200")
	}
}

// The server advises compaction (compact:true) once the un-compacted frame tail
// crosses CompactAdviseThreshold, and a fresh append below the threshold does
// not. The server never fabricates the snapshot — it only nudges the client.
func TestUpdateLogAdvisesCompaction(t *testing.T) {
	fh, uh := newUpdateLogSetup(t)
	r := updatesRouter(fh, uh, "alice")
	id := createFileAs(t, fh, "alice")

	// Drive the nudge at a low threshold so the test does not append hundreds of
	// frames (LocalStore append is O(frames) per call).
	orig := updatelog.CompactAdviseThreshold
	updatelog.CompactAdviseThreshold = 5
	t.Cleanup(func() { updatelog.CompactAdviseThreshold = orig })

	compactAt := func(body string) bool {
		w := doReq(r, http.MethodPost, "/files/"+id+"/updates", gin.H{"kind": "update", "data": b64([]byte(body))})
		if w.Code != http.StatusOK {
			t.Fatalf("append: expected 200, got %d (%s)", w.Code, w.Body.String())
		}
		var resp struct {
			Compact bool `json:"compact"`
		}
		_ = json.Unmarshal(w.Body.Bytes(), &resp)
		return resp.Compact
	}

	// Below the threshold: no advice.
	if compactAt("x") {
		t.Fatal("did not expect compaction advice on the first append")
	}
	// Drive the tail up to the threshold; the append that reaches it must advise.
	var advised bool
	for i := int64(1); i < updatelog.CompactAdviseThreshold+2; i++ {
		if compactAt("y") {
			advised = true
			break
		}
	}
	if !advised {
		t.Fatalf("expected compaction advice once the tail reached %d frames", updatelog.CompactAdviseThreshold)
	}
}

func TestUpdateLogRejectsBadInput(t *testing.T) {
	fh, uh := newUpdateLogSetup(t)
	r := updatesRouter(fh, uh, "alice")
	id := createFileAs(t, fh, "alice")

	// Non-base64 data.
	if w := doReq(r, http.MethodPost, "/files/"+id+"/updates", gin.H{"kind": "update", "data": "!!!not base64!!!"}); w.Code != http.StatusBadRequest {
		t.Fatalf("bad base64: expected 400, got %d", w.Code)
	}
	// Unknown kind.
	if w := doReq(r, http.MethodPost, "/files/"+id+"/updates", gin.H{"kind": "bogus", "data": b64([]byte("x"))}); w.Code != http.StatusBadRequest {
		t.Fatalf("bad kind: expected 400, got %d", w.Code)
	}
}
