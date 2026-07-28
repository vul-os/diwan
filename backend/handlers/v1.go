package handlers

// v1.go — the public, developer-facing /v1 JSON API over the existing document
// engine. It is a THIN REST surface: it reuses the same storage.Storage, the
// same per-file FileAuthz, the same billing gates, and the same export services
// (docs_export / sheets_export / slides_export) as the internal /api handlers —
// it does not re-implement any document logic.
//
// Conventions (modelled on lilmail's /v1):
//   - JSON in, JSON out. Every error is `{"error":"<message>"}` with the right
//     status (never an HTML redirect).
//   - Ownership-scoped: each request resolves to a verified account (session JWT
//     or vk_ API key, see middleware.V1Auth) and is filtered through FileAuthz.
//   - Denied access to a file returns 404 (no existence leak), matching FileAuthz.

import (
	"bytes"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"

	"diwan/backend/audit"
	"diwan/backend/billing"
	"diwan/backend/directory"
	"diwan/backend/fileacl"
	"diwan/backend/models"
	"diwan/backend/services/docs_export"
	"diwan/backend/services/sheets_export"
	"diwan/backend/services/slides_export"
	"diwan/backend/storage"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// V1Handler serves the public /v1 document API over the shared engine.
type V1Handler struct {
	store storage.Storage
	authz *FileAuthz
	audit audit.Store

	// dir resolves a recipient EMAIL to a directory principal (Contract 2). It
	// is nil in standalone / self-host mode (no control plane) — in which case
	// the share API still accepts a raw account id for back-compat.
	dir directory.Resolver
	// localServer is THIS cell's server identity, used to decide co-cloud vs
	// remote locality at share time (Contract 3).
	localServer string
}

// NewV1Handler constructs a V1Handler over the process-wide authorizer + audit
// store (same singletons the internal /api file handlers use). When a control
// plane is configured (VULOS_CP_BASE_URL), the directory resolver is wired so
// the share API can accept an email and resolve it to a principal.
func NewV1Handler(store storage.Storage) *V1Handler {
	h := &V1Handler{store: store, authz: SharedFileAuthz(), audit: SharedAuditStore()}
	if r := directory.FromEnv(); r != nil {
		h.dir = r
		h.localServer = r.LocalServer
	}
	return h
}

// NewV1HandlerWithDeps builds a V1Handler over caller-supplied deps (tests).
func NewV1HandlerWithDeps(store storage.Storage, authz *FileAuthz, aud audit.Store) *V1Handler {
	return &V1Handler{store: store, authz: authz, audit: aud}
}

// WithDirectory wires an email->principal resolver and this cell's server
// identity onto the handler (used by main() for the cloud build and by tests).
// Returns the handler for chaining.
func (h *V1Handler) WithDirectory(r directory.Resolver, localServer string) *V1Handler {
	h.dir = r
	h.localServer = localServer
	return h
}

// v1Document is the public metadata representation of a document (no body).
type v1Document struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Type      string `json:"type"`
	CreatedAt string `json:"created_at,omitempty"`
	UpdatedAt string `json:"updated_at,omitempty"`
}

func toV1Document(f *models.File) v1Document {
	d := v1Document{ID: f.ID, Name: f.Name, Type: string(f.Type)}
	if !f.CreatedAt.IsZero() {
		d.CreatedAt = f.CreatedAt.UTC().Format("2006-01-02T15:04:05Z07:00")
	}
	if !f.UpdatedAt.IsZero() {
		d.UpdatedAt = f.UpdatedAt.UTC().Format("2006-01-02T15:04:05Z07:00")
	}
	return d
}

// v1err writes the standard `{"error":...}` body.
func v1err(c *gin.Context, code int, msg string) {
	c.JSON(code, gin.H{"error": msg})
}

