package handlers

import (
	"bytes"
	"context"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"diwan/backend/billing"
	"diwan/backend/config"
	"diwan/backend/middleware"
	"diwan/backend/seam"

	"github.com/gin-gonic/gin"
)

// gateEntitlements returns a fixed entitlement for the upload-gate tests.
type gateEntitlements struct{ ent seam.Entitlement }

func (g gateEntitlements) For(context.Context, string) (seam.Entitlement, error) {
	return g.ent, nil
}
func (g gateEntitlements) Allowed(context.Context, string, string) bool { return true }

func uploadRouter(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	h := NewUploadHandler(&config.Config{Server: config.ServerConfig{UploadsDir: t.TempDir()}})
	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Set(middleware.CtxAuthenticated, true)
		c.Set(middleware.CtxUserID, "alice@vulos.org")
		c.Next()
	})
	r.POST("/upload", h.Upload)
	return r
}

// pngMagic is the PNG file signature so http.DetectContentType sniffs the
// uploaded bytes as image/png (the handler no longer trusts the multipart
// Content-Type header — it sniffs the content).
var pngMagic = []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A}

func pngUploadRequest(t *testing.T, payload []byte) *http.Request {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	hdr := make(map[string][]string)
	hdr["Content-Disposition"] = []string{`form-data; name="file"; filename="x.png"`}
	hdr["Content-Type"] = []string{"image/png"}
	part, err := mw.CreatePart(hdr)
	if err != nil {
		t.Fatalf("create part: %v", err)
	}
	// Prepend the PNG signature so the byte-sniff classifies it as image/png.
	_, _ = part.Write(append(append([]byte{}, pngMagic...), payload...))
	mw.Close()
	req := httptest.NewRequest(http.MethodPost, "/upload", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	return req
}

func resetBilling(t *testing.T) {
	t.Cleanup(func() {
		billing.Configure(seam.NewStandaloneProvider(func() ([]byte, error) { return nil, nil }, false))
	})
}

// Standalone (unlimited) lets the upload through.
func TestUpload_Standalone_OK(t *testing.T) {
	resetBilling(t)
	billing.Configure(seam.NewStandaloneProvider(func() ([]byte, error) { return nil, nil }, false))

	r := uploadRouter(t)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, pngUploadRequest(t, []byte("hello-png-bytes")))
	if w.Code != http.StatusOK {
		t.Fatalf("standalone upload should be 200, got %d (%s)", w.Code, w.Body.String())
	}
}

// A small storage cap rejects an over-limit upload with 402.
func TestUpload_OverQuota_402(t *testing.T) {
	resetBilling(t)
	billing.Configure(seam.Provider{
		Entitlements: gateEntitlements{ent: seam.Entitlement{MaxStorageBytes: 4}},
		Usage:        seam.NewNoopUsage(),
	})

	r := uploadRouter(t)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, pngUploadRequest(t, []byte("this is more than four bytes")))
	if w.Code != http.StatusPaymentRequired {
		t.Fatalf("over-quota upload should be 402, got %d (%s)", w.Code, w.Body.String())
	}
}

// A suspended account is blocked with 402.
func TestUpload_Suspended_402(t *testing.T) {
	resetBilling(t)
	billing.Configure(seam.Provider{
		Entitlements: gateEntitlements{ent: seam.Entitlement{Suspended: true}},
		Usage:        seam.NewNoopUsage(),
	})

	r := uploadRouter(t)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, pngUploadRequest(t, []byte("x")))
	if w.Code != http.StatusPaymentRequired {
		t.Fatalf("suspended upload should be 402, got %d (%s)", w.Code, w.Body.String())
	}
}
