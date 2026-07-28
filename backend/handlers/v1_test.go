package handlers

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"diwan/backend/audit"
	"diwan/backend/directory"
	"diwan/backend/fileacl"
	"diwan/backend/middleware"

	"github.com/gin-gonic/gin"
)

// fakeResolver is an in-memory directory.Resolver for share-by-email tests.
type fakeResolver struct {
	byEmail map[string]directory.DiscoveryResult
	err     error
}

func (f *fakeResolver) LookupEmail(_ context.Context, email string) (directory.DiscoveryResult, error) {
	if f.err != nil {
		return directory.DiscoveryResult{}, f.err
	}
	if r, ok := f.byEmail[strings.ToLower(strings.TrimSpace(email))]; ok {
		return r, nil
	}
	return directory.DiscoveryResult{}, directory.ErrNotFound
}

// decodeJSON unmarshals a JSON response body into v, failing the test on error.
func decodeJSON(t *testing.T, data []byte, v interface{}) {
	t.Helper()
	if err := json.Unmarshal(data, v); err != nil {
		t.Fatalf("decode JSON: %v (body: %s)", err, string(data))
	}
}

// v1Router mounts the /v1 document routes with a verified identity injected
// (mirrors fileRouter from files_authz_test.go).
func v1Router(h *V1Handler, user string, admin bool) *gin.Engine {
	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Set(middleware.CtxAuthenticated, true)
		c.Set(middleware.CtxUserID, user)
		if admin {
			c.Set(middleware.CtxIsAdmin, true)
		}
		c.Next()
	})
	r.GET("/v1/documents", h.ListDocuments)
	r.GET("/v1/documents/:id", h.GetDocument)
	r.POST("/v1/documents", h.CreateDocument)
	r.PATCH("/v1/documents/:id", h.PatchDocument)
	r.DELETE("/v1/documents/:id", h.DeleteDocument)
	r.GET("/v1/documents/:id/content", h.GetContent)
	r.POST("/v1/documents/:id/export", h.ExportDocument)
	r.GET("/v1/documents/:id/collaborators", h.ListCollaborators)
	r.POST("/v1/documents/:id/collaborators", h.ShareDocument)
	return r
}

func newV1Handler() (*V1Handler, *memStorage) {
	st := newMemStorage()
	acl := fileacl.NewNullStore()
	h := NewV1HandlerWithDeps(st, NewFileAuthz(acl), audit.NewNullStore())
	return h, st
}

// createV1DocAs creates a document via POST /v1/documents owned by user and
// returns its id.
func createV1DocAs(t *testing.T, h *V1Handler, user, typ string, content interface{}) string {
	t.Helper()
	r := v1Router(h, user, false)
	w := doReq(r, http.MethodPost, "/v1/documents", map[string]interface{}{
		"name": "My Doc", "type": typ, "content": content,
	})
	if w.Code != http.StatusCreated {
		t.Fatalf("create: expected 201, got %d (%s)", w.Code, w.Body.String())
	}
	var d v1Document
	decodeJSON(t, w.Body.Bytes(), &d)
	return d.ID
}