// ListDocuments handles GET /v1/documents[?type=doc|sheet|slide|pdf].
// Returns only documents the caller may access (owned + shared); admins see all.
func (h *V1Handler) ListDocuments(c *gin.Context) {
	filterType := c.Query("type")

	files, err := h.store.ListFiles()
	if err != nil {
		v1err(c, http.StatusInternalServerError, err.Error())
		return
	}
	docs := make([]v1Document, 0, len(files))
	for _, f := range files {
		if filterType != "" && string(f.Type) != filterType {
			continue
		}
		if h.authz.canAccess(c, f.ID) {
			docs = append(docs, toV1Document(f))
		}
	}
	c.JSON(http.StatusOK, gin.H{"documents": docs})
}

// GetDocument handles GET /v1/documents/:id — metadata only.
func (h *V1Handler) GetDocument(c *gin.Context) {
	id := c.Param("id")
	if !h.authz.require(c, id) {
		return
	}
	f, err := h.store.GetFile(id)
	if err != nil {
		v1err(c, http.StatusNotFound, "document not found")
		return
	}
	c.JSON(http.StatusOK, toV1Document(f))
}

// v1CreateRequest is the body for POST /v1/documents.
type v1CreateRequest struct {
	Name    string      `json:"name" binding:"required"`
	Type    string      `json:"type" binding:"required"`
	Content interface{} `json:"content"`
}

// CreateDocument handles POST /v1/documents. Reuses the same billing gates,
// ownership-recording, and bucket write-through as the internal create path.
func (h *V1Handler) CreateDocument(c *gin.Context) {
	var req v1CreateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		v1err(c, http.StatusBadRequest, err.Error())
		return
	}

	account := requesterID(c)

	if d := billing.GateOffice(c.Request.Context(), account); !d.Allowed() {
		v1err(c, d.Code, d.Reason)
		return
	}

	file := &models.File{
		ID:      uuid.New().String(),
		Name:    req.Name,
		Type:    models.FileType(req.Type),
		Content: req.Content,
	}

	var contentBytes []byte
	if file.Content != nil {
		if b, err := json.Marshal(file.Content); err == nil {
			contentBytes = b
		}
	}
	d, res := billing.GateStorage(c.Request.Context(), account, int64(len(contentBytes)))
	if !d.Allowed() {
		v1err(c, d.Code, d.Reason)
		return
	}

	if err := h.store.CreateFile(file); err != nil {
		res.Release()
		v1err(c, http.StatusInternalServerError, err.Error())
		return
	}
	// Record ownership so the document is private by default (see FileAuthz).
	if err := h.authz.recordOwner(c, file.ID); err != nil {
		_ = h.store.DeleteFile(file.ID)
		res.Release()
		log.Printf("[v1] recordOwner failed for file=%s: %v (rolled back create)", file.ID, err)
		v1err(c, http.StatusInternalServerError, "failed to record document ownership")
		return
	}

	if contentBytes != nil {
		if err := SharedBucketStore().PutObject(c, account, "file/"+file.ID, contentBytes, "application/json"); err != nil {
			log.Printf("[v1] bucket sync create file=%s: %v (SQLite is primary — continuing)", file.ID, err)
		}
	}
	res.Commit(c.Request.Context())

	freshly, _ := h.store.GetFile(file.ID)
	if freshly == nil {
		freshly = file
	}
	c.JSON(http.StatusCreated, toV1Document(freshly))
}

// v1PatchRequest is the body for PATCH /v1/documents/:id (rename / move /
// content replace). All fields optional; only provided fields are applied.
type v1PatchRequest struct {
	Name    *string     `json:"name"`
	Content interface{} `json:"content"`
}

