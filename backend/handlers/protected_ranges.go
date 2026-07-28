package handlers

// protected_ranges.go — SERVER-SIDE, FAIL-CLOSED enforcement of Sheets
// "protected ranges" (Google-parity: identity-based warn/restrict, NO passwords,
// NO Excel-style encryption).
//
// MODEL. A protected range is app metadata carried inside the spreadsheet content
// (like charts / pivots / named ranges). Each entry names a rectangle on a sheet
// and a policy:
//
//	{ id, sheetIndex, range:{startRow,startCol,endRow,endCol}, warningOnly, editors:[account…] }
//
//   - warningOnly=true  → advisory: the CLIENT warns before an edit; the server
//     does not block it (Google's "show a warning" protection).
//   - warningOnly=false → RESTRICTED: only the file owner OR an account listed in
//     `editors` may change any cell inside the rectangle. Everyone else — even a
//     full file EDITOR — is refused. This is the enforcement that MUST live on the
//     server, because a client check is trivially bypassed.
//
// WHY SERVER-SIDE + WHY OFF THE OLD CONTENT. The protection definition lives in the
// document, so a naive client could simply strip the protection and then write the
// cell. We defeat that by enforcing every write against the PREVIOUSLY STORED
// content's protection (the authoritative copy the server already holds), not
// against whatever the incoming request claims. A write is refused when EITHER:
//   - it changes a cell inside a restricted range the requester may not edit, OR
//   - it removes/weakens a restricted range the requester may not edit (so
//     "unprotect then edit", even across two requests, is blocked at step one).
//
// POSTURE. Enforcement only runs in multi-tenant mode (auth enabled) — in
// single-user/local mode there are no identities to distinguish, so protection is
// purely the client-side warn affordance. Non-sheet documents are ignored.
// Fail-closed: a range the requester cannot prove they may edit denies the write.

import (
	"encoding/json"
	"net/http"

	"diwan/backend/middleware"

	"github.com/gin-gonic/gin"
)

// protectedRect is the 0-based, inclusive cell rectangle a protection covers.
type protectedRect struct {
	StartRow int `json:"startRow"`
	StartCol int `json:"startCol"`
	EndRow   int `json:"endRow"`
	EndCol   int `json:"endCol"`
}

func (r protectedRect) contains(row, col int) bool {
	lowR, hiR := r.StartRow, r.EndRow
	if lowR > hiR {
		lowR, hiR = hiR, lowR
	}
	lowC, hiC := r.StartCol, r.EndCol
	if lowC > hiC {
		lowC, hiC = hiC, lowC
	}
	return row >= lowR && row <= hiR && col >= lowC && col <= hiC
}

// protectedRange is one protection entry. editors are the extra accounts (besides
// the owner) permitted to edit a restricted range and to modify the protection.
type protectedRange struct {
	ID          string        `json:"id"`
	SheetIndex  int           `json:"sheetIndex"`
	Range       protectedRect `json:"range"`
	WarningOnly bool          `json:"warningOnly"`
	Editors     []string      `json:"editors"`
}

// rawSheet is the minimal view of a Fortune-Sheet sheet the enforcement needs:
// the cells and (on the first sheet in practice, but tolerated anywhere) the
// protected-range list. Everything else in the content is ignored.
type rawSheet struct {
	Celldata        []rawCell        `json:"celldata"`
	ProtectedRanges []protectedRange `json:"protectedRanges"`
}

type rawCell struct {
	R int             `json:"r"`
	C int             `json:"c"`
	V json.RawMessage `json:"v"`
}

// parseSheets marshals the opaque content back to JSON and decodes the sheet
// array. Returns nil (→ no protected ranges, no enforcement) for any content that
// is not a sheet array, so a doc/slide or a malformed body simply isn't gated
// here (those paths have their own authz).
func parseSheets(content interface{}) []rawSheet {
	if content == nil {
		return nil
	}
	b, err := json.Marshal(content)
	if err != nil {
		return nil
	}
	var sheets []rawSheet
	if err := json.Unmarshal(b, &sheets); err != nil {
		return nil
	}
	return sheets
}

// collectProtected gathers every protected range across all sheets, de-duplicated
// by id (last-writer wins). Ranges live on the first sheet in practice; scanning
// every sheet is defensive.
func collectProtected(sheets []rawSheet) map[string]protectedRange {
	out := map[string]protectedRange{}
	for _, sh := range sheets {
		for _, pr := range sh.ProtectedRanges {
			if pr.ID == "" {
				continue
			}
			out[pr.ID] = pr
		}
	}
	return out
}

