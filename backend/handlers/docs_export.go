package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"

	"diwan/backend/services/docs_export"
	"diwan/backend/storage"

	"github.com/gin-gonic/gin"
)

// DocsExportHandler serves GET /api/docs/:id/export?format=pdf|docx
// It reads the stored TipTap JSON for the file, converts it to the requested
// format, and returns the binary with appropriate Content-Type and
// Content-Disposition headers.
type DocsExportHandler struct {
	store storage.Storage
	authz *FileAuthz
}

// NewDocsExportHandler constructs a DocsExportHandler.
func NewDocsExportHandler(store storage.Storage) *DocsExportHandler {
	return &DocsExportHandler{store: store, authz: SharedFileAuthz()}
}

// Export handles GET /api/files/:id/export?format=pdf|docx
func (h *DocsExportHandler) Export(c *gin.Context) {
	fileID := c.Param("id")
	if !h.authz.require(c, fileID) {
		return
	}
	format := c.Query("format")
	if format == "" {
		format = "pdf"
	}

	file, err := h.store.GetFile(fileID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "file not found"})
		return
	}

	title := file.Name
	if title == "" {
		title = "document"
	}

	// Parse TipTap JSON from content field.
	// file.Content is stored as json.RawMessage (interface{}).
	rawContent, err := json.Marshal(file.Content)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to read file content"})
		return
	}

	doc, err := docs_export.ParseDocJSON(rawContent)
	if err != nil {
		// If content is not a TipTap doc (e.g. raw HTML from import), fall back
		// to a single-paragraph document.
		doc = &docs_export.DocJSON{
			Type: "doc",
			Content: []docs_export.Node{
				{Type: "paragraph", Content: []docs_export.Node{{Type: "text", Text: string(rawContent)}}},
			},
		}
	}

	// BLOCKS, not paragraphs: a flat paragraph list is what used to shred every
	// table into loose paragraphs and drop every image (see docs_export/blocks.go).
	blocks, rep := docs_export.ExtractBlocks(doc)

	switch format {
	case "pdf":
		data, rep, err := docs_export.GeneratePDFReport(title, blocks, rep)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("pdf generation failed: %v", err)})
			return
		}
		setExportWarnings(c, rep.Warnings)
		c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.pdf"`, docsExportSanitizeFilename(title)))
		c.Data(http.StatusOK, "application/pdf", data)

	case "docx":
		data, err := docs_export.GenerateDOCX(title, blocks)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("docx generation failed: %v", err)})
			return
		}
		setExportWarnings(c, rep.Warnings)
		c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.docx"`, docsExportSanitizeFilename(title)))
		c.Data(http.StatusOK, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", data)

	default:
		c.JSON(http.StatusBadRequest, gin.H{"error": "unsupported format; use pdf or docx"})
	}
}

// docsExportSanitizeFilename removes characters that are unsafe in HTTP Content-Disposition filenames.
func docsExportSanitizeFilename(name string) string {
	var out []rune
	for _, r := range name {
		switch {
		case r == '"' || r == '\\' || r == '/' || r == ':' || r == '*' || r == '?' || r == '<' || r == '>' || r == '|':
			out = append(out, '_')
		default:
			out = append(out, r)
		}
	}
	if len(out) == 0 {
		return "document"
	}
	return string(out)
}
