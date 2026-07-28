package handlers

// seal_verify_test.go — end-to-end correctness tests for OFFICE-46/47:
//   - Sealed PDF round-trip: build a sealed PDF, then verify it → all green.
//   - Tamper detection: mutate the pre-manifest bytes → hash mismatch.
//   - Chain integrity: corrupting an audit event is detected by VerifyChain.
//   - Per-signer Ed25519 token: full pipeline verifies tokens.
//   - Public-key endpoint returns valid base64 key.
//   - Download gate: 409 when envelope is not fully signed.
//   - Manifest endpoint returns FinalHash and audit events.

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"diwan/backend/config"
	"diwan/backend/fileacl"
	"diwan/backend/middleware"
	"diwan/backend/models"
	"diwan/backend/signing"
	"diwan/backend/storage"

	"github.com/gin-gonic/gin"
)

// ─────────────────────────────────────────────────────────
// package-level key init
// ─────────────────────────────────────────────────────────

func init() {
	// Ensure the Ed25519 key is available for all tests in this package.
	// LoadOrGenerateKey is idempotent so calling it here is safe even if
	// other test files do the same.
	_ = signing.LoadOrGenerateKey()
}

// ─────────────────────────────────────────────────────────
// sealStack — envStack + VerifyHandler
// ─────────────────────────────────────────────────────────

type sealStack struct {
	store      storage.Storage
	acl        fileacl.Store
	uploadsDir string
	env        *EnvelopeHandler
	seal       *SealHandler
	sign       *SigningHandler
	orch       *OrchestrationHandler
	verify     *VerifyHandler
}

// sampleSourcePDF is a minimal but valid one-page PDF used as the on-disk source
// document for seal round-trip tests. The seal pipeline now FAILS when the
// source PDF is absent (it no longer silently seals a blank placeholder), so the
// tests must provide a real source file in uploadsDir.
var sampleSourcePDF = []byte(`%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>
endobj
xref
0 4
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
trailer
<< /Size 4 /Root 1 0 R >>
startxref
190
%%EOF
`)

// writeSourcePDF drops a valid source PDF at uploadsDir/<sourceFileID> so
// loadSourcePDF resolves it on the exact-match path.
func (s *sealStack) writeSourcePDF(t *testing.T, sourceFileID string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(s.uploadsDir, sourceFileID), sampleSourcePDF, 0o644); err != nil {
		t.Fatalf("write source pdf: %v", err)
	}
}

func newSealStack(t *testing.T) *sealStack {
	t.Helper()
	cfg := config.Default()
	cfg.Server.DataDir = t.TempDir()
	cfg.Server.UploadsDir = t.TempDir()
	st, err := storage.NewLocalStorage(cfg)
	if err != nil {
		t.Fatalf("local storage: %v", err)
	}
	acl := fileacl.NewNullStore()
	authz := NewFileAuthz(acl)
	return &sealStack{
		store:      st,
		acl:        acl,
		uploadsDir: cfg.Server.UploadsDir,
		env:        NewEnvelopeHandlerWithAuthz(st, authz),
		seal:       NewSealHandlerWithAuthz(st, cfg.Server.UploadsDir, authz),
		sign:       NewSigningHandlerWithAuthz(st, authz),
		orch:       NewOrchestrationHandlerWithAuthz(st, authz),
		verify:     NewVerifyHandler(st),
	}
}

// protectedRouter wires envelope + protected signing routes with a user identity.
func (s *sealStack) protectedRouter(user string, admin bool) *gin.Engine {
	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Set(middleware.CtxAuthenticated, true)
		c.Set(middleware.CtxUserID, user)
		if admin {
			c.Set(middleware.CtxIsAdmin, true)
		}
		c.Next()
	})
	r.GET("/envelopes", s.env.List)
	r.GET("/envelopes/:id", s.env.Get)
	r.POST("/envelopes", s.env.Create)
	r.PUT("/envelopes/:id", s.env.Update)
	r.DELETE("/envelopes/:id", s.env.Delete)
	r.POST("/sign/:id/send", s.sign.Send)
	r.GET("/sign/:id/status", s.orch.Status)
	r.POST("/sign/:id/remind", s.orch.Remind)
	r.POST("/sign/:id/cancel", s.orch.Cancel)
	r.GET("/sign/:id/download", s.seal.Download)
	r.GET("/sign/:id/manifest", s.seal.Manifest)
	return r
}

