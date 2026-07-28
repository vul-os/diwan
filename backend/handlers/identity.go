package handlers

import (
	"diwan/backend/middleware"

	"github.com/gin-gonic/gin"
)

// requesterID returns the verified account id for the current request.
//
// Identity is derived from the JWT subject (set by middleware.Auth into the
// request context) — NOT from the client-supplied X-Account-ID header, which
// is forgeable. The header is honored only as an *admin impersonation* hint:
// an authenticated admin may act on behalf of another account by sending
// X-Account-ID. For everyone else the header is ignored.
//
// When auth is disabled (single-user / OSS self-host local mode) there is no
// token; we fall back to the local "self" identity so the app keeps working.
func requesterID(c *gin.Context) string {
	uid := c.GetString(middleware.CtxUserID)

	// Admin override: only a verified admin may impersonate via the header.
	if c.GetBool(middleware.CtxIsAdmin) {
		if hdr := c.GetHeader("X-Account-ID"); hdr != "" {
			return hdr
		}
	}

	// SSO session path (multi-user cloud): identity was resolved by introspecting
	// the vc_session cookie against the identity provider, which returned a
	// tenantId (= the account id). ALL data — ownership, ACLs, storage keys — is
	// scoped to the tenant so a user only ever sees their own tenant's data. The
	// tenant scope takes precedence over the raw user id for keying.
	if tenant := c.GetString(middleware.CtxTenantID); tenant != "" {
		return tenant
	}

	if uid != "" {
		return uid
	}

	// Auth disabled or no subject in token: local single-user identity.
	// (Never read X-Account-ID here — that would re-open the forgery hole.)
	if c.GetBool(middleware.CtxAuthenticated) {
		// Authenticated session but token had no subject — treat as the shared
		// local account rather than honoring a forgeable header.
		return "self"
	}
	return "self"
}

// isRequestAdmin reports whether the verified session carries the admin scope.
// Derived from the JWT (set by middleware.Auth), never a client header.
func isRequestAdmin(c *gin.Context) bool {
	return c.GetBool(middleware.CtxIsAdmin)
}

// isAuthorOrAdmin reports whether the current requester authored the resource
// (matched against the VERIFIED requester id) or is an admin. Used to gate
// mutate/delete of user-authored content (e.g. comment bodies) against IDOR
// where file-access alone is too coarse.
func isAuthorOrAdmin(c *gin.Context, authorID string) bool {
	return isRequestAdmin(c) || requesterID(c) == authorID
}
