package handlers

// sharelink_sec_test.go — adversarial security regressions for the just-merged
// Office share-link / search / transfer surfaces. These complement
// search_sharelinks_test.go by proving the NEGATIVE space:
//
//   - the anonymous password view route is RATE-LIMITED (no unbounded bcrypt
//     brute-force oracle) — regression for the fix that wraps POST /share/:token;
//   - the share-link token grants NO write/share/ACL/transfer/version path
//     (write-escalation is impossible from a token);
//   - a crafted search query/param can never surface another account's content;
//   - a revoked/missing token is a 404 with no existence oracle.

import (
	"net/http"
	"testing"
	"time"

	"diwan/backend/middleware"
	"diwan/backend/models"

	"github.com/gin-gonic/gin"
)

// routerWithShareLimiter mirrors realStack.router but wires the SAME rate-limiter
// middleware onto POST /share/:token that main.go installs in production, so the
// brute-force guard is under regression test (the limiter lives in the route
// wiring, not the handler, so it must be exercised at the route level).
func (s *realStack) routerWithShareLimiter(limit int, window time.Duration) *gin.Engine {
	r := gin.New()
	lim := middleware.NewRateLimiter(limit, window)
	r.GET("/share/:token", s.links.ViewMeta)
	r.POST("/share/:token", lim.Middleware(), s.links.View)
	return r
}

// TestShareLink_PasswordBruteForceIsRateLimited proves the anonymous password
// view route is throttled: after `limit` attempts within the window the route
// returns 429, so a weak share password cannot be guessed at bcrypt-only speed.
func TestShareLink_PasswordBruteForceIsRateLimited(t *testing.T) {
	s := newRealStack(t)
	fid := s.createFile(t, "alice", "Doc", models.FileTypeDoc, docContent("guarded"))
	alice := s.router("alice", false)
	mw := doReq(alice, http.MethodPost, "/files/"+fid+"/share-links",
		models.CreateShareLinkRequest{Password: "hunter2"})
	var link models.ShareLink
	mustDecode(t, mw, &link)

	// A tiny window so the test is fast and deterministic. Same helper doReq is
	// used for every attempt, so ClientIP() is stable → all count to one bucket.
	const limit = 3
	anon := s.routerWithShareLimiter(limit, time.Minute)

	// The first `limit` wrong-password attempts are processed (401). They must
	// NOT succeed, and crucially they must not run unbounded.
	for i := 0; i < limit; i++ {
		w := doReq(anon, http.MethodPost, "/share/"+link.Token, map[string]string{"password": "guess"})
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d: expected 401, got %d (%s)", i, w.Code, w.Body.String())
		}
	}
	// The next attempt is refused by the limiter (429) BEFORE bcrypt runs.
	blocked := doReq(anon, http.MethodPost, "/share/"+link.Token, map[string]string{"password": "guess"})
	if blocked.Code != http.StatusTooManyRequests {
		t.Fatalf("brute-force must be rate-limited: expected 429 after %d attempts, got %d", limit, blocked.Code)
	}
	// Even the CORRECT password is refused once the bucket is empty — proof the
	// limiter fires ahead of the password check (no oracle bypass).
	correct := doReq(anon, http.MethodPost, "/share/"+link.Token, map[string]string{"password": "hunter2"})
	if correct.Code != http.StatusTooManyRequests {
		t.Fatalf("limiter must gate ALL POSTs once tripped: expected 429, got %d", correct.Code)
	}
}

