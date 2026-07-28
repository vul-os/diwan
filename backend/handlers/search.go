package handlers

// search.go — global full-text search across the caller's Office documents.
//
// ACL model (the whole point): a search must NEVER surface content the caller
// cannot already read. We enforce this at QUERY TIME by restricting the candidate
// set to files the requester can access, then extracting + matching text only
// over those. Two access sources are unioned, mirroring the List/SharedWithMe
// handlers exactly:
//
//   - AccessibleFileIDs(me): files the caller OWNS or has been explicitly shared.
//     This is keyed on the verified requester id, so it is per-account isolated
//     by construction — one account's grants can never widen another's results.
//   - Unowned/legacy files: included only when h.authz.canAccess allows it, which
//     is true in single-user/local (auth-disabled) mode and false in multi-tenant
//     mode. This preserves OSS local search without leaking pre-ACL files across
//     tenants.
//
// Because extraction runs only over the already-authorized set, there is no
// separate index that could drift out of sync with the ACL — the index IS the
// caller's accessible content, assembled fresh per query. Snippets are cut from
// that same authorized text, so a snippet can never expose a foreign document.

import (
	"net/http"
	"sort"
	"strings"

	"diwan/backend/docindex"
	"diwan/backend/middleware"
	"diwan/backend/storage"

	"github.com/gin-gonic/gin"
)

// SearchHandler serves GET /api/search?q=…&type=doc|sheet|slide.
type SearchHandler struct {
	store storage.Storage
	authz *FileAuthz
}

func NewSearchHandler(store storage.Storage) *SearchHandler {
	return &SearchHandler{store: store, authz: SharedFileAuthz()}
}

// NewSearchHandlerWithAuthz builds a handler over a caller-supplied authorizer
// (tests).
func NewSearchHandlerWithAuthz(store storage.Storage, authz *FileAuthz) *SearchHandler {
	return &SearchHandler{store: store, authz: authz}
}

// SearchResult is one hit in the response.
type SearchResult struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Type    string `json:"type"`
	Snippet string `json:"snippet"`
	Owner   string `json:"owner,omitempty"`
	// Shared is true when the caller accesses the file via a share (not owner).
	Shared bool `json:"shared"`
}

const (
	maxSearchResults = 50
	snippetWindow    = 48
)

// Search handles GET /api/search.
func (h *SearchHandler) Search(c *gin.Context) {
	query := strings.TrimSpace(c.Query("q"))
	if query == "" {
		c.JSON(http.StatusOK, gin.H{"results": []SearchResult{}, "query": ""})
		return
	}
	typeFilter := strings.TrimSpace(c.Query("type"))

	me := requesterID(c)
	isAdmin := c.GetBool(middleware.CtxIsAdmin)

	// Build the ACL-scoped candidate set. Owned + shared come from the caller's
	// own grants (per-account isolated). Admins and single-user/local mode may
	// additionally see unowned/legacy files, gated through canAccess below.
	candidates := map[string]bool{}
	if h.authz != nil && h.authz.Store() != nil {
		if ids, err := h.authz.Store().AccessibleFileIDs(me); err == nil {
			for id := range ids {
				candidates[id] = true
			}
		}
	}

	// For admins and single-user/local mode, canAccess also grants unowned files;
	// fold in every file the caller may access so local search stays complete. In
	// multi-tenant mode canAccess returns false for unowned files and for files
	// owned by others, so this loop adds nothing a non-admin shouldn't see.
	files, err := h.store.ListFiles()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if isAdmin || !h.authz.multiTenant() {
		for _, f := range files {
			if h.authz.canAccess(c, f.ID) {
				candidates[f.ID] = true
			}
		}
	}

	// Index files by id for a single pass.
	byID := make(map[string]int, len(files))
	for i, f := range files {
		byID[f.ID] = i
	}

	results := make([]SearchResult, 0, 16)
	for id := range candidates {
		idx, ok := byID[id]
		if !ok {
			continue // ACL row without a live file (deleted) — skip
		}
		f := files[idx]
		if typeFilter != "" && string(f.Type) != typeFilter {
			continue
		}
		// Defence in depth: re-verify access on the concrete file before reading
		// its content, so a stale ACL index entry can never leak content.
		if !h.authz.canAccess(c, f.ID) {
			continue
		}

		// Extract text and match. Also match the file NAME (title hits are common).
		text := docindex.ExtractText(f.Content)
		haystack := f.Name + "\n" + text
		snippet, hit := docindex.Match(haystack, query, snippetWindow)
		if !hit {
			continue
		}

		owner := ""
		shared := false
		if rec, recOK, _ := h.authz.Store().Get(f.ID); recOK {
			owner = rec.Owner
			shared = rec.Owner != me
		}
		results = append(results, SearchResult{
			ID:      f.ID,
			Name:    f.Name,
			Type:    string(f.Type),
			Snippet: snippet,
			Owner:   owner,
			Shared:  shared,
		})
	}

	// Deterministic order: owned-first, then by name.
	sort.Slice(results, func(i, j int) bool {
		if results[i].Shared != results[j].Shared {
			return !results[i].Shared // owned (shared=false) first
		}
		return strings.ToLower(results[i].Name) < strings.ToLower(results[j].Name)
	})
	if len(results) > maxSearchResults {
		results = results[:maxSearchResults]
	}

	c.JSON(http.StatusOK, gin.H{"results": results, "query": query})
}