// PatchDocument handles PATCH /v1/documents/:id — rename and/or replace content.
func (h *V1Handler) PatchDocument(c *gin.Context) {
	id := c.Param("id")
	// Editors and owners may mutate content; viewers are read-only.
	if !h.authz.requireEditor(c, id) {
		return
	}
	account := requesterID(c)

	if d := billing.GateOffice(c.Request.Context(), account); !d.Allowed() {
		v1err(c, d.Code, d.Reason)
		return
	}

	var req v1PatchRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		v1err(c, http.StatusBadRequest, err.Error())
		return
	}

	existing, err := h.store.GetFile(id)
	if err != nil {
		v1err(c, http.StatusNotFound, "document not found")
		return
	}

	// SHEETS PROTECTED RANGES (fail-closed): gate the content replace against the
	// currently-stored content BEFORE overwriting `existing.Content`, so a caller
	// cannot remove a restricted range and edit its cells in one PATCH. No-op in
	// single-user mode / for non-sheet content / when no restricted range exists.
	if req.Content != nil {
		if ok, code, reason := h.authz.enforceProtectedRanges(c, id, existing.Content, req.Content); !ok {
			v1err(c, code, reason)
			return
		}
	}

	if req.Name != nil {
		existing.Name = *req.Name
	}
	if req.Content != nil {
		existing.Content = req.Content
	}

	var contentBytes []byte
	if existing.Content != nil {
		if b, err := json.Marshal(existing.Content); err == nil {
			contentBytes = b
		}
	}
	d, res := billing.GateStorage(c.Request.Context(), account, int64(len(contentBytes)))
	if !d.Allowed() {
		v1err(c, d.Code, d.Reason)
		return
	}

	if err := h.store.UpdateFile(existing); err != nil {
		res.Release()
		if err.Error() == "file not found" {
			v1err(c, http.StatusNotFound, "document not found")
			return
		}
		v1err(c, http.StatusInternalServerError, err.Error())
		return
	}
	if contentBytes != nil {
		if err := SharedBucketStore().PutObject(c, account, "file/"+id, contentBytes, "application/json"); err != nil {
			log.Printf("[v1] bucket sync update file=%s: %v (SQLite is primary — continuing)", id, err)
		}
	}
	res.Commit(c.Request.Context())

	updated, _ := h.store.GetFile(id)
	if updated == nil {
		updated = existing
	}
	c.JSON(http.StatusOK, toV1Document(updated))
}

// DeleteDocument handles DELETE /v1/documents/:id.
func (h *V1Handler) DeleteDocument(c *gin.Context) {
	id := c.Param("id")
	// Only the owner (or an admin) may delete a document.
	if !h.authz.requireOwner(c, id) {
		return
	}
	if err := h.store.DeleteFile(id); err != nil {
		if err.Error() == "file not found" {
			v1err(c, http.StatusNotFound, "document not found")
			return
		}
		v1err(c, http.StatusInternalServerError, err.Error())
		return
	}
	_ = h.authz.Store().Delete(id)
	if err := SharedBucketStore().DeleteObject(c, requesterID(c), "file/"+id); err != nil {
		log.Printf("[v1] bucket sync delete file=%s: %v (ignoring)", id, err)
	}
	c.JSON(http.StatusOK, gin.H{"deleted": true, "id": id})
}

// GetContent handles GET /v1/documents/:id/content[?format=…].
//
//   - no format → the raw stored document body as JSON:
//     {"id":…, "type":…, "content":<body>}
//   - format=pdf|docx|xlsx|pptx → the exported binary (attachment).
//
// Exportable formats depend on the document type (see exportDocument).
func (h *V1Handler) GetContent(c *gin.Context) {
	id := c.Param("id")
	if !h.authz.require(c, id) {
		return
	}
	f, err := h.store.GetFile(id)
	if err != nil {
		v1err(c, http.StatusNotFound, "document not found")
		return
	}
	format := c.Query("format")
	if format == "" {
		c.JSON(http.StatusOK, gin.H{"id": f.ID, "type": string(f.Type), "content": f.Content})
		return
	}
	h.exportDocument(c, f, format)
}

// v1ExportRequest is the body for POST /v1/documents/:id/export.
type v1ExportRequest struct {
	Format string `json:"format" binding:"required"`
}

