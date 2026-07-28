package handlers

// sharelink_token_once_test.go — the HTTP surface of the share-link token-hash
// fix: the raw token is emitted exactly once, on the mint response, and no
// other endpoint can produce it.
//
// This is the layer the storage tests cannot cover. A store that only holds
// hashes is necessary but not sufficient: a handler could still cache tokens,
// echo one back on a later read, or serialize an empty `"token": ""` that a
// client renders as a working URL. Each of the assertions below fails if any of
// those creeps back in.

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"diwan/backend/models"
)

// TestShareLink_TokenIsReturnedOnceAndNeverListed pins the "shown once"
// discipline that backend/invites already applies to registration tokens.
func TestShareLink_TokenIsReturnedOnceAndNeverListed(t *testing.T) {
	s := newRealStack(t)
	fid := s.createFile(t, "alice", "Doc", models.FileTypeDoc, docContent("secret-ish"))
	alice := s.router("alice", false)

	mw := doReq(alice, http.MethodPost, "/files/"+fid+"/share-links", models.CreateShareLinkRequest{})
	if mw.Code != http.StatusCreated {
		t.Fatalf("mint: expected 201, got %d (%s)", mw.Code, mw.Body.String())
	}
	var minted models.ShareLink
	mustDecode(t, mw, &minted)
	if minted.Token == "" {
		t.Fatal("the mint response is the one place the token is handed over — it must carry one")
	}

	// The token opens the document, so it is a live capability…
	anon := s.router("", false)
	if vw := doReq(anon, http.MethodGet, "/share/"+minted.Token, nil); vw.Code != http.StatusOK {
		t.Fatalf("minted token must open the doc: got %d (%s)", vw.Code, vw.Body.String())
	}

	// …and the management list must not contain it, in any field, anywhere.
	lw := doReq(alice, http.MethodGet, "/files/"+fid+"/share-links", nil)
	if lw.Code != http.StatusOK {
		t.Fatalf("list: expected 200, got %d (%s)", lw.Code, lw.Body.String())
	}
	body := lw.Body.String()
	if strings.Contains(body, minted.Token) {
		t.Fatalf("LIST LEAKED THE LIVE TOKEN:\n%s", body)
	}

	// Not even as an empty key: a client that sees `token` present will build a
	// URL out of it. `omitempty` must drop it entirely.
	var listed struct {
		Links []map[string]any `json:"links"`
	}
	if err := json.Unmarshal(lw.Body.Bytes(), &listed); err != nil {
		t.Fatalf("list response is not JSON: %v", err)
	}
	if len(listed.Links) != 1 {
		t.Fatalf("expected 1 link, got %d", len(listed.Links))
	}
	if _, present := listed.Links[0]["token"]; present {
		t.Fatalf("list response still carries a `token` key: %s", body)
	}
	// The management fields the UI genuinely needs are still there.
	for _, k := range []string{"id", "file_id", "has_password", "revoked", "created_at"} {
		if _, present := listed.Links[0][k]; !present {
			t.Fatalf("list response lost the %q field the owner UI needs: %s", k, body)
		}
	}

	// Revocation still works from the id alone — the owner does not need the
	// token to kill a leaked link, which is what makes "shown once" tolerable.
	if rw := doReq(alice, http.MethodDelete, "/files/"+fid+"/share-links/"+minted.ID, nil); rw.Code != http.StatusOK {
		t.Fatalf("revoke by id: expected 200, got %d (%s)", rw.Code, rw.Body.String())
	}
	if vw := doReq(anon, http.MethodGet, "/share/"+minted.Token, nil); vw.Code != http.StatusNotFound {
		t.Fatalf("revoked token must 404: got %d", vw.Code)
	}
}

// TestShareLink_HashIsNotACredential proves the stored key is not itself usable
// as a link: an attacker who reads the store gets hashes and nothing more.
func TestShareLink_HashIsNotACredential(t *testing.T) {
	s := newRealStack(t)
	fid := s.createFile(t, "alice", "Doc", models.FileTypeDoc, docContent("x"))
	alice := s.router("alice", false)
	mw := doReq(alice, http.MethodPost, "/files/"+fid+"/share-links", models.CreateShareLinkRequest{})
	var minted models.ShareLink
	mustDecode(t, mw, &minted)

	// Read what the store actually holds, exactly as a leaked-backup attacker
	// would, and try to use it.
	stored, err := s.store.GetShareLinkByToken(minted.Token)
	if err != nil {
		t.Fatalf("resolve minted link: %v", err)
	}
	if stored.TokenHash == "" {
		t.Fatal("the store must persist a token hash")
	}
	anon := s.router("", false)
	if w := doReq(anon, http.MethodGet, "/share/"+stored.TokenHash, nil); w.Code != http.StatusNotFound {
		t.Fatalf("the stored hash must not open the doc: got %d (%s)", w.Code, w.Body.String())
	}
}