func TestV1_CreateAndGet(t *testing.T) {
	h, _ := newV1Handler()
	id := createV1DocAs(t, h, "alice", "doc", "hello")

	alice := v1Router(h, "alice", false)
	w := doReq(alice, http.MethodGet, "/v1/documents/"+id, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("get: expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	var d v1Document
	decodeJSON(t, w.Body.Bytes(), &d)
	if d.Type != "doc" || d.Name != "My Doc" {
		t.Fatalf("unexpected metadata: %+v", d)
	}
}

func TestV1_NonOwnerGets404(t *testing.T) {
	h, _ := newV1Handler()
	id := createV1DocAs(t, h, "alice", "doc", "secret")

	bob := v1Router(h, "bob", false)
	if w := doReq(bob, http.MethodGet, "/v1/documents/"+id, nil); w.Code != http.StatusNotFound {
		t.Fatalf("non-owner get: expected 404, got %d", w.Code)
	}
	if w := doReq(bob, http.MethodPatch, "/v1/documents/"+id, map[string]string{"name": "x"}); w.Code != http.StatusNotFound {
		t.Fatalf("non-owner patch: expected 404, got %d", w.Code)
	}
	if w := doReq(bob, http.MethodDelete, "/v1/documents/"+id, nil); w.Code != http.StatusNotFound {
		t.Fatalf("non-owner delete: expected 404, got %d", w.Code)
	}
}

func TestV1_ListFiltersByTypeAndOwner(t *testing.T) {
	h, _ := newV1Handler()
	docID := createV1DocAs(t, h, "alice", "doc", "a")
	createV1DocAs(t, h, "alice", "sheet", map[string]interface{}{})
	createV1DocAs(t, h, "bob", "doc", "b")

	alice := v1Router(h, "alice", false)
	w := doReq(alice, http.MethodGet, "/v1/documents?type=doc", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("list: %d", w.Code)
	}
	var resp struct {
		Documents []v1Document `json:"documents"`
	}
	decodeJSON(t, w.Body.Bytes(), &resp)
	if len(resp.Documents) != 1 || resp.Documents[0].ID != docID {
		t.Fatalf("expected only alice's doc, got %+v", resp.Documents)
	}
}

func TestV1_PatchRenames(t *testing.T) {
	h, _ := newV1Handler()
	id := createV1DocAs(t, h, "alice", "doc", "a")

	alice := v1Router(h, "alice", false)
	w := doReq(alice, http.MethodPatch, "/v1/documents/"+id, map[string]string{"name": "Renamed"})
	if w.Code != http.StatusOK {
		t.Fatalf("patch: expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	var d v1Document
	decodeJSON(t, w.Body.Bytes(), &d)
	if d.Name != "Renamed" {
		t.Fatalf("expected rename, got %q", d.Name)
	}
}

func TestV1_DeleteRemoves(t *testing.T) {
	h, _ := newV1Handler()
	id := createV1DocAs(t, h, "alice", "doc", "a")

	alice := v1Router(h, "alice", false)
	if w := doReq(alice, http.MethodDelete, "/v1/documents/"+id, nil); w.Code != http.StatusOK {
		t.Fatalf("delete: expected 200, got %d", w.Code)
	}
	if w := doReq(alice, http.MethodGet, "/v1/documents/"+id, nil); w.Code != http.StatusNotFound {
		t.Fatalf("get after delete: expected 404, got %d", w.Code)
	}
}

func TestV1_ContentJSON(t *testing.T) {
	h, _ := newV1Handler()
	id := createV1DocAs(t, h, "alice", "doc", "hello world")

	alice := v1Router(h, "alice", false)
	w := doReq(alice, http.MethodGet, "/v1/documents/"+id+"/content", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("content: expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	var body struct {
		ID      string `json:"id"`
		Type    string `json:"type"`
		Content string `json:"content"`
	}
	decodeJSON(t, w.Body.Bytes(), &body)
	if body.Content != "hello world" {
		t.Fatalf("unexpected content: %+v", body)
	}
}

func TestV1_ExportDocPDF(t *testing.T) {
	h, _ := newV1Handler()
	id := createV1DocAs(t, h, "alice", "doc", "some text")

	alice := v1Router(h, "alice", false)
	// GET content?format=pdf
	w := doReq(alice, http.MethodGet, "/v1/documents/"+id+"/content?format=pdf", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("content pdf: expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/pdf" {
		t.Fatalf("expected application/pdf, got %q", ct)
	}
	// POST export {format: docx}
	w = doReq(alice, http.MethodPost, "/v1/documents/"+id+"/export", map[string]string{"format": "docx"})
	if w.Code != http.StatusOK {
		t.Fatalf("export docx: expected 200, got %d (%s)", w.Code, w.Body.String())
	}
}

// A slide deck exports to pptx over /v1: the endpoint used to answer 501 and
// point at a client-side fallback that does not exist for an API caller.
func TestV1_ExportSlidePPTX(t *testing.T) {
	h, _ := newV1Handler()
	id := createV1DocAs(t, h, "alice", "slide", map[string]interface{}{
		"title": "Q3 Plan",
		"slides": []map[string]interface{}{
			{"title": "Intro", "content": "<p>hello</p>", "background": "#101020"},
		},
	})

	alice := v1Router(h, "alice", false)
	w := doReq(alice, http.MethodPost, "/v1/documents/"+id+"/export", map[string]string{"format": "pptx"})
	if w.Code != http.StatusOK {
		t.Fatalf("export pptx: expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	const pptxCT = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
	if ct := w.Header().Get("Content-Type"); ct != pptxCT {
		t.Fatalf("expected %s, got %q", pptxCT, ct)
	}
	// A .pptx is a ZIP: the body must actually be one, not an error page.
	body := w.Body.Bytes()
	if len(body) < 4 || string(body[:2]) != "PK" {
		t.Fatalf("body is not a ZIP package (len=%d)", len(body))
	}
	zr, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		t.Fatalf("open pptx zip: %v", err)
	}
	for _, want := range []string{"[Content_Types].xml", "ppt/presentation.xml", "ppt/slides/slide1.xml"} {
		if _, err := zr.Open(want); err != nil {
			t.Errorf("pptx package is missing %s", want)
		}
	}
}

func TestV1_ExportUnsupportedFormat(t *testing.T) {
	h, _ := newV1Handler()
	id := createV1DocAs(t, h, "alice", "doc", "x")

	alice := v1Router(h, "alice", false)
	w := doReq(alice, http.MethodPost, "/v1/documents/"+id+"/export", map[string]string{"format": "xlsx"})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for doc→xlsx, got %d (%s)", w.Code, w.Body.String())
	}
}

func TestV1_Collaborators(t *testing.T) {
	h, _ := newV1Handler()
	id := createV1DocAs(t, h, "alice", "doc", "x")

	alice := v1Router(h, "alice", false)
	// Share with bob.
	w := doReq(alice, http.MethodPost, "/v1/documents/"+id+"/collaborators", map[string]interface{}{"account": "bob"})
	if w.Code != http.StatusOK {
		t.Fatalf("share: expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	// Bob can now read it.
	bob := v1Router(h, "bob", false)
	if w := doReq(bob, http.MethodGet, "/v1/documents/"+id, nil); w.Code != http.StatusOK {
		t.Fatalf("bob get after share: expected 200, got %d", w.Code)
	}
	// Collaborators list shows bob.
	w = doReq(alice, http.MethodGet, "/v1/documents/"+id+"/collaborators", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("collaborators: %d", w.Code)
	}
	var cl struct {
		Owner         string `json:"owner"`
		Collaborators []struct {
			AccountID string `json:"account_id"`
			Role      string `json:"role"`
		} `json:"collaborators"`
	}
	decodeJSON(t, w.Body.Bytes(), &cl)
	if len(cl.Collaborators) != 1 || cl.Collaborators[0].AccountID != "bob" {
		t.Fatalf("expected [{bob editor}], got %+v", cl.Collaborators)
	}
	if cl.Collaborators[0].Role != "editor" {
		t.Fatalf("expected default role 'editor', got %q", cl.Collaborators[0].Role)
	}
	// Revoke.
	w = doReq(alice, http.MethodPost, "/v1/documents/"+id+"/collaborators", map[string]interface{}{"account": "bob", "revoke": true})
	if w.Code != http.StatusOK {
		t.Fatalf("revoke: %d", w.Code)
	}
	if w := doReq(bob, http.MethodGet, "/v1/documents/"+id, nil); w.Code != http.StatusNotFound {
		t.Fatalf("bob get after revoke: expected 404, got %d", w.Code)
	}
}

// TestV1_ShareByEmail_CoCloud covers the primary co-cloud share-by-email path:
// Alice shares with Bob (an account-only recipient resolved by email) and Bob
// can then read the document by his account (email) id.
func TestV1_ShareByEmail_CoCloud(t *testing.T) {
	h, _ := newV1Handler()
	// Co-cloud recipient: empty Server resolves as "this cell".
	h.WithDirectory(&fakeResolver{byEmail: map[string]directory.DiscoveryResult{
		"bob@example.com": {VulaID: "vula:ed25519:bob", Server: ""},
	}}, "cell-1")

	id := createV1DocAs(t, h, "alice@example.com", "doc", "x")
	alice := v1Router(h, "alice@example.com", false)

	// Share by email (mixed case + a role from the contract vocabulary).
	w := doReq(alice, http.MethodPost, "/v1/documents/"+id+"/collaborators",
		map[string]interface{}{"email": "Bob@Example.com", "role": "comment"})
	if w.Code != http.StatusOK {
		t.Fatalf("share-by-email: expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	var sr struct {
		OK      bool   `json:"ok"`
		Grantee string `json:"grantee"`
	}
	decodeJSON(t, w.Body.Bytes(), &sr)
	if !sr.OK || sr.Grantee != "bob@example.com" {
		t.Fatalf("expected grantee bob@example.com, got %+v", sr)
	}

	// Bob (keyed by his account email) can read.
	bob := v1Router(h, "bob@example.com", false)
	if w := doReq(bob, http.MethodGet, "/v1/documents/"+id, nil); w.Code != http.StatusOK {
		t.Fatalf("bob get after email-share: expected 200, got %d", w.Code)
	}

	// The ACL records the commenter role.
	w = doReq(alice, http.MethodGet, "/v1/documents/"+id+"/collaborators", nil)
	var cl struct {
		Collaborators []struct {
			AccountID string `json:"account_id"`
			Role      string `json:"role"`
		} `json:"collaborators"`
	}
	decodeJSON(t, w.Body.Bytes(), &cl)
	if len(cl.Collaborators) != 1 || cl.Collaborators[0].AccountID != "bob@example.com" || cl.Collaborators[0].Role != "commenter" {
		t.Fatalf("expected [{bob@example.com commenter}], got %+v", cl.Collaborators)
	}
}

// TestV1_ShareByEmail_Remote covers the remote-recipient routing: a recipient
// on another cell must NOT get a local ACL grant — the handler returns 409 with
// a structured peershare routing payload.
func TestV1_ShareByEmail_Remote(t *testing.T) {
	h, _ := newV1Handler()
	h.WithDirectory(&fakeResolver{byEmail: map[string]directory.DiscoveryResult{
		"carol@other.example": {VulaID: "vula:ed25519:carol", Server: "other-cell.example"},
	}}, "cell-1")

	id := createV1DocAs(t, h, "alice@example.com", "doc", "x")
	alice := v1Router(h, "alice@example.com", false)

	w := doReq(alice, http.MethodPost, "/v1/documents/"+id+"/collaborators",
		map[string]interface{}{"email": "carol@other.example", "role": "edit"})
	if w.Code != http.StatusConflict {
		t.Fatalf("remote share: expected 409, got %d (%s)", w.Code, w.Body.String())
	}
	var rr struct {
		Code      string `json:"code"`
		Routing   string `json:"routing"`
		Recipient struct {
			VulaID string `json:"vula_id"`
			Server string `json:"server"`
		} `json:"recipient"`
	}
	decodeJSON(t, w.Body.Bytes(), &rr)
	if rr.Code != "remote_recipient" || rr.Routing != "peershare" {
		t.Fatalf("expected remote_recipient/peershare routing, got %+v", rr)
	}
	if rr.Recipient.VulaID != "vula:ed25519:carol" || rr.Recipient.Server != "other-cell.example" {
		t.Fatalf("expected resolved remote recipient echoed, got %+v", rr.Recipient)
	}
	// And NO local ACL grant happened: carol cannot read.
	carol := v1Router(h, "carol@other.example", false)
	if w := doReq(carol, http.MethodGet, "/v1/documents/"+id, nil); w.Code != http.StatusNotFound {
		t.Fatalf("carol must not have local access; expected 404, got %d", w.Code)
	}
}

// TestV1_ShareByEmail_NotFound: an email with no Vulos account returns 404.
func TestV1_ShareByEmail_NotFound(t *testing.T) {
	h, _ := newV1Handler()
	h.WithDirectory(&fakeResolver{byEmail: map[string]directory.DiscoveryResult{}}, "cell-1")

	id := createV1DocAs(t, h, "alice@example.com", "doc", "x")
	alice := v1Router(h, "alice@example.com", false)
	w := doReq(alice, http.MethodPost, "/v1/documents/"+id+"/collaborators",
		map[string]interface{}{"email": "nobody@example.com"})
	if w.Code != http.StatusNotFound {
		t.Fatalf("unknown email: expected 404, got %d (%s)", w.Code, w.Body.String())
	}
}

// TestV1_ShareByEmail_RoleScoped (auth enabled): a commenter/viewer grant is
// read-only — the recipient may GET but not PATCH content.
func TestV1_ShareByEmail_RoleScoped(t *testing.T) {
	st := newMemStorage()
	acl := fileacl.NewNullStore()
	h := NewV1HandlerWithDeps(st, NewFileAuthzWithAuth(acl, true), audit.NewNullStore())
	h.WithDirectory(&fakeResolver{byEmail: map[string]directory.DiscoveryResult{
		"bob@example.com": {VulaID: "vula:ed25519:bob", Server: ""},
	}}, "cell-1")

	id := createV1DocAs(t, h, "alice@example.com", "doc", "x")
	alice := v1Router(h, "alice@example.com", false)
	w := doReq(alice, http.MethodPost, "/v1/documents/"+id+"/collaborators",
		map[string]interface{}{"email": "bob@example.com", "role": "comment"})
	if w.Code != http.StatusOK {
		t.Fatalf("share: expected 200, got %d (%s)", w.Code, w.Body.String())
	}

	bob := v1Router(h, "bob@example.com", false)
	// Read allowed.
	if w := doReq(bob, http.MethodGet, "/v1/documents/"+id, nil); w.Code != http.StatusOK {
		t.Fatalf("commenter read: expected 200, got %d", w.Code)
	}
	// Content edit denied (commenter is not an editor).
	w = doReq(bob, http.MethodPatch, "/v1/documents/"+id,
		map[string]interface{}{"content": "mutated"})
	if w.Code != http.StatusForbidden {
		t.Fatalf("commenter patch: expected 403, got %d (%s)", w.Code, w.Body.String())
	}
}