// publicSignRouter wires the token-scoped public routes.
func (s *sealStack) publicSignRouter() *gin.Engine {
	r := gin.New()
	r.GET("/sign/:id", s.sign.GetSignerView)
	r.POST("/sign/:id/complete", s.sign.Complete)
	r.POST("/sign/:id/decline", s.orch.Decline)
	return r
}

// verifyRouter wires the verify + pubkey public routes.
func (s *sealStack) verifyRouter() *gin.Engine {
	r := gin.New()
	r.POST("/sign/verify", s.verify.Verify)
	r.GET("/sign/pubkey", s.verify.PublicKey)
	return r
}

// ─────────────────────────────────────────────────────────
// seedSignedEnvelope — drives the full pipeline end-to-end
// ─────────────────────────────────────────────────────────

// seedSignedEnvelope creates an envelope with two parallel signers, sends it,
// completes both signers, and returns the envelope id.
func seedSignedEnvelopeSS(t *testing.T, s *sealStack, owner string) string {
	t.Helper()

	if err := s.acl.SetOwner("src-seal-ss1", owner); err != nil {
		t.Fatalf("set owner: %v", err)
	}
	s.writeSourcePDF(t, "src-seal-ss1")

	ownerR := s.protectedRouter(owner, false)

	env := models.Envelope{
		SourceFileID: "src-seal-ss1",
		Title:        "Seal Test NDA",
		OrderMode:    models.SigningOrderParallel,
		Signers: []*models.Signer{
			{Name: "Alice", Email: "alice@example.com", Order: 1},
			{Name: "Bob", Email: "bob@example.com", Order: 1},
		},
	}
	w := doReq(ownerR, http.MethodPost, "/envelopes", env)
	if w.Code != http.StatusCreated {
		t.Fatalf("create envelope: expected 201, got %d (%s)", w.Code, w.Body.String())
	}
	var created models.Envelope
	mustDecode(t, w, &created)
	envelopeID := created.ID

	// Send (issue tokens).
	wSend := doReq(ownerR, http.MethodPost, "/sign/"+envelopeID+"/send", nil)
	if wSend.Code != http.StatusOK {
		t.Fatalf("send: expected 200, got %d (%s)", wSend.Code, wSend.Body.String())
	}
	var sendResp struct {
		Tokens map[string]string `json:"tokens"`
	}
	mustDecode(t, wSend, &sendResp)

	pubR := s.publicSignRouter()

	for _, tok := range sendResp.Tokens {
		wView := doReq(pubR, http.MethodGet, "/sign/"+tok, nil)
		if wView.Code != http.StatusOK {
			t.Fatalf("view signer: expected 200, got %d (%s)", wView.Code, wView.Body.String())
		}

		wComp := doReq(pubR, http.MethodPost, "/sign/"+tok+"/complete", map[string]string{})
		if wComp.Code != http.StatusOK {
			t.Fatalf("complete signer: expected 200, got %d (%s)", wComp.Code, wComp.Body.String())
		}
	}

	return envelopeID
}