// ExportDocument handles POST /v1/documents/:id/export — render the document to
// an office format and return the binary attachment.
func (h *V1Handler) ExportDocument(c *gin.Context) {
	id := c.Param("id")
	if !h.authz.require(c, id) {
		return
	}
	var req v1ExportRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		v1err(c, http.StatusBadRequest, err.Error())
		return
	}
	f, err := h.store.GetFile(id)
	if err != nil {
		v1err(c, http.StatusNotFound, "document not found")
		return
	}
	h.exportDocument(c, f, req.Format)
}

// exportDocument dispatches to the right export service based on the document
// type, reusing the SAME pure-Go converters the internal handlers use.
//
//	doc   → pdf, docx
//	sheet → xlsx
//	slide → pdf, pptx
func (h *V1Handler) exportDocument(c *gin.Context, f *models.File, format string) {
	safe := docsExportSanitizeFilename(f.Name)
	switch f.Type {
	case models.FileTypeDoc:
		raw, _ := json.Marshal(f.Content)
		doc, perr := docs_export.ParseDocJSON(raw)
		if perr != nil {
			doc = &docs_export.DocJSON{Type: "doc", Content: []docs_export.Node{
				{Type: "paragraph", Content: []docs_export.Node{{Type: "text", Text: string(raw)}}},
			}}
		}
		// BLOCKS, not paragraphs: the flat list dropped every image and shredded
		// every table (docs_export/blocks.go).
		blocks, rep := docs_export.ExtractBlocks(doc)
		switch format {
		case "pdf":
			data, rep, err := docs_export.GeneratePDFReport(f.Name, blocks, rep)
			if err != nil {
				v1err(c, http.StatusInternalServerError, "pdf generation failed: "+err.Error())
				return
			}
			setExportWarnings(c, rep.Warnings)
			h.sendBinary(c, safe+".pdf", "application/pdf", data)
		case "docx":
			data, err := docs_export.GenerateDOCX(f.Name, blocks)
			if err != nil {
				v1err(c, http.StatusInternalServerError, "docx generation failed: "+err.Error())
				return
			}
			setExportWarnings(c, rep.Warnings)
			h.sendBinary(c, safe+".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", data)
		default:
			v1err(c, http.StatusBadRequest, "unsupported format for doc; use pdf or docx")
		}

	case models.FileTypeSheet:
		if format != "xlsx" {
			v1err(c, http.StatusBadRequest, "unsupported format for sheet; use xlsx")
			return
		}
		raw, _ := json.Marshal(f.Content)
		var buf bytes.Buffer
		rep, err := sheets_export.ExportXLSX(raw, &buf)
		if err != nil {
			v1err(c, http.StatusInternalServerError, "xlsx export failed: "+err.Error())
			return
		}
		setExportWarnings(c, rep.Warnings)
		h.sendBinary(c, safe+".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buf.Bytes())

	case models.FileTypeSlide:
		if format != "pdf" && format != "pptx" {
			v1err(c, http.StatusBadRequest, "unsupported format for slide; use pdf or pptx")
			return
		}
		raw, _ := json.Marshal(f.Content)
		var deck struct {
			Title  string                `json:"title"`
			Slides []slides_export.Slide `json:"slides"`
		}
		if err := json.Unmarshal(raw, &deck); err != nil {
			v1err(c, http.StatusBadRequest, "invalid slide deck format")
			return
		}
		if deck.Title == "" {
			deck.Title = f.Name
		}
		if format == "pptx" {
			data, rep, err := slides_export.GeneratePPTX(slides_export.Deck{Title: deck.Title, Slides: deck.Slides})
			if err != nil {
				v1err(c, http.StatusInternalServerError, "pptx generation failed: "+err.Error())
				return
			}
			setExportWarnings(c, rep.Warnings)
			h.sendBinary(c, safe+".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", data)
			return
		}
		data, rep, err := slides_export.RenderPDF(slides_export.Deck{Title: deck.Title, Slides: deck.Slides})
		if err != nil {
			v1err(c, http.StatusInternalServerError, "pdf generation failed: "+err.Error())
			return
		}
		setExportWarnings(c, rep.Warnings)
		h.sendBinary(c, safe+".pdf", "application/pdf", data)

	default:
		v1err(c, http.StatusBadRequest, "document type "+string(f.Type)+" does not support export")
	}
}

func (h *V1Handler) sendBinary(c *gin.Context, filename, contentType string, data []byte) {
	c.Header("Content-Disposition", `attachment; filename="`+filename+`"`)
	c.Header("Cache-Control", "no-store")
	c.Data(http.StatusOK, contentType, data)
}

// ListCollaborators handles GET /v1/documents/:id/collaborators.
func (h *V1Handler) ListCollaborators(c *gin.Context) {
	id := c.Param("id")
	if !h.authz.require(c, id) {
		return
	}
	if _, err := h.store.GetFile(id); err != nil {
		v1err(c, http.StatusNotFound, "document not found")
		return
	}
	rec, ok, err := h.authz.Store().Get(id)
	if err != nil {
		v1err(c, http.StatusInternalServerError, err.Error())
		return
	}
	owner := ""
	collabs := []map[string]string{}
	if ok {
		owner = rec.Owner
		for _, ce := range rec.Collaborators {
			collabs = append(collabs, map[string]string{
				"account_id": ce.AccountID,
				"role":       string(ce.Role),
			})
		}
	}
	c.JSON(http.StatusOK, gin.H{"owner": owner, "collaborators": collabs})
}

// v1ShareRequest is the body for POST /v1/documents/:id/collaborators.
//
// Recipient identity may be given two ways (at least one required):
//   - Email   — resolved to a principal via the directory (Contract 2). For a
//     co-cloud account-only recipient this yields the local account to put in
//     the ACL. This is the preferred form for share-by-email.
//   - Account — a raw account id, kept for back-compat (the original contract).
//
// Role is the share-API vocabulary view/comment/edit (long forms accepted);
// it maps onto the canonical fileacl roles.
type v1ShareRequest struct {
	Email   string `json:"email"`   // recipient email (resolved via directory)
	Account string `json:"account"` // raw account id (back-compat)
	Role    string `json:"role"`    // view | comment | edit (default: edit)
	Revoke  bool   `json:"revoke"`  // true to remove access
}

// ShareDocument handles POST /v1/documents/:id/collaborators — grant or revoke
// another account's access. Only the owner (or an admin) may manage collaborators.
// Reuses the SAME ACL store + audit trail as /api.
//
// When the recipient is given by EMAIL, it is resolved through the directory
// (Contract 2) and routed by locality (Contract 3):
//   - CO-CLOUD recipient (account-only user hosted on this cell) → grant a
//     role-scoped per-document ACL entry, exactly as a raw account would.
//   - REMOTE recipient (box / other cell) → NOT a local ACL grant; respond 409
//     with a structured payload telling the caller to share via the
//     peering/peershare path (owned by the vulos peering agent).
func (h *V1Handler) ShareDocument(c *gin.Context) {
	id := c.Param("id")
	// Only the owner may grant or revoke access.
	if !h.authz.requireOwner(c, id) {
		return
	}
	if _, err := h.store.GetFile(id); err != nil {
		v1err(c, http.StatusNotFound, "document not found")
		return
	}
	var req v1ShareRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		v1err(c, http.StatusBadRequest, err.Error())
		return
	}

	// Resolve the recipient principal. An email is resolved via the directory;
	// a raw account id is used verbatim (back-compat). Exactly one is required.
	grantee, remote, ok := h.resolveRecipient(c, &req)
	if !ok {
		return // resolveRecipient already wrote the response
	}
	if remote != nil {
		// REMOTE recipient: the local ACL is the wrong path. Do NOT silently
		// no-op — tell the caller to route through peering/peershare.
		c.JSON(http.StatusConflict, gin.H{
			"error":   "recipient is not on this cell; share via peering",
			"code":    "remote_recipient",
			"routing": "peershare",
			"recipient": gin.H{
				"vula_id":      remote.VulaID,
				"server":       remote.Server,
				"display_name": remote.DisplayName,
			},
		})
		return
	}

	var err error
	action := audit.ActionACLGrant
	if req.Revoke {
		err = h.authz.Store().Unshare(id, grantee)
		action = audit.ActionACLRevoke
	} else {
		role := fileacl.NormalizeRole(req.Role)
		if role == fileacl.RoleNone {
			if strings.TrimSpace(req.Role) != "" {
				v1err(c, http.StatusBadRequest, "role must be 'view', 'comment', or 'edit'")
				return
			}
			role = fileacl.RoleEditor // default (back-compat)
		}
		if !fileacl.IsGrantableRole(role) {
			v1err(c, http.StatusBadRequest, "role must be 'view', 'comment', or 'edit'")
			return
		}
		err = h.authz.Store().ShareWithRole(id, grantee, role)
	}
	if err != nil {
		v1err(c, http.StatusInternalServerError, err.Error())
		return
	}
	recordAudit(h.audit, requesterID(c), action, id, "grantee="+grantee)
	c.JSON(http.StatusOK, gin.H{"ok": true, "grantee": grantee})
}

