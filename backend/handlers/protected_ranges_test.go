package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"diwan/backend/fileacl"
	"diwan/backend/middleware"
	"diwan/backend/models"

	"github.com/gin-gonic/gin"
)

// sheetWith builds a one-sheet workbook content with cell A1 and B2 set to the
// given values, plus an optional protected-range list on the first sheet — the
// exact JSON shape the server parses in enforceProtectedRanges.
func sheetWith(a1, b2 string, ranges []map[string]interface{}) []map[string]interface{} {
	cell := func(r, c int, v string) map[string]interface{} {
		return map[string]interface{}{"r": r, "c": c, "v": map[string]interface{}{"v": v, "m": v}}
	}
	sheet := map[string]interface{}{
		"name":     "Sheet1",
		"celldata": []map[string]interface{}{cell(0, 0, a1), cell(1, 1, b2)},
	}
	if ranges != nil {
		sheet["protectedRanges"] = ranges
	}
	return []map[string]interface{}{sheet}
}

// restrictedRange covers B2 (row 1, col 1) and permits only `editors`.
func restrictedRange(editors ...string) []map[string]interface{} {
	return []map[string]interface{}{{
		"id":          "pr1",
		"sheetIndex":  0,
		"range":       map[string]interface{}{"startRow": 1, "startCol": 1, "endRow": 1, "endCol": 1},
		"warningOnly": false,
		"editors":     editors,
	}}
}

// newProtHandler builds a FileHandler in MULTI-TENANT posture (authEnabled) so the
// protected-range enforcement is live, plus a helper to seed an owned sheet.
func newProtHandler() (*FileHandler, fileacl.Store) {
	st := newMemStorage()
	acl := fileacl.NewNullStore()
	h := NewFileHandlerWithAuthz(st, NewFileAuthzWithAuth(acl, true))
	return h, acl
}

// createSheetAs creates a sheet file owned by `owner` with the given content.
func createSheetAs(t *testing.T, h *FileHandler, owner string, content interface{}) string {
	t.Helper()
	r := fileRouter(h, owner, false)
	w := doReq(r, http.MethodPost, "/files", models.CreateFileRequest{Name: "book", Type: models.FileTypeSheet, Content: content})
	if w.Code != http.StatusCreated {
		t.Fatalf("create sheet as %s: expected 201, got %d (%s)", owner, w.Code, w.Body.String())
	}
	var f models.File
	if err := json.Unmarshal(w.Body.Bytes(), &f); err != nil {
		t.Fatalf("decode created file: %v", err)
	}
	return f.ID
}

func shareEditor(t *testing.T, h *FileHandler, owner, id, grantee string) {
	t.Helper()
	r := fileRouter(h, owner, false)
	w := doReq(r, http.MethodPost, "/files/"+id+"/share", map[string]interface{}{"account_id": grantee, "role": "editor"})
	if w.Code != http.StatusOK {
		t.Fatalf("share editor to %s: expected 200, got %d (%s)", grantee, w.Code, w.Body.String())
	}
}