// cellSig returns a canonical signature of a cell value so a change can be
// detected regardless of JSON key ordering. Re-marshaling through interface{}
// sorts map keys deterministically (Go stdlib), so two semantically-equal values
// compare equal even if the client reordered fields.
func cellSig(v json.RawMessage) string {
	if len(v) == 0 {
		return ""
	}
	var any interface{}
	if err := json.Unmarshal(v, &any); err != nil {
		return string(v) // opaque but stable — compare the raw bytes
	}
	b, err := json.Marshal(any)
	if err != nil {
		return string(v)
	}
	return string(b)
}

// cellMaps builds, per sheet index, a map of "row,col" → value signature.
func cellMaps(sheets []rawSheet) map[int]map[[2]int]string {
	out := map[int]map[[2]int]string{}
	for i, sh := range sheets {
		m := make(map[[2]int]string, len(sh.Celldata))
		for _, cell := range sh.Celldata {
			m[[2]int{cell.R, cell.C}] = cellSig(cell.V)
		}
		out[i] = m
	}
	return out
}

func sameEditorSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	seen := make(map[string]int, len(a))
	for _, x := range a {
		seen[x]++
	}
	for _, x := range b {
		seen[x]--
		if seen[x] < 0 {
			return false
		}
	}
	return true
}

// mayEditRange reports whether requester may edit a restricted range: the file
// owner, an admin, or an account listed in the range's editors. A warningOnly
// range is never restricted here (the caller filters those out).
func mayEditRange(pr protectedRange, requester, owner string, isAdmin bool) bool {
	if isAdmin {
		return true
	}
	if owner != "" && requester == owner {
		return true
	}
	for _, e := range pr.Editors {
		if e == requester {
			return true
		}
	}
	return false
}

// enforceProtectedRanges is the fail-closed gate. It returns ok=true when the
// write may proceed; otherwise ok=false with an HTTP status + reason the caller
// writes to the response.
//
// It is a no-op (ok=true) in single-user mode, for non-sheet content, and when the
// previously stored content declared no RESTRICTED ranges — so the ordinary write
// path pays only a cheap parse and does the full diff only when protection exists.
func (a *FileAuthz) enforceProtectedRanges(c *gin.Context, fileID string, oldContent, newContent interface{}) (bool, int, string) {
	// Only meaningful with distinct identities. In local/OSS mode there is one
	// effective user, so protection is the client-side warn affordance only.
	if a == nil || !a.authEnabled {
		return true, 0, ""
	}

	oldSheets := parseSheets(oldContent)
	if len(oldSheets) == 0 {
		return true, 0, "" // not a sheet (or empty) — nothing to enforce
	}
	oldProtected := collectProtected(oldSheets)
	if len(oldProtected) == 0 {
		return true, 0, ""
	}

	// Resolve the caller + owner once.
	requester := requesterID(c)
	isAdmin := c.GetBool(middleware.CtxIsAdmin)
	owner := ""
	if rec, ok, err := a.acl.Get(fileID); err == nil && ok {
		owner = rec.Owner
	}

	newSheets := parseSheets(newContent)
	newProtected := collectProtected(newSheets)

	oldCells := cellMaps(oldSheets)
	newCells := cellMaps(newSheets)

	for id, pr := range oldProtected {
		if pr.WarningOnly {
			continue // advisory only — the client warns; the server does not block
		}
		if mayEditRange(pr, requester, owner, isAdmin) {
			continue // this caller is allowed to edit the range and its protection
		}

		// (1) The protection itself must survive UNCHANGED. Removing or weakening a
		// restricted range you cannot edit is itself a forbidden write — otherwise
		// "unprotect then edit" would slip through.
		np, ok := newProtected[id]
		if !ok || np.WarningOnly || np.SheetIndex != pr.SheetIndex ||
			np.Range != pr.Range || !sameEditorSet(np.Editors, pr.Editors) {
			return false, http.StatusForbidden, "this range is protected — you may not change or remove its protection"
		}

		// (2) No cell inside the rectangle may change. Walk the UNION of cells
		// present before/after on that sheet (bounded by cell count, not by the
		// rectangle's area, so a whole-column protection is cheap).
		si := pr.SheetIndex
		before := oldCells[si]
		after := newCells[si]
		seen := map[[2]int]bool{}
		check := func(key [2]int) bool {
			if seen[key] {
				return true
			}
			seen[key] = true
			if !pr.Range.contains(key[0], key[1]) {
				return true
			}
			if before[key] != after[key] {
				return false // a protected cell changed (edited/added/cleared)
			}
			return true
		}
		for key := range before {
			if !check(key) {
				return false, http.StatusForbidden, "this range is protected — your edits to it were refused"
			}
		}
		for key := range after {
			if !check(key) {
				return false, http.StatusForbidden, "this range is protected — your edits to it were refused"
			}
		}
	}
	return true, 0, ""
}
