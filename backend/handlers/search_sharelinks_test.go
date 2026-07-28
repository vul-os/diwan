package handlers

// search_sharelinks_test.go — coverage for the "office remaining" parity work:
//   - ACL-scoped global search (isolation + snippet)
//   - per-version author stamping
//   - version diff correctness
//   - expiring / password / read-only share links
//   - transfer-ownership authorization
//
// These use the REAL LocalStorage (temp dir) so the version-author round-trip
// and share-link persistence are exercised end-to-end, with auth ENABLED so the
// multi-tenant isolation posture is under test.

import (
	"net/http"
	"testing"
	"time"

	"diwan/backend/audit"
	"diwan/backend/config"
	"diwan/backend/fileacl"
	"diwan/backend/middleware"
	"diwan/backend/models"
	"diwan/backend/signing"
	"diwan/backend/storage"

	"github.com/gin-gonic/gin"
)

// realStack wires the new handlers over a real LocalStorage + an in-memory ACL
// store with auth ENABLED (multi-tenant isolation under test).
type realStack struct {
	store  storage.Storage
	authz  *FileAuthz
	files  *FileHandler
	vers   *VersionHandler
	search *SearchHandler
	links  *ShareLinkHandler
}

func newRealStack(t *testing.T) *realStack {
	t.Helper()
	gin.SetMode(gin.TestMode)
	cfg := config.Default()
	cfg.Server.DataDir = t.TempDir()
	st, err := storage.NewLocalStorage(cfg)
	if err != nil {
		t.Fatalf("NewLocalStorage: %v", err)
	}
	acl := fileacl.NewNullStore()
	authz := NewFileAuthzWithAuth(acl, true)
	aud := audit.NewNullStore()
	return &realStack{
		store:  st,
		authz:  authz,
		files:  NewFileHandlerWithAudit(st, authz, aud),
		vers:   &VersionHandler{store: st, authz: authz},
		search: NewSearchHandlerWithAuthz(st, authz),
		links:  NewShareLinkHandlerWithDeps(st, authz, aud),
	}
}

// router builds a gin engine with the given verified identity injected and every
// new route mounted. token routes are mounted WITHOUT the identity middleware to
// model the anonymous view path.
func (s *realStack) router(verifiedUser string, admin bool) *gin.Engine {
	r := gin.New()
	auth := func(c *gin.Context) {
		c.Set(middleware.CtxAuthenticated, true)
		c.Set(middleware.CtxUserID, verifiedUser)
		if admin {
			c.Set(middleware.CtxIsAdmin, true)
		}
		c.Next()
	}
	authed := r.Group("/")
	authed.Use(auth)
	authed.POST("/files", s.files.Create)
	authed.GET("/files/:id", s.files.Get)
	authed.PUT("/files/:id", s.files.Update)
	authed.POST("/files/:id/share", s.files.Share)
	authed.POST("/files/:id/transfer-owner", s.files.TransferOwner)
	authed.GET("/files/:id/versions", s.vers.ListVersions)
	authed.GET("/files/:id/versions/:vid/diff", s.vers.Diff)
	authed.GET("/search", s.search.Search)
	authed.GET("/files/:id/share-links", s.links.List)
	authed.POST("/files/:id/share-links", s.links.Create)
	authed.DELETE("/files/:id/share-links/:lid", s.links.Revoke)
	// Anonymous (no auth) token view route.
	r.GET("/share/:token", s.links.ViewMeta)
	r.POST("/share/:token", s.links.View)
	return r
}

func (s *realStack) createFile(t *testing.T, owner, name string, typ models.FileType, content interface{}) string {
	t.Helper()
	r := s.router(owner, false)
	w := doReq(r, http.MethodPost, "/files",
		models.CreateFileRequest{Name: name, Type: typ, Content: content})
	if w.Code != http.StatusCreated {
		t.Fatalf("create file: expected 201, got %d (%s)", w.Code, w.Body.String())
	}
	var f models.File
	mustDecode(t, w, &f)
	return f.ID
}