// resolveRecipient determines the ACL principal for a share request.
//
// Returns:
//   - grantee — the account id to grant/revoke in the local ACL (set only when
//     remote is nil and ok is true);
//   - remote  — non-nil when the resolved recipient lives off this cell and the
//     share must be routed via peershare instead of the local ACL;
//   - ok      — false when the request was already answered with an error
//     response (the caller must return immediately).
//
// Resolution rules:
//   - req.Email set → resolve via the directory (Contract 2). A co-cloud result
//     yields the recipient's account (its email; see note) as the grantee; a
//     remote result is returned via `remote`.
//   - else req.Account set → used verbatim (back-compat raw account id).
//   - neither → 400.
func (h *V1Handler) resolveRecipient(c *gin.Context, req *v1ShareRequest) (grantee string, remote *directory.DiscoveryResult, ok bool) {
	email := strings.TrimSpace(req.Email)
	account := strings.TrimSpace(req.Account)

	if email == "" {
		if account == "" {
			v1err(c, http.StatusBadRequest, "one of 'email' or 'account' is required")
			return "", nil, false
		}
		return account, nil, true
	}

	if h.dir == nil {
		// No directory configured (standalone): cannot resolve an email. Fall
		// back to a raw account id if one was also supplied; otherwise reject.
		if account != "" {
			return account, nil, true
		}
		v1err(c, http.StatusBadRequest, "email resolution is unavailable; supply 'account'")
		return "", nil, false
	}

	res, err := h.dir.LookupEmail(c.Request.Context(), email)
	switch {
	case err == nil:
		// resolved
	case errors.Is(err, directory.ErrNotFound):
		v1err(c, http.StatusNotFound, "no Vulos account for that email")
		return "", nil, false
	case errors.Is(err, directory.ErrUnavailable):
		if account != "" {
			return account, nil, true
		}
		v1err(c, http.StatusBadRequest, "email resolution is unavailable; supply 'account'")
		return "", nil, false
	default:
		// Transport / control-plane failure: fail closed (do not grant).
		log.Printf("[v1] directory lookup failed for email: %v", err)
		v1err(c, http.StatusBadGateway, "directory lookup failed")
		return "", nil, false
	}

	if !directory.CoCloud(res, h.localServer) {
		return "", &res, true
	}
	// CO-CLOUD account-only recipient: the local ACL principal is the account's
	// email (this deployment keys accounts by email — JWT subject == account
	// email, matching the entitlements account_id=<email> contract).
	return strings.ToLower(email), nil, true
}
