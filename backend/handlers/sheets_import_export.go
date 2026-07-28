package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"

	"diwan/backend/services/sheets_export"
	"diwan/backend/storage"

	"github.com/gin-gonic/gin"
)

// SheetsHandler handles XLSX import/export endpoints for Sheets files.
type SheetsHandler struct {
	store storage.Storage
	authz *FileAuthz
}

func NewSheetsHandler(store storage.Storage) *SheetsHandler {
	return &SheetsHandler{store: store, authz: SharedFileAuthz()}
}

// Import handles POST /api/sheets/:id/import
// Accepts a multipart form with a single file field named "file".
// Parses the XLSX and writes the resulting Fortune Sheet JSON into the file's Content.
func (h *SheetsHandler) Import(c *gin.Context) {
	fileID := c.Param("id")
	// SECURITY FIX: this endpoint OVERWRITES the file's content, so it must require
	// EDITOR — not merely read access. Previously it called require() (read), which
	// let a read-only VIEWER (or a commenter) replace the entire spreadsheet by
	// uploading an .xlsx: a straight ACL bypass / privilege escalation. Viewers and
	// commenters are now refused (403), matching PUT /files/:id.
	if !h.authz.requireEditor(c, fileID) {
		return
	}

	fh, err := c.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "file field missing: " + err.Error()})
		return
	}

	src, err := fh.Open()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "cannot open upload: " + err.Error()})
		return
	}
	defer src.Close()

	jsonData, err := sheets_export.ImportXLSX(src)
	if err != nil {
		c.JSON(http.StatusUnprocessableEntity, gin.H{"error": "parse xlsx: " + err.Error()})
		return
	}

	// Load existing file (so we can patch only Content).
	existing, err := h.store.GetFile(fileID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "file not found"})
		return
	}

	// Content is stored as json.RawMessage / any in the model.
	var content any
	if err := json.Unmarshal(jsonData, &content); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "marshal content: " + err.Error()})
		return
	}

	// PROTECTED RANGES (fail-closed): an import that would overwrite a restricted
	// range the caller may not edit — including stripping the protection an .xlsx
	// naturally lacks — is refused, exactly like the PATCH/PUT content path.
	if ok, code, reason := h.authz.enforceProtectedRanges(c, fileID, existing.Content, content); !ok {
		c.JSON(code, gin.H{"error": reason})
		return
	}
	existing.Content = content

	if err := h.store.UpdateFile(existing); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "save file: " + err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"ok": true, "sheets": len(jsonData)})
}

// Export handles GET /api/sheets/:id/export?format=xlsx
// Returns the file's Fortune Sheet JSON content as an XLSX download.
func (h *SheetsHandler) Export(c *gin.Context) {
	fileID := c.Param("id")
	if !h.authz.require(c, fileID) {
		return
	}
	format := c.DefaultQuery("format", "xlsx")

	existing, err := h.store.GetFile(fileID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "file not found"})
		return
	}

	// Re-marshal Content to JSON bytes for the converter.
	jsonData, err := json.Marshal(existing.Content)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "marshal content: " + err.Error()})
		return
	}

	switch format {
	case "xlsx":
		var buf bytes.Buffer
		rep, err := sheets_export.ExportXLSX(jsonData, &buf)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "export xlsx: " + err.Error()})
			return
		}
		// Charts now ride as real chart parts; anything that could not (an unknown
		// type, a live pivot) is reported rather than dropped in silence.
		setExportWarnings(c, rep.Warnings)
		safeName := sanitizeFilename(existing.Name)
		c.Header("Content-Disposition", `attachment; filename="`+safeName+`.xlsx"`)
		c.Data(http.StatusOK,
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			buf.Bytes())
	default:
		c.JSON(http.StatusBadRequest, gin.H{"error": "unsupported format: " + format})
	}
}

// sanitizeFilename strips characters that are unsafe in Content-Disposition headers.
func sanitizeFilename(name string) string {
	safe := make([]byte, 0, len(name))
	for _, b := range []byte(name) {
		if b == '"' || b == '\\' || b == '/' || b == '\n' || b == '\r' {
			safe = append(safe, '_')
		} else {
			safe = append(safe, b)
		}
	}
	if len(safe) == 0 {
		return "spreadsheet"
	}
	return string(safe)
}
