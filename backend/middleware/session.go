package middleware

import (
	"net/http"

	"diwan/backend/config"
	"diwan/backend/session"

	"github.com/gin-gonic/gin"
)

// CtxAuthMethodSession is the CtxAuthMethod value set when identity was resolved
// via the SSO session-introspection path (a validated `vc_session` cookie).
const CtxAuthMethodSession = "sso-session"

// AuthWithSSO is the auth middleware for the protected /api group. It PRESERVES
// every existing path and ADDS an SSO session-introspection path:
//
//	precedence (first match wins):
//	  1. auth DISABLED (self-host single-user, IDENTITY_URL unset) → allow,
//	     local "self" identity. UNCHANGED.
//	  2. existing product-JWT session (Authorization: Bearer <jwt> or the
//	     "session" cookie), HS256-verified with DIWAN_JWT_SECRET. UNCHANGED.
//	  3. SSO session — a `vc_session` cookie, introspected against IDENTITY_URL
//	     (only when an introspector is wired). On {valid:true} the request is
//	     scoped to the resolved user + tenant. NEW.
//	  4. otherwise → 401.
//
// Fail-closed guarantee: when an introspector is configured (IDENTITY_URL set)
// and a `vc_session` cookie is present, an invalid/expired session OR a provider
// transport error yields 401 — Office NEVER falls open to a shared identity in
// multi-user mode.
//
// When intro is nil (IDENTITY_URL unset) step 3 is skipped entirely, so the
// self-host single-user / product-JWT behavior is byte-for-byte unchanged.
func AuthWithSSO(cfg *config.Config, intro session.Introspector) gin.HandlerFunc {
	base := Auth(cfg)
	return func(c *gin.Context) {
		// Step 1: auth disabled AND no SSO provider → the existing Auth()
		// short-circuits to the local "self" identity (self-host single-user —
		// UNCHANGED). When an SSO provider IS configured we do NOT fall through to
		// a shared local identity even if native auth is off: configuring
		// IDENTITY_URL is an explicit multi-user statement, so SSO is enforced.
		if !cfg.Auth.Enabled && intro == nil {
			base(c)
			return
		}

		// Step 2: try the existing product-JWT session first (only meaningful when
		// native auth is enabled), without letting its failure abort the request —
		// so we can fall through to the SSO path. We verify the token directly
		// (mirrors Auth) rather than invoking base(), because base() would
		// AbortWithStatusJSON on failure. Guarded by cfg.Auth.Enabled so an
		// SSO-only deployment (auth disabled) does not get the disabled-mode
		// "self" identity that SessionIdentity returns.
		if cfg.Auth.Enabled {
			if subject, isAdmin, ok := SessionIdentity(cfg, c.Request); ok {
				c.Set(CtxAuthenticated, true)
				c.Set(CtxUserID, subject)
				if isAdmin {
					c.Set(CtxIsAdmin, true)
				}
				c.Next()
				return
			}
		}

		// Step 3: SSO session-introspection path (only when IDENTITY_URL is set).
		if intro != nil {
			if resolveSSOSession(c, intro) {
				c.Next()
				return
			}
			// An introspector is configured. Fail closed: never fall through to a
			// shared/local identity in multi-user mode.
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "authentication required"})
			return
		}

		// No SSO configured and no valid product-JWT session → 401 (parity with
		// the original Auth()).
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "authentication required"})
	}
}

// resolveSSOSession reads the `vc_session` cookie, introspects it, and on
// {valid:true} sets the verified user + tenant into the gin context. It reports
// whether the request was authenticated.
//
// It returns false (caller fails closed) when: no cookie is present, the
// provider says invalid/expired, OR the provider could not be reached. It NEVER
// grants access on a transport error.
func resolveSSOSession(c *gin.Context, intro session.Introspector) bool {
	cookie, err := c.Request.Cookie(session.CookieName)
	if err != nil || cookie.Value == "" {
		return false
	}
	res, ierr := intro.Introspect(c.Request.Context(), cookie.Value)
	if ierr != nil {
		// Provider unreachable: fail closed rather than guess an identity.
		return false
	}
	if !res.Valid || res.UserID == "" {
		return false
	}
	c.Set(CtxAuthenticated, true)
	c.Set(CtxUserID, res.UserID)
	c.Set(CtxTenantID, res.TenantID)
	c.Set(CtxAuthMethod, CtxAuthMethodSession)
	// SSO users are never implicitly admins: admin is a distinct grant, not a
	// consequence of holding a valid session.
	return true
}