// TestProtectedRange_RestrictedWriteRefusedServerSide is the core proof: a full
// file EDITOR who is NOT a range editor cannot change a cell inside a restricted
// range — the server refuses it (403), fail-closed.
func TestProtectedRange_RestrictedWriteRefusedServerSide(t *testing.T) {
	h, _ := newProtHandler()
	// alice owns; B2 is protected, only carol may edit it.
	id := createSheetAs(t, h, "alice", sheetWith("hi", "locked", restrictedRange("carol")))
	shareEditor(t, h, "alice", id, "bob")   // bob is a full file editor…
	shareEditor(t, h, "alice", id, "carol") // …carol too, and a range editor

	bob := fileRouter(h, "bob", false)

	// (1) bob edits the protected cell B2 (protection kept intact) → REFUSED.
	w := doReq(bob, http.MethodPut, "/files/"+id, models.UpdateFileRequest{
		Content: sheetWith("hi", "HACKED", restrictedRange("carol")),
	})
	if w.Code != http.StatusForbidden {
		t.Fatalf("bob editing protected cell: expected 403, got %d (%s)", w.Code, w.Body.String())
	}

	// (2) bob edits an UNPROTECTED cell A1, leaving B2 + protection unchanged → OK.
	w = doReq(bob, http.MethodPut, "/files/"+id, models.UpdateFileRequest{
		Content: sheetWith("bob-was-here", "locked", restrictedRange("carol")),
	})
	if w.Code != http.StatusOK {
		t.Fatalf("bob editing unprotected cell: expected 200, got %d (%s)", w.Code, w.Body.String())
	}

	// (3) bob tries to STRIP the protection (unprotect-then-edit) → REFUSED even
	// though he is a file editor.
	w = doReq(bob, http.MethodPut, "/files/"+id, models.UpdateFileRequest{
		Content: sheetWith("bob-was-here", "HACKED", nil),
	})
	if w.Code != http.StatusForbidden {
		t.Fatalf("bob stripping protection: expected 403, got %d (%s)", w.Code, w.Body.String())
	}

	// (4) carol (a range editor) edits B2 → ALLOWED.
	carol := fileRouter(h, "carol", false)
	w = doReq(carol, http.MethodPut, "/files/"+id, models.UpdateFileRequest{
		Content: sheetWith("bob-was-here", "carol-edit", restrictedRange("carol")),
	})
	if w.Code != http.StatusOK {
		t.Fatalf("carol (range editor) editing protected cell: expected 200, got %d (%s)", w.Code, w.Body.String())
	}

	// (5) alice (owner) may always edit the protected cell.
	alice := fileRouter(h, "alice", false)
	w = doReq(alice, http.MethodPut, "/files/"+id, models.UpdateFileRequest{
		Content: sheetWith("bob-was-here", "owner-edit", restrictedRange("carol")),
	})
	if w.Code != http.StatusOK {
		t.Fatalf("owner editing protected cell: expected 200, got %d (%s)", w.Code, w.Body.String())
	}
}

// TestProtectedRange_WarningOnlyNotBlockedServerSide proves a warningOnly range is
// advisory: the server does NOT block a non-range-editor's write (the client warns).
func TestProtectedRange_WarningOnlyNotBlockedServerSide(t *testing.T) {
	h, _ := newProtHandler()
	warn := []map[string]interface{}{{
		"id": "pr1", "sheetIndex": 0,
		"range":       map[string]interface{}{"startRow": 1, "startCol": 1, "endRow": 1, "endCol": 1},
		"warningOnly": true, "editors": []string{},
	}}
	id := createSheetAs(t, h, "alice", sheetWith("hi", "soft", warn))
	shareEditor(t, h, "alice", id, "bob")

	bob := fileRouter(h, "bob", false)
	w := doReq(bob, http.MethodPut, "/files/"+id, models.UpdateFileRequest{
		Content: sheetWith("hi", "bob-edited", warn),
	})
	if w.Code != http.StatusOK {
		t.Fatalf("bob editing warning-only cell: expected 200 (advisory), got %d (%s)", w.Code, w.Body.String())
	}
}

// TestProtectedRange_AuthDisabledShortCircuits proves the enforcement is a no-op
// in local/OSS (auth-disabled) mode — there are no server identities to
// distinguish, so protection is purely the client-side warn affordance. Exercised
// directly on the helper because the HTTP ACL gate would independently deny a
// non-owner regardless of protection.
func TestProtectedRange_AuthDisabledShortCircuits(t *testing.T) {
	acl := fileacl.NewNullStore()
	_ = acl.SetOwner("f1", "alice")
	authz := NewFileAuthz(acl) // authEnabled == false

	gin.SetMode(gin.TestMode)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Set(middleware.CtxUserID, "bob") // not the owner, not a range editor

	old := sheetWith("hi", "locked", restrictedRange("carol"))
	next := sheetWith("hi", "HACKED", nil) // strips protection AND edits B2
	if ok, _, _ := authz.enforceProtectedRanges(c, "f1", old, next); !ok {
		t.Fatal("auth-disabled: enforcement must short-circuit to allow (ok=true)")
	}
}
