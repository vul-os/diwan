package middleware

import (
	"net/http"
	"strings"

	"diwan/backend/config"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
)

// Context keys set by Auth so downstream handlers can read the verified
// identity. Handlers must read the user/account id from context — never from
// the client-supplied X-Account-ID header.
const (
	CtxAuthenticated = "authenticated"
	CtxUserID        = "userID"  // verified account id from the JWT subject
	CtxIsAdmin       = "isAdmin" // true if the JWT carries the admin scope
	// CtxTenantID is the tenant (account) scope the request is confined to when
	// identity was resolved via the SSO session-introspection path (multi-user
	// cloud). Empty in local single-identity mode and on the product-JWT / vk_
	// paths that pre-date multi-tenant SSO. Handlers scope data reads/writes by
	// this value so a user only ever sees their own tenant's data.
	CtxTenantID = "tenantID"
)

// Auth validates the session JWT, and on success sets the verified identity
// (CtxUserID) into the gin context from the token's Subject claim.
//
// When auth is disabled (cfg.Auth.Enabled == false) the request proceeds, but
// CtxUserID is left empty and CtxAuthenticated is false; handlers fall back to
// a safe "local single-user" identity in that mode.
func Auth(cfg *config.Config) gin.HandlerFunc {
	return func(c *gin.Context) {
		if !cfg.Auth.Enabled {
			c.Next()
			return
		}

		token := extractToken(c)
		if token == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "authentication required"})
			return
		}

		secret, err := JWTSecret()
		if err != nil {
			// Fail closed: no usable signing secret → reject all tokens.
			c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "server auth not configured"})
			return
		}

		claims := &jwt.RegisteredClaims{}
		parsed, perr := jwt.ParseWithClaims(token, claims, func(t *jwt.Token) (interface{}, error) {
			// Pin the signing method to HMAC to reject alg-confusion attacks.
			if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
				return nil, jwt.ErrTokenSignatureInvalid
			}
			return secret, nil
		})

		if perr != nil || !parsed.Valid {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid or expired session"})
			return
		}

		c.Set(CtxAuthenticated, true)
		// Derive identity from the verified token, NOT from any client header.
		c.Set(CtxUserID, claims.Subject)
		// Admin scope is conveyed via the "vulos:admin" audience entry.
		for _, aud := range claims.Audience {
			if aud == "vulos:admin" {
				c.Set(CtxIsAdmin, true)
				break
			}
		}
		c.Next()
	}
}

// SessionIdentity verifies Office's session on a RAW *http.Request (not a gin
// context) and returns the account subject and admin flag. It is the bridge the
// shared Apps & Bots platform uses for its management API: that handler set is a
// plain net/http handler, and this lets it reuse Office's existing session auth
// (Authorization: Bearer <jwt> or the HttpOnly "session" cookie).
//
// When auth is DISABLED (single-user / OSS self-host) there is no token; the
// local operator is the sole user and is treated as an authenticated admin so
// the apps place is manageable. When auth is ENABLED an invalid/absent/expired
// session returns ok=false (the platform then responds 401).
func SessionIdentity(cfg *config.Config, r *http.Request) (subject string, isAdmin bool, ok bool) {
	if !cfg.Auth.Enabled {
		return "self", true, true
	}
	token := tokenFromRequest(r)
	if token == "" {
		return "", false, false
	}
	secret, err := JWTSecret()
	if err != nil {
		return "", false, false
	}
	claims := &jwt.RegisteredClaims{}
	parsed, perr := jwt.ParseWithClaims(token, claims, func(t *jwt.Token) (interface{}, error) {
		// Pin HMAC to reject alg-confusion attacks (mirrors Auth()).
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, jwt.ErrTokenSignatureInvalid
		}
		return secret, nil
	})
	if perr != nil || !parsed.Valid {
		return "", false, false
	}
	for _, aud := range claims.Audience {
		if aud == "vulos:admin" {
			isAdmin = true
			break
		}
	}
	return claims.Subject, isAdmin, true
}

// tokenFromRequest extracts the session token from a raw *http.Request, using
// the same precedence as extractToken (Authorization bearer, then the session
// cookie). The ?token= query path is intentionally NOT honored.
func tokenFromRequest(r *http.Request) string {
	if auth := r.Header.Get("Authorization"); strings.HasPrefix(auth, "Bearer ") {
		return strings.TrimPrefix(auth, "Bearer ")
	}
	if c, err := r.Cookie("session"); err == nil {
		return c.Value
	}
	return ""
}

func extractToken(c *gin.Context) string {
	// Check Authorization header
	if auth := c.GetHeader("Authorization"); strings.HasPrefix(auth, "Bearer ") {
		return strings.TrimPrefix(auth, "Bearer ")
	}
	// Check cookie
	if cookie, err := c.Cookie("session"); err == nil {
		return cookie
	}
	// NOTE: the ?token= query-param path was intentionally REMOVED. JWTs in the
	// URL leak into server/proxy access logs, browser history, and Referer
	// headers, so the session token is accepted only via the Authorization
	// header or the HttpOnly session cookie.
	return ""
}