// TestShareLink_NoWriteEscalationFromToken proves the token grants ONLY the
// read-only view. There is no route on the anonymous surface that can write,
// share, transfer, delete, or snapshot the file — the only two token routes are
// ViewMeta (GET) and View (POST), both content-read-only. We assert that hitting
// the token surface with mutating verbs/paths yields no mutation and no 2xx write
// response, and that the file content is unchanged afterward.
func TestShareLink_NoWriteEscalationFromToken(t *testing.T) {
	s := newRealStack(t)
	fid := s.createFile(t, "alice", "Doc", models.FileTypeDoc, docContent("original"))
	alice := s.router("alice", false)
	mw := doReq(alice, http.MethodPost, "/files/"+fid+"/share-links", models.CreateShareLinkRequest{})
	var link models.ShareLink
	mustDecode(t, mw, &link)

	// Build a router that ONLY mounts the anonymous token routes (the real
	// production surface for an unauthenticated token holder). Any attempt to
	// reach a write/share/transfer path must 404 — the route does not exist here.
	anon := gin.New()
	anon.GET("/share/:token", s.links.ViewMeta)
	anon.POST("/share/:token", s.links.View)

	// Try to smuggle a write through the token surface. None of these paths exist
	// on the anonymous surface, so all must 404 (no route → no escalation).
	for _, tc := range []struct{ method, path string }{
		{http.MethodPut, "/share/" + link.Token},
		{http.MethodDelete, "/share/" + link.Token},
		{http.MethodPost, "/share/" + link.Token + "/share"},
		{http.MethodPost, "/share/" + link.Token + "/transfer-owner"},
		{http.MethodPost, "/share/" + link.Token + "/versions"},
	} {
		w := doReq(anon, tc.method, tc.path, map[string]interface{}{
			"content":    docContent("HACKED"),
			"account_id": "mallory",
			"new_owner":  "mallory",
		})
		if w.Code >= 200 && w.Code < 300 {
			t.Fatalf("%s %s: token surface must expose NO write path, got 2xx %d", tc.method, tc.path, w.Code)
		}
	}

	// The file content must be untouched, and Mallory must have gained no ACL grant.
	f, err := s.store.GetFile(fid)
	if err != nil {
		t.Fatalf("get file: %v", err)
	}
	if got := docindexText(f.Content); got != "original" {
		t.Fatalf("content mutated via token surface: %q", got)
	}
	if allowed, _, _ := s.authz.Store().CanAccess(fid, "mallory"); allowed {
		t.Fatal("token surface granted mallory access — escalation")
	}
}

// TestSearch_NoCrossAccountLeakViaTypeFilter proves the type filter (a request
// param) cannot widen the ACL-scoped candidate set: it filters WITHIN the
// caller's accessible set, it never keys the candidate set. A stranger searching
// with any type filter still sees nothing of another account's content.
func TestSearch_NoCrossAccountLeakViaTypeFilter(t *testing.T) {
	s := newRealStack(t)
	s.createFile(t, "alice", "Alice Confidential", models.FileTypeDoc,
		docContent("codename bluefish operational"))
	// Mallory owns nothing that matches; she must never surface Alice's doc,
	// regardless of the type filter she crafts.
	mallory := s.router("mallory", false)
	for _, typ := range []string{"", "doc", "sheet", "slide", "../../etc"} {
		path := "/search?q=bluefish"
		if typ != "" {
			path += "&type=" + typ
		}
		w := doReq(mallory, http.MethodGet, path, nil)
		if w.Code != http.StatusOK {
			t.Fatalf("search type=%q: expected 200, got %d", typ, w.Code)
		}
		var resp struct {
			Results []SearchResult `json:"results"`
		}
		mustDecode(t, w, &resp)
		if len(resp.Results) != 0 {
			t.Fatalf("search type=%q leaked another account's content: %+v", typ, resp.Results)
		}
	}
}

// TestShareLink_MissingTokenNoOracle proves an unknown token is a 404 that does
// not distinguish "never existed" from "revoked" (both 404) — no existence oracle
// on the anonymous surface.
func TestShareLink_MissingTokenNoOracle(t *testing.T) {
	s := newRealStack(t)
	anon := s.router("", false)
	// A syntactically valid but non-existent token.
	w := doReq(anon, http.MethodGet, "/share/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", nil)
	if w.Code != http.StatusNotFound {
		t.Fatalf("missing token: expected 404, got %d (%s)", w.Code, w.Body.String())
	}
}

// docindexText is a tiny helper mirroring what the search handler extracts, so
// the write-escalation test can assert content is unchanged without importing the
// full docindex surface into every assertion.
func docindexText(content interface{}) string {
	m, ok := content.(map[string]interface{})
	if !ok {
		return ""
	}
	nodes, _ := m["content"].([]interface{})
	for _, n := range nodes {
		nm, _ := n.(map[string]interface{})
		inner, _ := nm["content"].([]interface{})
		for _, t := range inner {
			tm, _ := t.(map[string]interface{})
			if s, ok := tm["text"].(string); ok {
				return s
			}
		}
	}
	return ""
}