// downloadSealedPDFSS downloads the sealed PDF bytes for a completed envelope.
func downloadSealedPDFSS(t *testing.T, s *sealStack, owner, envelopeID string) []byte {
	t.Helper()
	ownerR := s.protectedRouter(owner, false)
	req := httptest.NewRequest(http.MethodGet, "/sign/"+envelopeID+"/download", nil)
	w := httptest.NewRecorder()
	ownerR.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("download sealed PDF: expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	return bytes.Clone(w.Body.Bytes())
}

// ─────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────

// TestSealVerify_RoundTrip creates a signed envelope, downloads the sealed PDF,
// runs verifyPDFBytes, and asserts all checks pass.
func TestSealVerify_RoundTrip(t *testing.T) {
	s := newSealStack(t)
	envelopeID := seedSignedEnvelopeSS(t, s, "alice")
	pdfBytes := downloadSealedPDFSS(t, s, "alice", envelopeID)

	if len(pdfBytes) == 0 {
		t.Fatal("sealed PDF is empty")
	}

	report := verifyPDFBytes(pdfBytes)

	if !report.HashMatch {
		t.Errorf("hash_match=false: %s", report.HashErr)
	}
	if !report.ChainOK {
		t.Errorf("chain_ok=false: %s", report.ChainErr)
	}
	for _, sr := range report.Signers {
		if !sr.TokenOK {
			t.Errorf("signer %s token_ok=false: %s", sr.SignerID, sr.TokenErr)
		}
	}
	if !report.OK {
		t.Errorf("overall OK=false: hash=%v chain=%v", report.HashMatch, report.ChainOK)
	}
}

// TestSealVerify_TamperDetected verifies that flipping a byte in the pre-manifest
// PDF body causes the hash check to fail.
func TestSealVerify_TamperDetected(t *testing.T) {
	s := newSealStack(t)
	envelopeID := seedSignedEnvelopeSS(t, s, "alice")
	pdfBytes := downloadSealedPDFSS(t, s, "alice", envelopeID)

	tampered := bytes.Clone(pdfBytes)
	// Flip a byte near the start of the PDF (before any manifest attachment).
	if len(tampered) > 20 {
		tampered[20] ^= 0xFF
	}

	report := verifyPDFBytes(tampered)
	if report.HashMatch {
		t.Error("expected hash_match=false after tampering, got true")
	}
	if report.OK {
		t.Error("expected overall OK=false after tampering, got true")
	}
}

// TestSealVerify_ViaHTTP_OK exercises the full HTTP verify pipeline.
func TestSealVerify_ViaHTTP_OK(t *testing.T) {
	s := newSealStack(t)
	envelopeID := seedSignedEnvelopeSS(t, s, "alice")
	pdfBytes := downloadSealedPDFSS(t, s, "alice", envelopeID)

	body, ct := multipartFile(t, "pdf", "sealed.pdf", pdfBytes)
	vR := s.verifyRouter()
	req := httptest.NewRequest(http.MethodPost, "/sign/verify", body)
	req.Header.Set("Content-Type", ct)
	w := httptest.NewRecorder()
	vR.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("verify HTTP OK: expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	var resp VerifyResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode verify response: %v", err)
	}
	if !resp.OK {
		t.Errorf("verify response OK=false: hash_match=%v chain=%v", resp.HashMatch, resp.ChainOK)
	}
}

// TestSealVerify_ViaHTTP_Tamper checks the HTTP endpoint returns 422 for a
// tampered PDF.
func TestSealVerify_ViaHTTP_Tamper(t *testing.T) {
	s := newSealStack(t)
	envelopeID := seedSignedEnvelopeSS(t, s, "alice")
	pdfBytes := downloadSealedPDFSS(t, s, "alice", envelopeID)

	tampered := bytes.Clone(pdfBytes)
	if len(tampered) > 100 {
		tampered[100] ^= 0xAB
	}

	body, ct := multipartFile(t, "pdf", "tampered.pdf", tampered)
	vR := s.verifyRouter()
	req := httptest.NewRequest(http.MethodPost, "/sign/verify", body)
	req.Header.Set("Content-Type", ct)
	w := httptest.NewRecorder()
	vR.ServeHTTP(w, req)

	if w.Code != http.StatusUnprocessableEntity {
		t.Errorf("expected 422 for tampered PDF, got %d (%s)", w.Code, w.Body.String())
	}
}

