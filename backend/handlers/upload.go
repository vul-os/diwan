package handlers

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"diwan/backend/billing"
	"diwan/backend/config"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// maxUploadBytes caps a single upload at 10 MB.
const maxUploadBytes = 10 << 20

// allowedTypes is the allowlist of accepted upload content types, determined by
// SNIFFING the file bytes (http.DetectContentType) — never the client-supplied
// multipart header. image/svg+xml is intentionally EXCLUDED: SVG is an
// active/script-bearing format and, when served inline same-origin, is a stored
// XSS vector. Uploads are additionally served with Content-Disposition:
// attachment (see Serve) as defence in depth.
var allowedTypes = map[string]bool{
	"image/jpeg": true,
	"image/png":  true,
	"image/gif":  true,
	"image/webp": true,
}

type UploadHandler struct {
	uploadsDir string
}

func NewUploadHandler(cfg *config.Config) *UploadHandler {
	os.MkdirAll(cfg.Server.UploadsDir, 0755)
	return &UploadHandler{uploadsDir: cfg.Server.UploadsDir}
}

func (h *UploadHandler) Upload(c *gin.Context) {
	// Cap the whole request body so a multipart upload cannot stream more than
	// the limit into memory (a single file.Read previously truncated >10MB,
	// under-counting storage + metered bytes instead of rejecting the file).
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxUploadBytes+(1<<20))

	file, _, err := c.Request.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "no file provided"})
		return
	}
	defer file.Close()

	// Read the full file (bounded by MaxBytesReader above) so the storage gate
	// and meter see the TRUE byte count, not a truncated prefix.
	data, err := io.ReadAll(io.LimitReader(file, maxUploadBytes+1))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "failed to read file"})
		return
	}
	if len(data) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "empty file"})
		return
	}
	if len(data) > maxUploadBytes {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "file too large"})
		return
	}

	// Determine the content type by SNIFFING the bytes — never trust the
	// client-supplied multipart Content-Type header (it is attacker-controlled
	// and was the SVG-XSS vector). http.DetectContentType reads at most 512 bytes.
	contentType := http.DetectContentType(data)
	if i := strings.IndexByte(contentType, ';'); i >= 0 {
		contentType = strings.TrimSpace(contentType[:i])
	}
	if !allowedTypes[contentType] {
		c.JSON(http.StatusBadRequest, gin.H{"error": "unsupported file type"})
		return
	}

	// Derive the extension from the SNIFFED type, not the client filename, so a
	// hostile extension can't be smuggled onto disk.
	ext := mimeToExt(contentType)
	filename := uuid.New().String() + ext
	dst := filepath.Join(h.uploadsDir, filename)

	n := len(data)

	// STORAGE GATE: atomically check AND reserve the account's storage quota
	// BEFORE writing the file (server-side, on the verified account id, before
	// resource issuance). In standalone mode the cap is unlimited, so this is a
	// no-op. The reservation is committed on a successful write and released on
	// failure so the quota is not consumed by a write that never lands.
	account := requesterID(c)
	d, res := billing.GateStorage(c.Request.Context(), account, int64(n))
	if !d.Allowed() {
		c.JSON(d.Code, gin.H{"error": d.Reason})
		return
	}

	if err := os.WriteFile(dst, data, 0644); err != nil {
		res.Release()
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save file"})
		return
	}

	// METER: commit the reservation (advances the running total + reports usage).
	res.Commit(c.Request.Context())

	c.JSON(http.StatusOK, gin.H{
		"url":      fmt.Sprintf("/api/uploads/%s", filename),
		"filename": filename,
	})
}

func (h *UploadHandler) Serve(c *gin.Context) {
	filename := c.Param("filename")
	// Prevent path traversal
	if strings.Contains(filename, "..") || strings.Contains(filename, "/") {
		c.Status(http.StatusBadRequest)
		return
	}
	// Defence in depth against stored XSS: force a download (never render
	// inline same-origin) and stop the browser from MIME-sniffing the bytes
	// into an active type.
	c.Header("Content-Disposition", `attachment; filename="`+filename+`"`)
	c.Header("X-Content-Type-Options", "nosniff")
	c.File(filepath.Join(h.uploadsDir, filename))
}

func mimeToExt(mime string) string {
	switch mime {
	case "image/jpeg":
		return ".jpg"
	case "image/png":
		return ".png"
	case "image/gif":
		return ".gif"
	case "image/webp":
		return ".webp"
	default:
		return ".bin"
	}
}
