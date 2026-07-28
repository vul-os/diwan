package handlers

// upload_svg_test.go — regression test for the stored-XSS-via-SVG hole. SVG is
// an active/script-bearing format; uploads now (a) reject image/svg+xml from the
// allowlist, (b) sniff bytes with http.DetectContentType instead of trusting the
// client multipart Content-Type header, and (c) are served attachment-only.

import (
	"bytes"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"diwan/backend/billing"
	"diwan/backend/seam"
)

const xssSVG = `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(document.domain)">` +
	`<script>alert(1)</script></svg>`

// uploadPart builds a multipart request whose Content-Type header CLAIMS the
// given type — the handler must ignore the header and sniff the bytes instead.
func uploadPartRequest(t *testing.T, filename, claimedType string, payload []byte) *http.Request {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	hdr := map[string][]string{
		"Content-Disposition": {`form-data; name="file"; filename="` + filename + `"`},
		"Content-Type":        {claimedType},
	}
	part, err := mw.CreatePart(hdr)
	if err != nil {
		t.Fatalf("create part: %v", err)
	}
	_, _ = part.Write(payload)
	mw.Close()
	req := httptest.NewRequest(http.MethodPost, "/upload", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	return req
}

// An SVG upload is rejected even when the client claims image/svg+xml.
func TestUpload_RejectsSVG(t *testing.T) {
	resetBilling(t)
	billing.Configure(seam.NewStandaloneProvider(func() ([]byte, error) { return nil, nil }, false))

	r := uploadRouter(t)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, uploadPartRequest(t, "evil.svg", "image/svg+xml", []byte(xssSVG)))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("VULN: SVG upload should be rejected (400), got %d (%s)", w.Code, w.Body.String())
	}
}

// An SVG payload disguised under a forged image/png header is ALSO rejected,
// because the type is determined by sniffing the bytes, not the header.
func TestUpload_RejectsSVGDisguisedAsPNG(t *testing.T) {
	resetBilling(t)
	billing.Configure(seam.NewStandaloneProvider(func() ([]byte, error) { return nil, nil }, false))

	r := uploadRouter(t)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, uploadPartRequest(t, "evil.png", "image/png", []byte(xssSVG)))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("VULN: SVG-as-PNG upload should be rejected (400), got %d (%s)", w.Code, w.Body.String())
	}
}

// A genuine PNG (valid magic bytes) is still accepted — proves the sniff is
// correct, not a blanket reject.
func TestUpload_AcceptsRealPNG(t *testing.T) {
	resetBilling(t)
	billing.Configure(seam.NewStandaloneProvider(func() ([]byte, error) { return nil, nil }, false))

	pngMagic := []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0}
	r := uploadRouter(t)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, uploadPartRequest(t, "ok.png", "image/png", pngMagic))
	if w.Code != http.StatusOK {
		t.Fatalf("real PNG upload should be 200, got %d (%s)", w.Code, w.Body.String())
	}
}