// TestSealVerify_ByEnvelopeID confirms JSON-body envelope_id verification works.
func TestSealVerify_ByEnvelopeID(t *testing.T) {
	s := newSealStack(t)
	envelopeID := seedSignedEnvelopeSS(t, s, "alice")

	// Trigger sealing.
	downloadSealedPDFSS(t, s, "alice", envelopeID)

	vR := s.verifyRouter()
	w := doReq(vR, http.MethodPost, "/sign/verify", map[string]string{"envelope_id": envelopeID})

	if w.Code != http.StatusOK {
		t.Fatalf("verify by envelope_id: expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	var resp VerifyResponse
	mustDecode(t, w, &resp)
	if !resp.OK {
		t.Errorf("verify by envelope_id: OK=false (hash=%v chain=%v)", resp.HashMatch, resp.ChainOK)
	}
}

// TestSealVerify_PublicKeyEndpoint confirms GET /sign/pubkey returns a valid key.
func TestSealVerify_PublicKeyEndpoint(t *testing.T) {
	s := newSealStack(t)
	vR := s.verifyRouter()

	req := httptest.NewRequest(http.MethodGet, "/sign/pubkey", nil)
	w := httptest.NewRecorder()
	vR.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("pubkey: expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	var resp struct {
		Algorithm string `json:"algorithm"`
		PublicKey string `json:"public_key"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode pubkey: %v", err)
	}
	if resp.Algorithm != "Ed25519" {
		t.Errorf("expected algorithm=Ed25519, got %q", resp.Algorithm)
	}
	if len(resp.PublicKey) < 40 {
		t.Errorf("public_key too short: %q", resp.PublicKey)
	}
}

// TestSeal_DownloadRequiresAllSigned verifies Download → 409 before all signed.
func TestSeal_DownloadRequiresAllSigned(t *testing.T) {
	s := newSealStack(t)

	if err := s.acl.SetOwner("src-gate-sv1", "alice"); err != nil {
		t.Fatalf("set owner: %v", err)
	}
	ownerR := s.protectedRouter("alice", false)
	env := models.Envelope{
		SourceFileID: "src-gate-sv1",
		Title:        "Gate Test",
		Signers:      []*models.Signer{{Name: "Charlie", Email: "c@example.com", Order: 1}},
	}
	w := doReq(ownerR, http.MethodPost, "/envelopes", env)
	if w.Code != http.StatusCreated {
		t.Fatalf("create: %d (%s)", w.Code, w.Body.String())
	}
	var created models.Envelope
	mustDecode(t, w, &created)

	wDl := doReq(ownerR, http.MethodGet, "/sign/"+created.ID+"/download", nil)
	if wDl.Code != http.StatusConflict {
		t.Errorf("expected 409 before all signed, got %d (%s)", wDl.Code, wDl.Body.String())
	}
}

// TestSeal_ManifestContainsFinalHash confirms the manifest endpoint returns
// a non-empty FinalHash and audit events after sealing.
func TestSeal_ManifestContainsFinalHash(t *testing.T) {
	s := newSealStack(t)
	envelopeID := seedSignedEnvelopeSS(t, s, "alice")

	// Trigger sealing.
	downloadSealedPDFSS(t, s, "alice", envelopeID)

	ownerR := s.protectedRouter("alice", false)
	w := doReq(ownerR, http.MethodGet, "/sign/"+envelopeID+"/manifest", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("manifest: expected 200, got %d (%s)", w.Code, w.Body.String())
	}

	var manifest AuditManifest
	mustDecode(t, w, &manifest)
	if manifest.FinalHash == "" {
		t.Error("manifest.final_doc_hash must not be empty")
	}
	if manifest.EnvelopeID != envelopeID {
		t.Errorf("manifest envelope_id mismatch: got %q want %q", manifest.EnvelopeID, envelopeID)
	}
	if len(manifest.AuditEvents) == 0 {
		t.Error("manifest must include audit events")
	}
}

// TestSealVerify_HashChainBroken verifies VerifyChain detects a corrupted event.
// (Exercises the signing.VerifyChain path that verify.go uses.)
func TestSealVerify_HashChainBroken(t *testing.T) {
	ts := time.Now().UTC()
	ev0 := signing.AuditChainInput{ID: "e0", EnvelopeID: "env-x", Action: "created", Timestamp: ts}
	h0, _ := signing.HashEvent(ev0)
	ev1 := signing.AuditChainInput{ID: "e1", EnvelopeID: "env-x", Action: "signed", Timestamp: ts.Add(time.Second), PrevEventHash: h0}
	h1, _ := signing.HashEvent(ev1)
	ev2 := signing.AuditChainInput{ID: "e2", EnvelopeID: "env-x", Action: "completed", Timestamp: ts.Add(2 * time.Second), PrevEventHash: h1}

	// Tamper ev1 after computing h1.
	ev1tampered := ev1
	ev1tampered.IP = "injected"

	chain := []signing.AuditChainInput{ev0, ev1tampered, ev2}
	if err := signing.VerifyChain(chain); err == nil {
		t.Error("expected VerifyChain to detect tampered middle event, got nil")
	}
}

// TestSealVerify_Idempotent confirms sealing is idempotent (two download calls
// return the same PDF bytes and both verify green).
func TestSealVerify_Idempotent(t *testing.T) {
	s := newSealStack(t)
	envelopeID := seedSignedEnvelopeSS(t, s, "alice")

	pdf1 := downloadSealedPDFSS(t, s, "alice", envelopeID)
	pdf2 := downloadSealedPDFSS(t, s, "alice", envelopeID)

	if !bytes.Equal(pdf1, pdf2) {
		t.Error("sealed PDF must be identical on repeated downloads (idempotent)")
	}

	r1 := verifyPDFBytes(pdf1)
	if !r1.OK {
		t.Errorf("first download did not verify: hash=%v chain=%v", r1.HashMatch, r1.ChainOK)
	}
}
