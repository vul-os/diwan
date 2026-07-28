package handlers

import (
	"encoding/json"
	"net/http"
	"testing"

	"diwan/backend/models"
)

// P2 — optimistic concurrency (lost-update prevention).
//
// The autosave PUT carries the rev the client last read. The store does a
// compare-and-swap on rev; a stale PUT is a 409 Conflict (not a silent clobber),
// and the response carries the CURRENT file so the client can reload + retry.

// getFileAs GETs a file and returns its decoded model (for the rev).
func getFileAs(t *testing.T, h *FileHandler, owner, id string) models.File {
	t.Helper()
	r := fileRouter(h, owner, false)
	w := doReq(r, http.MethodGet, "/files/"+id, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("get file: expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	var f models.File
	if err := json.Unmarshal(w.Body.Bytes(), &f); err != nil {
		t.Fatalf("decode file: %v", err)
	}
	return f
}

// TestRevAdvancesOnEachSave proves the rev increments on every committed write
// and GET reflects it.
func TestRevAdvancesOnEachSave(t *testing.T) {
	h, _, _ := newAuthzFileHandler()
	id := createFileAs(t, h, "alice")

	f0 := getFileAs(t, h, "alice", id)
	if f0.Rev != 1 {
		t.Fatalf("created file rev: expected 1, got %d", f0.Rev)
	}

	// Sequential save with the matching rev → 200, rev advances to 2.
	r := fileRouter(h, "alice", false)
	w := doReq(r, http.MethodPut, "/files/"+id, models.UpdateFileRequest{Name: "doc", Content: "v2", Rev: f0.Rev})
	if w.Code != http.StatusOK {
		t.Fatalf("sequential save: expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	var f1 models.File
	_ = json.Unmarshal(w.Body.Bytes(), &f1)
	if f1.Rev != 2 {
		t.Fatalf("rev after first save: expected 2, got %d", f1.Rev)
	}

	// Another sequential save with the NEW rev → 200, rev 3.
	w = doReq(r, http.MethodPut, "/files/"+id, models.UpdateFileRequest{Name: "doc", Content: "v3", Rev: f1.Rev})
	if w.Code != http.StatusOK {
		t.Fatalf("second sequential save: expected 200, got %d", w.Code)
	}
	f2 := getFileAs(t, h, "alice", id)
	if f2.Rev != 3 || f2.Content != "v3" {
		t.Fatalf("after second save: expected rev 3 content v3, got rev %d content %v", f2.Rev, f2.Content)
	}
}

// TestStalePutGets409WithCurrent proves two concurrent editors reading the SAME
// rev cannot both win: the first PUT succeeds, the SECOND (stale rev) gets 409
// Conflict carrying the current file — never a silent lost update.
func TestStalePutGets409WithCurrent(t *testing.T) {
	h, _, _ := newAuthzFileHandler()
	id := createFileAs(t, h, "alice")

	// Both editors read rev 1.
	base := getFileAs(t, h, "alice", id)
	if base.Rev != 1 {
		t.Fatalf("base rev: expected 1, got %d", base.Rev)
	}

	r := fileRouter(h, "alice", false)

	// Editor 1 saves against rev 1 → wins (rev → 2).
	w1 := doReq(r, http.MethodPut, "/files/"+id, models.UpdateFileRequest{Name: "doc", Content: "editor1", Rev: base.Rev})
	if w1.Code != http.StatusOK {
		t.Fatalf("editor1 save: expected 200, got %d (%s)", w1.Code, w1.Body.String())
	}

	// Editor 2 ALSO saves against the now-stale rev 1 → 409 Conflict.
	w2 := doReq(r, http.MethodPut, "/files/"+id, models.UpdateFileRequest{Name: "doc", Content: "editor2", Rev: base.Rev})
	if w2.Code != http.StatusConflict {
		t.Fatalf("stale save: expected 409, got %d (%s)", w2.Code, w2.Body.String())
	}
	// The 409 body carries the CURRENT file so the client can reconcile.
	var body struct {
		Error   string       `json:"error"`
		Current *models.File `json:"current"`
	}
	if err := json.Unmarshal(w2.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode 409 body: %v", err)
	}
	if body.Current == nil {
		t.Fatalf("409 body missing `current` file for reconcile")
	}
	if body.Current.Rev != 2 || body.Current.Content != "editor1" {
		t.Fatalf("409 current: expected rev 2 content editor1, got rev %d content %v", body.Current.Rev, body.Current.Content)
	}

	// Editor 2 reconciles: re-PUT against the returned newer rev → succeeds.
	w3 := doReq(r, http.MethodPut, "/files/"+id, models.UpdateFileRequest{Name: "doc", Content: "editor2", Rev: body.Current.Rev})
	if w3.Code != http.StatusOK {
		t.Fatalf("reconcile save: expected 200, got %d (%s)", w3.Code, w3.Body.String())
	}
	final := getFileAs(t, h, "alice", id)
	if final.Rev != 3 || final.Content != "editor2" {
		t.Fatalf("after reconcile: expected rev 3 content editor2, got rev %d content %v", final.Rev, final.Content)
	}
}

// TestUnconditionalPutStillWorks proves a rev-0 (legacy) PUT is unconditional —
// existing clients that don't send a rev keep working (first-writer-wins fallback).
func TestUnconditionalPutStillWorks(t *testing.T) {
	h, _, _ := newAuthzFileHandler()
	id := createFileAs(t, h, "alice")

	r := fileRouter(h, "alice", false)
	// No Rev field → unconditional overwrite, still advances rev.
	w := doReq(r, http.MethodPut, "/files/"+id, models.UpdateFileRequest{Name: "doc", Content: "legacy"})
	if w.Code != http.StatusOK {
		t.Fatalf("legacy unconditional save: expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	f := getFileAs(t, h, "alice", id)
	if f.Rev != 2 || f.Content != "legacy" {
		t.Fatalf("after legacy save: expected rev 2 content legacy, got rev %d content %v", f.Rev, f.Content)
	}
}
