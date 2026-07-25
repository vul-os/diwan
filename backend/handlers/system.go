package handlers

// system.go — standalone, server-honest system surface for the self-hosted
// Settings/Admin UI.
//
//   GET  /api/system/info     runtime facts: version, storage backend, auth
//                             mode, registered-user count, integration mode,
//                             and the caller's identity / admin status.
//   POST /api/auth/password   authenticated self-service password change. Works
//                             against the per-user credential store; in legacy
//                             shared-password mode it returns an honest error
//                             pointing at config.yaml (no silent no-op).
//
// Everything reported here is derived from the live config + stores, never
// hardcoded, so a self-hoster sees what their instance is ACTUALLY doing.

import (
	"net/http"
	"os"
	"strings"

	"vulos-office/backend/config"
	"vulos-office/backend/middleware"
	"vulos-office/backend/storage"
	"vulos-office/backend/userauth"

	"github.com/gin-gonic/gin"
)

// EnvPublicURL is Office's OWN externally-reachable origin (e.g.
// https://office.vulos.org, or an Ephor tunnel URL when the box has no
// public IP). It is what P2P collab invite links and same-origin signaling must
// use INSTEAD of window.location.origin when a visitor loads Office over a
// LAN-only / private address. Unset ⇒ the client keeps using its own origin
// (correct for a directly-reachable standalone box).
const EnvPublicURL = "VULOS_OFFICE_PUBLIC_URL"

type SystemHandler struct {
	cfg     *config.Config
	version string
	// mode is the integration mode resolved at startup ("standalone" | "cloud").
	mode string
	// deployMode is the typed DEPLOY_MODE (standalone|os|cloud) resolved at boot.
	deployMode string
	creds      userauth.Store
}

func NewSystemHandler(cfg *config.Config, version, mode, deployMode string) *SystemHandler {
	return &SystemHandler{cfg: cfg, version: version, mode: mode, deployMode: deployMode, creds: SharedCredsStore()}
}

// PublicBaseURL returns Office's configured externally-reachable origin
// (VULOS_OFFICE_PUBLIC_URL), trimmed of a trailing slash, or "" when unset.
func PublicBaseURL() string {
	return strings.TrimRight(strings.TrimSpace(os.Getenv(EnvPublicURL)), "/")
}

// Reachability GET /api/reachability (unauthenticated — returns no secrets).
//
// The client's collab layer consumes this to learn Office's externally-reachable
// base URL so P2P invite links / signaling target a URL an external peer can
// actually reach, rather than blindly trusting window.location.origin (which may
// be a LAN-only address). When VULOS_OFFICE_PUBLIC_URL is unset the response's
// public_base_url is empty and the client falls back to its own origin.
//
// It also surfaces the OS-free P2P discovery facts (see docs/COLLABORATION.md §3
// for the three-way transport selection: host-box peering | any relayd
// rendezvous | local-only):
//
//   - `rendezvous_url` — the operator's configured relayd (config.yaml
//     `collab.rendezvous_url` / VULOS_RENDEZVOUS_URL). This is the origin the
//     BROWSER calls directly: relayd's rendezvous role serves CORS, so no
//     server of ours sits in the discovery path and Ofisi never sees the
//     signaling envelopes. Empty when unset, same contract as public_base_url —
//     the client MUST treat empty as "not available" rather than guessing a
//     default, which is what keeps a local-only deployment honestly local-only.
func (h *SystemHandler) Reachability(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"public_base_url": PublicBaseURL(),
		"deploy_mode":     h.deployMode,
		"rendezvous_url":  strings.TrimRight(strings.TrimSpace(h.cfg.Collab.RendezvousURL), "/"),
	})
}

// authMode classifies how login is enforced for this instance.
//   - "disabled"  auth.enabled is false (single-user / local mode)
//   - "per-user"  per-user credentials are registered (the modern path)
//   - "shared"    auth on, but only the legacy shared config.yaml password exists
func (h *SystemHandler) authMode() (mode string, userCount int64) {
	if !h.cfg.Auth.Enabled {
		return "disabled", 0
	}
	if h.creds != nil {
		if n, err := h.creds.CountUsers(); err == nil {
			userCount = n
			if n > 0 {
				return "per-user", n
			}
		}
	}
	return "shared", userCount
}

// Info GET /api/system/info
func (h *SystemHandler) Info(c *gin.Context) {
	mode, userCount := h.authMode()

	c.JSON(http.StatusOK, gin.H{
		"version":          h.version,
		"integration_mode": h.mode,          // "standalone" | "cloud" (seam adapter)
		"deploy_mode":      h.deployMode,    // "standalone" | "os" | "cloud" (typed)
		"served_from":      PublicBaseURL(), // this app's own externally-reachable origin (may be "")
		"account_id":       requesterID(c),
		"is_admin":         c.GetBool(middleware.CtxIsAdmin),
		"auth": gin.H{
			"enabled":    h.cfg.Auth.Enabled,
			"mode":       mode,
			"user_count": userCount,
		},
		"storage": gin.H{
			"backend":      h.cfg.Storage.Type, // "local" | "postgres"
			"data_dir":     h.cfg.Server.DataDir,
			"uploads_dir":  h.cfg.Server.UploadsDir,
			"object_store": storage.DescribeObjectStore(),
		},
	})
}

// ChangePassword POST /api/auth/password
//
//	body: { "current_password": "...", "new_password": "..." }
//
// Authenticated self-service: the session proves identity, and the current
// password is re-verified before the change (so a hijacked-but-idle session
// cannot silently rotate the credential). Per-user store only; shared-password
// mode is reported honestly rather than pretending to succeed.
func (h *SystemHandler) ChangePassword(c *gin.Context) {
	if !h.cfg.Auth.Enabled {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "authentication is disabled; this instance does not use passwords (set auth.enabled: true in config.yaml)",
		})
		return
	}

	var req struct {
		// Accept both "current_password"/"new_password" and the legacy single
		// "password" field so older clients degrade gracefully.
		CurrentPassword string `json:"current_password"`
		NewPassword     string `json:"new_password"`
		Password        string `json:"password"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}
	newPw := req.NewPassword
	if newPw == "" {
		newPw = req.Password
	}

	if h.creds == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "credential store unavailable"})
		return
	}
	hasUsers, err := h.creds.HasUsers()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "cannot determine credential state; try again"})
		return
	}
	if !hasUsers {
		// Legacy shared-password mode — there is no per-user credential to update.
		c.JSON(http.StatusConflict, gin.H{
			"error": "this instance uses the shared password from config.yaml (auth.password). " +
				"Change it there and restart, or register a per-user account to enable self-service password changes.",
		})
		return
	}

	subject := requesterID(c)
	if subject == "" || subject == "self" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "no authenticated account for this session"})
		return
	}

	// Re-verify the current password before allowing the change.
	if _, verr := h.creds.Verify(subject, req.CurrentPassword); verr != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "current password is incorrect"})
		return
	}
	if reason := passwordPolicyError(newPw); reason != "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": reason})
		return
	}

	switch err := h.creds.UpdatePassword(subject, newPw); err {
	case nil:
		recordAudit(SharedAuditStore(), subject, "auth.password_change", subject, "self-service")
		c.JSON(http.StatusOK, gin.H{"message": "password updated"})
	case userauth.ErrUserNotFound:
		c.JSON(http.StatusNotFound, gin.H{"error": "account not found"})
	default:
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update password"})
	}
}