// docContent builds a minimal TipTap doc with the given paragraphs.
func docContent(paras ...string) interface{} {
	content := []interface{}{}
	for _, p := range paras {
		content = append(content, map[string]interface{}{
			"type":    "paragraph",
			"content": []interface{}{map[string]interface{}{"type": "text", "text": p}},
		})
	}
	return map[string]interface{}{"type": "doc", "content": content}
}

// ─── Search: ACL isolation + snippet ─────────────────────────────────────────

func TestSearch_IsolationAndSnippet(t *testing.T) {
	s := newRealStack(t)
	// Alice owns a doc containing a secret phrase.
	s.createFile(t, "alice", "Alice Secret", models.FileTypeDoc,
		docContent("The launch codes are hidden in the vault."))
	// Bob owns an unrelated doc that ALSO contains the query term.
	s.createFile(t, "bob", "Bob Notes", models.FileTypeDoc,
		docContent("My vault of recipes is enormous."))

	// Alice searches for "vault": she must ONLY get her own doc, never Bob's.
	alice := s.router("alice", false)
	w := doReq(alice, http.MethodGet, "/search?q=vault", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("search: expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	var resp struct {
		Results []SearchResult `json:"results"`
	}
	mustDecode(t, w, &resp)
	if len(resp.Results) != 1 {
		t.Fatalf("alice should see exactly 1 result, got %d: %+v", len(resp.Results), resp.Results)
	}
	if resp.Results[0].Name != "Alice Secret" {
		t.Fatalf("alice got the wrong doc: %+v", resp.Results[0])
	}
	// Snippet must contain the highlighted match and NOT leak Bob's content.
	snip := resp.Results[0].Snippet
	if snip == "" || !contains(snip, "vault") {
		t.Fatalf("expected a snippet around the match, got %q", snip)
	}
	if contains(snip, "recipes") {
		t.Fatalf("snippet leaked another account's content: %q", snip)
	}
}

func TestSearch_SharedFileIsFound(t *testing.T) {
	s := newRealStack(t)
	fid := s.createFile(t, "alice", "Shared Plan", models.FileTypeDoc,
		docContent("Project Zephyr milestones and deadlines."))
	// Alice shares it with Bob as a viewer.
	alice := s.router("alice", false)
	if w := doReq(alice, http.MethodPost, "/files/"+fid+"/share",
		map[string]interface{}{"account_id": "bob", "role": "viewer"}); w.Code != http.StatusOK {
		t.Fatalf("share: expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	// Bob searches and finds it, flagged as shared.
	bob := s.router("bob", false)
	w := doReq(bob, http.MethodGet, "/search?q=zephyr", nil)
	var resp struct {
		Results []SearchResult `json:"results"`
	}
	mustDecode(t, w, &resp)
	if len(resp.Results) != 1 || resp.Results[0].ID != fid {
		t.Fatalf("bob should find the shared doc, got %+v", resp.Results)
	}
	if !resp.Results[0].Shared {
		t.Fatalf("shared flag should be set for bob's view")
	}
	// A stranger (carol) must NOT find it.
	carol := s.router("carol", false)
	w = doReq(carol, http.MethodGet, "/search?q=zephyr", nil)
	mustDecode(t, w, &resp)
	if len(resp.Results) != 0 {
		t.Fatalf("carol must not see the doc: %+v", resp.Results)
	}
}

func TestSearch_EmptyQuery(t *testing.T) {
	s := newRealStack(t)
	s.createFile(t, "alice", "Doc", models.FileTypeDoc, docContent("hello world"))
	alice := s.router("alice", false)
	w := doReq(alice, http.MethodGet, "/search?q=", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("empty search: expected 200, got %d", w.Code)
	}
	var resp struct {
		Results []SearchResult `json:"results"`
	}
	mustDecode(t, w, &resp)
	if len(resp.Results) != 0 {
		t.Fatalf("empty query must return no results, got %d", len(resp.Results))
	}
}

// ─── Per-version author ──────────────────────────────────────────────────────

func TestVersionAuthorIsStamped(t *testing.T) {
	s := newRealStack(t)
	fid := s.createFile(t, "alice", "Doc", models.FileTypeDoc, docContent("v1"))
	// Alice edits (this snapshots v1 with author=alice).
	alice := s.router("alice", false)
	// Read current rev.
	getW := doReq(alice, http.MethodGet, "/files/"+fid, nil)
	var cur models.File
	mustDecode(t, getW, &cur)
	upW := doReq(alice, http.MethodPut, "/files/"+fid,
		models.UpdateFileRequest{Name: "Doc", Content: docContent("v2"), Rev: cur.Rev})
	if upW.Code != http.StatusOK {
		t.Fatalf("update: expected 200, got %d (%s)", upW.Code, upW.Body.String())
	}
	// List versions — the snapshot must carry author=alice.
	lw := doReq(alice, http.MethodGet, "/files/"+fid+"/versions", nil)
	var versions []*models.FileVersion
	mustDecode(t, lw, &versions)
	if len(versions) == 0 {
		t.Fatal("expected at least one snapshot")
	}
	if versions[0].Author != "alice" {
		t.Fatalf("expected snapshot author=alice, got %q", versions[0].Author)
	}
}

// ─── Version diff ────────────────────────────────────────────────────────────

func TestVersionDiff_AgainstCurrent(t *testing.T) {
	s := newRealStack(t)
	fid := s.createFile(t, "alice", "Doc", models.FileTypeDoc, docContent("alpha", "beta"))
	alice := s.router("alice", false)
	getW := doReq(alice, http.MethodGet, "/files/"+fid, nil)
	var cur models.File
	mustDecode(t, getW, &cur)
	// Edit to snapshot the original and change content.
	if w := doReq(alice, http.MethodPut, "/files/"+fid,
		models.UpdateFileRequest{Name: "Doc", Content: docContent("alpha", "beta changed", "gamma"), Rev: cur.Rev}); w.Code != http.StatusOK {
		t.Fatalf("update: %d (%s)", w.Code, w.Body.String())
	}
	lw := doReq(alice, http.MethodGet, "/files/"+fid+"/versions", nil)
	var versions []*models.FileVersion
	mustDecode(t, lw, &versions)
	vid := versions[0].ID // the snapshot of the ORIGINAL content

	dw := doReq(alice, http.MethodGet, "/files/"+fid+"/versions/"+vid+"/diff?against=current", nil)
	if dw.Code != http.StatusOK {
		t.Fatalf("diff: expected 200, got %d (%s)", dw.Code, dw.Body.String())
	}
	var dresp struct {
		Diff struct {
			Kind    string `json:"kind"`
			Added   int    `json:"added"`
			Removed int    `json:"removed"`
		} `json:"diff"`
	}
	mustDecode(t, dw, &dresp)
	if dresp.Diff.Kind != "line" {
		t.Fatalf("doc diff should be line-kind, got %q", dresp.Diff.Kind)
	}
	// old = [alpha, beta]; new(current) = [alpha, beta changed, gamma].
	if dresp.Diff.Added != 2 || dresp.Diff.Removed != 1 {
		t.Fatalf("diff counts wrong: +%d -%d", dresp.Diff.Added, dresp.Diff.Removed)
	}
}

func TestVersionDiff_RequiresAccess(t *testing.T) {
	s := newRealStack(t)
	fid := s.createFile(t, "alice", "Doc", models.FileTypeDoc, docContent("secret"))
	// Bob (no access) must get 404 on the diff route — no existence leak.
	bob := s.router("bob", false)
	w := doReq(bob, http.MethodGet, "/files/"+fid+"/versions/whatever/diff", nil)
	if w.Code != http.StatusNotFound {
		t.Fatalf("diff as non-owner: expected 404, got %d", w.Code)
	}
}

// ─── Share links ─────────────────────────────────────────────────────────────

func TestShareLink_ReadOnlyView(t *testing.T) {
	s := newRealStack(t)
	fid := s.createFile(t, "alice", "Public Doc", models.FileTypeDoc, docContent("open content"))
	alice := s.router("alice", false)
	// Mint a bare (non-expiring, no-password) link.
	mw := doReq(alice, http.MethodPost, "/files/"+fid+"/share-links", models.CreateShareLinkRequest{})
	if mw.Code != http.StatusCreated {
		t.Fatalf("mint: expected 201, got %d (%s)", mw.Code, mw.Body.String())
	}
	var link models.ShareLink
	mustDecode(t, mw, &link)
	if link.Token == "" {
		t.Fatal("mint must return a token")
	}
	if link.PasswordHash != "" {
		t.Fatal("password hash must NEVER be serialized to the client")
	}

	// Anonymous view (no auth) returns content, read-only.
	anon := s.router("", false) // token routes ignore identity anyway
	vw := doReq(anon, http.MethodGet, "/share/"+link.Token, nil)
	if vw.Code != http.StatusOK {
		t.Fatalf("anon view: expected 200, got %d (%s)", vw.Code, vw.Body.String())
	}
	var vresp map[string]interface{}
	mustDecode(t, vw, &vresp)
	if vresp["read_only"] != true {
		t.Fatalf("view must be flagged read_only: %+v", vresp)
	}
	if vresp["content"] == nil {
		t.Fatalf("view must return content for a bare link: %+v", vresp)
	}
}

func TestShareLink_Expired(t *testing.T) {
	s := newRealStack(t)
	fid := s.createFile(t, "alice", "Doc", models.FileTypeDoc, docContent("x"))
	// Mint a link that already expired by writing directly to the store (TTL-in-
	// the-past cannot be requested via the API, so we craft it).
	past := time.Now().Add(-time.Hour)
	tok, _ := signing.GenerateShareLinkToken()
	if err := s.store.CreateShareLink(&models.ShareLink{
		ID: "expired1", FileID: fid, Token: tok, CreatedBy: "alice",
		ExpiresAt: &past, CreatedAt: time.Now().Add(-2 * time.Hour),
	}); err != nil {
		t.Fatalf("seed expired link: %v", err)
	}
	anon := s.router("", false)
	w := doReq(anon, http.MethodGet, "/share/"+tok, nil)
	if w.Code != http.StatusGone {
		t.Fatalf("expired link: expected 410 Gone, got %d (%s)", w.Code, w.Body.String())
	}
}

func TestShareLink_PasswordGate(t *testing.T) {
	s := newRealStack(t)
	fid := s.createFile(t, "alice", "Doc", models.FileTypeDoc, docContent("guarded content"))
	alice := s.router("alice", false)
	mw := doReq(alice, http.MethodPost, "/files/"+fid+"/share-links",
		models.CreateShareLinkRequest{Password: "hunter2"})
	var link models.ShareLink
	mustDecode(t, mw, &link)
	if !link.HasPassword {
		t.Fatal("link should report has_password")
	}
	anon := s.router("", false)

	// Meta must NOT reveal content for a password-gated link.
	meta := doReq(anon, http.MethodGet, "/share/"+link.Token, nil)
	var metaResp map[string]interface{}
	mustDecode(t, meta, &metaResp)
	if metaResp["requires_password"] != true {
		t.Fatalf("meta must require password: %+v", metaResp)
	}
	if metaResp["content"] != nil {
		t.Fatalf("meta must not leak content behind a password: %+v", metaResp)
	}

	// Wrong password → 401, no content.
	bad := doReq(anon, http.MethodPost, "/share/"+link.Token, map[string]string{"password": "wrong"})
	if bad.Code != http.StatusUnauthorized {
		t.Fatalf("wrong password: expected 401, got %d (%s)", bad.Code, bad.Body.String())
	}
	// No password → 401.
	none := doReq(anon, http.MethodPost, "/share/"+link.Token, map[string]string{})
	if none.Code != http.StatusUnauthorized {
		t.Fatalf("missing password: expected 401, got %d", none.Code)
	}
	// Correct password → 200 with content.
	ok := doReq(anon, http.MethodPost, "/share/"+link.Token, map[string]string{"password": "hunter2"})
	if ok.Code != http.StatusOK {
		t.Fatalf("correct password: expected 200, got %d (%s)", ok.Code, ok.Body.String())
	}
	var okResp map[string]interface{}
	mustDecode(t, ok, &okResp)
	if okResp["content"] == nil || okResp["read_only"] != true {
		t.Fatalf("correct password must yield read-only content: %+v", okResp)
	}
}

func TestShareLink_Revoked(t *testing.T) {
	s := newRealStack(t)
	fid := s.createFile(t, "alice", "Doc", models.FileTypeDoc, docContent("x"))
	alice := s.router("alice", false)
	mw := doReq(alice, http.MethodPost, "/files/"+fid+"/share-links", models.CreateShareLinkRequest{})
	var link models.ShareLink
	mustDecode(t, mw, &link)
	// Revoke it.
	if w := doReq(alice, http.MethodDelete, "/files/"+fid+"/share-links/"+link.ID, nil); w.Code != http.StatusOK {
		t.Fatalf("revoke: expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	// The token is now dead → 404.
	anon := s.router("", false)
	if w := doReq(anon, http.MethodGet, "/share/"+link.Token, nil); w.Code != http.StatusNotFound {
		t.Fatalf("revoked link: expected 404, got %d", w.Code)
	}
}

func TestShareLink_MintRequiresOwner(t *testing.T) {
	s := newRealStack(t)
	fid := s.createFile(t, "alice", "Doc", models.FileTypeDoc, docContent("x"))
	// Bob (no access) cannot mint — 404 (no existence leak).
	bob := s.router("bob", false)
	if w := doReq(bob, http.MethodPost, "/files/"+fid+"/share-links", models.CreateShareLinkRequest{}); w.Code != http.StatusNotFound {
		t.Fatalf("non-owner mint: expected 404, got %d", w.Code)
	}
	// Editor-collaborator cannot mint either (owner-only) — 403.
	alice := s.router("alice", false)
	_ = doReq(alice, http.MethodPost, "/files/"+fid+"/share",
		map[string]interface{}{"account_id": "carol", "role": "editor"})
	carol := s.router("carol", false)
	if w := doReq(carol, http.MethodPost, "/files/"+fid+"/share-links", models.CreateShareLinkRequest{}); w.Code != http.StatusForbidden {
		t.Fatalf("editor mint: expected 403, got %d (%s)", w.Code, w.Body.String())
	}
}

// ─── Transfer ownership ──────────────────────────────────────────────────────

func TestTransferOwner_AuthzAndEffect(t *testing.T) {
	s := newRealStack(t)
	fid := s.createFile(t, "alice", "Doc", models.FileTypeDoc, docContent("x"))

	// A non-owner cannot transfer — 404.
	bob := s.router("bob", false)
	if w := doReq(bob, http.MethodPost, "/files/"+fid+"/transfer-owner",
		models.TransferOwnerRequest{NewOwner: "bob"}); w.Code != http.StatusNotFound {
		t.Fatalf("non-owner transfer: expected 404, got %d (%s)", w.Code, w.Body.String())
	}

	// The owner transfers to Bob.
	alice := s.router("alice", false)
	if w := doReq(alice, http.MethodPost, "/files/"+fid+"/transfer-owner",
		models.TransferOwnerRequest{NewOwner: "bob"}); w.Code != http.StatusOK {
		t.Fatalf("owner transfer: expected 200, got %d (%s)", w.Code, w.Body.String())
	}

	// Bob is now the owner (can access + is RoleOwner). Alice retains editor access.
	if role, ok, _ := s.authz.Store().GetRole(fid, "bob"); !ok || role != fileacl.RoleOwner {
		t.Fatalf("bob should be owner, got role=%q ok=%v", role, ok)
	}
	if role, ok, _ := s.authz.Store().GetRole(fid, "alice"); !ok || role != fileacl.RoleEditor {
		t.Fatalf("alice should be demoted to editor, got role=%q ok=%v", role, ok)
	}

	// Alice can no longer transfer (she is no longer the owner) — 403.
	if w := doReq(alice, http.MethodPost, "/files/"+fid+"/transfer-owner",
		models.TransferOwnerRequest{NewOwner: "carol"}); w.Code != http.StatusForbidden {
		t.Fatalf("ex-owner transfer: expected 403, got %d (%s)", w.Code, w.Body.String())
	}
}
