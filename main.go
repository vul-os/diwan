package main

import (
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"vulos-office/backend/apikey"
	"vulos-office/backend/billing"
	"vulos-office/backend/config"
	"vulos-office/backend/deploymode"
	"vulos-office/backend/handlers"
	"vulos-office/backend/integration/cloud"
	"vulos-office/backend/middleware"
	"vulos-office/backend/obs"
	"vulos-office/backend/seam"
	"vulos-office/backend/session"
	"vulos-office/backend/storage"
	"vulos-office/backend/updatelog"
	"vulos-office/backend/userauth"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
)

// Version is set at build time via -ldflags "-X main.Version=vX.Y.Z".
// It defaults to "dev" for local builds.
var Version = "dev"

//go:embed all:dist
var distFS embed.FS

func main() {
	// One-shot CLI subcommand: migrate a legacy shared-password deploy to a
	// per-user credential so an upgrade doesn't silently lock everyone out.
	//
	//   vulos-office migrate-credential -admin you@vulos.org [-password PW]
	//
	// If -password is omitted the shared password from config.yaml (auth.password)
	// is used. Safe to run repeatedly: it is a no-op once any user exists.
	if len(os.Args) > 1 && os.Args[1] == "migrate-credential" {
		runMigrateCredential(os.Args[2:])
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "migrate" {
		runMigrate(os.Args[2:])
		return
	}
	if len(os.Args) > 1 && (os.Args[1] == "--version" || os.Args[1] == "version") {
		fmt.Println(Version)
		return
	}

	// CLI flags for the server process.
	noRateLimitWrites := flag.Bool("no-rate-limit-writes", false,
		"disable token-bucket rate limiting on write/collab endpoints (for testing or trusted environments)")
	configPath := flag.String("config", "config.yaml", "path to config file")
	flag.Parse()

	log.Printf("vulos-office %s starting", Version)
	obs.Init()

	// Typed DEPLOY_MODE (standalone|os): read once, validate coherent config,
	// self-report at boot. Formalizes what Office previously inferred from
	// scattered env (VULOS_CP_BASE_URL / VULOS_STORAGE_BROKER_SECRET / TIGRIS_*).
	// Never fails the boot — an invalid value degrades to the safe Standalone
	// default with a logged warning. Blob I/O is the gateway-header seam (os) or
	// the process-wide local client (standalone); see backend/handlers/bucket_store.go.
	mode := deploymode.Load()

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Printf("Config error: %v — using defaults", err)
		cfg = config.Default()
	}

	// Fail closed: when auth is enabled, refuse to start unless a JWT signing
	// secret is configured (VULOS_OFFICE_JWT_SECRET, or VULOS_OFFICE_DEV=1 for
	// local development). This prevents shipping with a predictable key.
	if cfg.Auth.Enabled && !middleware.JWTSecretConfigured() {
		log.Fatalf("auth is enabled but no JWT signing secret is configured: set %s "+
			"to a strong random value (or %s=1 for local dev)",
			middleware.EnvJWTSecret, middleware.EnvDevMode)
	}

	store, err := storage.New(cfg)
	if err != nil {
		log.Fatal("Storage init failed:", err)
	}

	// Calendar + Contacts are bring-your-own PIM via lilmail (CalDAV/CardDAV,
	// /v1/calendar + /v1/contacts). Office is documents-only; their durable
	// stores never lived here.

	// ── Org-bucket object store ───────────────────────────────────────────────
	// ResolveOrgBucket reads VULOS_ORG_ID (cloud-injected org identifier) and
	// scopes all object keys by org/account. If the env is absent the binary
	// still boots and logs a warning (OSS self-host, no cloud required).
	storage.InitOrgBucket()

	// ── Integration seam ──────────────────────────────────────────────────────
	// office runs COMPLETELY STANDALONE by default: identity is verified against
	// office's local JWT secret, entitlements are unlimited (self-host), and
	// usage metering is a no-op. An optional gateway the owner configures is
	// only engaged when VULOS_CP_BASE_URL is set — the core never imports the
	// cloud adapter, so removing it cannot break the standalone build.
	provider := seam.NewStandaloneProvider(middleware.JWTSecret, cfg.Auth.Enabled)
	integrationMode := "standalone"
	if cloud.Enabled() {
		ccfg := cloud.FromEnv()
		provider = cloud.NewProvider(ccfg, provider.Identity)
		integrationMode = "cloud"
		log.Printf("[seam] integration mode: cloud (control plane %s)", ccfg.BaseURL)
	} else {
		log.Printf("[seam] integration mode: standalone (no control plane)")
	}
	// Install the active provider into the billing enforcement layer so handlers
	// gate billable actions (storage, seats, office access) and emit usage. In
	// standalone mode this is a no-op (unlimited, never suspended). The billing
	// package imports only backend/seam, never the cloud adapter.
	billing.Configure(provider)

	// ── SSO session-introspection seam ────────────────────────────────────────
	// Wedge-aligned identity: Office holds NO session-signing power. When
	// IDENTITY_URL is set (multi-user cloud, or a sovereign box brokering many
	// users) Office INTROSPECTS the `vc_session` cookie against that provider,
	// presenting the SAME shared service secret it already holds for the CP
	// (VULOS_CP_TOKEN == the provider's CP_SHARED_SECRET). When IDENTITY_URL is
	// UNSET (self-host single-user appliance) this path is DISABLED and Office
	// keeps its existing local single-identity behavior — unchanged.
	sessCfg := session.FromEnv()
	sessionIntrospector := session.NewIntrospector(sessCfg)
	if sessionIntrospector != nil {
		log.Printf("[sso] session introspection enabled (identity provider %s)", sessCfg.IdentityURL)
	} else {
		log.Printf("[sso] session introspection disabled (no %s); local single-identity mode", session.EnvIdentityURL)
	}

	// ── Hosted-mode boot gate (fail-closed) ───────────────────────────────────
	// A hosted deployment (DEPLOY_MODE=os) MUST come up with an authenticated
	// posture. The protected/write route groups below install auth middleware ONLY
	// when (cfg.Auth.Enabled || sessionIntrospector != nil); with neither, a hosted
	// process would boot with NO auth wall and every caller would resolve to the
	// single shared "self" identity — a silent fail-open. RequireAuthPosture
	// refuses that here (fatal), naming the missing config. Standalone is unaffected.
	// Passed the EXACT condition the route groups gate on.
	if err := mode.RequireAuthPosture(cfg.Auth.Enabled, sessionIntrospector != nil); err != nil {
		log.Fatalf("[deploymode] %v", err)
	}

	gin.SetMode(gin.ReleaseMode)
	r := gin.Default()

	// CORS: prefer an explicit origin allowlist (VULOS_OFFICE_CORS_ORIGINS, a
	// comma-separated list) so credentialed cross-origin requests are restricted
	// to trusted front-ends. When unset we fall back to AllowAllOrigins WITHOUT
	// credentials (the SPA is same-origin embedded, so this is safe for self-host
	// and avoids a wildcard-with-credentials misconfiguration).
	corsCfg := cors.Config{
		AllowMethods: []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowHeaders: []string{"Origin", "Content-Type", "Authorization", "X-Registration-Token", "X-Account-ID"},
		// An export that could not carry everything says so in these headers (see
		// backend/handlers/export_warnings.go). They must be EXPOSED or a browser
		// caller cannot read them — and a warning nobody can read is a silent loss.
		ExposeHeaders: []string{"Content-Disposition", "X-Export-Fidelity", "X-Export-Warnings"},
	}
	if raw := strings.TrimSpace(os.Getenv("VULOS_OFFICE_CORS_ORIGINS")); raw != "" {
		var origins []string
		for _, o := range strings.Split(raw, ",") {
			if o = strings.TrimSpace(o); o != "" {
				origins = append(origins, o)
			}
		}
		corsCfg.AllowOrigins = origins
		corsCfg.AllowCredentials = true
		log.Printf("[cors] explicit origin allowlist: %v (credentials allowed)", origins)
	} else {
		corsCfg.AllowAllOrigins = true // no credentials → safe wildcard
		log.Printf("[cors] no VULOS_OFFICE_CORS_ORIGINS set; allowing all origins WITHOUT credentials")
	}
	r.Use(cors.New(corsCfg))

	// Prometheus metrics (no auth required).
	r.GET("/metrics", gin.WrapH(obs.Handler()))

	// Build-time version (no auth required).
	r.GET("/version", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"version": Version})
	})

	// Health check for load-balancers and status pages (no auth required).
	// Returns 200 {"status":"ok","version":"<build-time version>"} when the
	// server is alive. Does NOT probe the database; use /metrics for depth.
	r.GET("/healthz", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok", "version": Version})
	})

	// Auth routes (unauthenticated)
	authHandler := handlers.NewAuthHandler(cfg)
	api := r.Group("/api")
	// Rate-limit login: bcrypt on an unthrottled endpoint is an online brute-force
	// oracle. 5 attempts / minute per IP blunts credential-stuffing while allowing
	// legitimate users to retry after a typo. Matches the password-change limiter.
	loginLimiter := middleware.NewRateLimiter(5, time.Minute)
	api.POST("/auth/login", loginLimiter.Middleware(), authHandler.Login)
	api.POST("/auth/register", authHandler.Register)
	api.POST("/auth/logout", authHandler.Logout)
	api.GET("/auth/status", authHandler.Status)

	// Protected API routes.
	//
	// AuthWithSSO preserves the existing product-JWT session gate and, when
	// IDENTITY_URL is configured, ADDS the SSO `vc_session` introspection path
	// (fail-closed). When auth is disabled AND no SSO provider is set it is a
	// no-op passthrough (self-host single-user — unchanged), so we only install
	// it when at least one identity source is active.
	protected := api.Group("/")
	if cfg.Auth.Enabled || sessionIntrospector != nil {
		protected.Use(middleware.AuthWithSSO(cfg, sessionIntrospector))
	}

	// Write/collab sub-group — same auth middleware as protected, plus a
	// token-bucket rate limiter on every state-changing endpoint.
	//
	// Default: 30-request burst, refills at 10 requests/second per client IP.
	// This throttles rapid automated writes (bulk import, bot abuse) while
	// leaving normal human editing (save-on-keyup, comment spam) unaffected.
	// Disable with --no-rate-limit-writes for trusted internal tooling.
	writes := api.Group("/")
	if cfg.Auth.Enabled || sessionIntrospector != nil {
		writes.Use(middleware.AuthWithSSO(cfg, sessionIntrospector))
	}
	if !*noRateLimitWrites {
		writeLimiter := middleware.NewTokenBucket(30, 10)
		writes.Use(writeLimiter.Middleware())
		log.Printf("[rate-limit] write/collab endpoints: token-bucket cap=30 rate=10/s per IP")
	} else {
		log.Printf("[rate-limit] write/collab rate limiting disabled (--no-rate-limit-writes)")
	}

	// The shells' auth boundary (RequireAuth.jsx) — behind the SAME gate the rest
	// of the protected surface uses, so its 401 means exactly what the server
	// means by "not authenticated" (product JWT OR CP session/app token).
	protected.GET("/auth/me", authHandler.Me)

	// Standalone system surface: honest runtime facts for the self-hosted
	// Settings/Admin UI, plus authenticated self-service password change.
	systemHandler := handlers.NewSystemHandler(cfg, Version, integrationMode, mode.String())
	protected.GET("/system/info", systemHandler.Info)
	// Reachability: Office's own externally-reachable base URL (public origin, or
	// a relay-tunnel URL when the box is behind NAT). UNAUTHENTICATED — it returns
	// no secrets, only the public base + deploy mode — so the collab layer can
	// resolve a reachable base for P2P invite links before/around auth.
	api.GET("/reachability", systemHandler.Reachability)
	// OS-free P2P discovery needs no route here: the browser calls the
	// operator-configured vulos-relayd's rendezvous surface DIRECTLY, using the
	// `rendezvous_url` that /api/reachability reports. Ofisi carried a
	// same-origin pass-through proxy for exactly as long as relayd's rendezvous
	// role sent no CORS headers; it does now, so the server is out of that path
	// entirely and never sees the discovery envelopes. See
	// docs/COLLABORATION.md §3.
	//
	// Rate-limit the self-service password change: it re-verifies the CURRENT
	// password, so without a limit it is an online brute-force oracle. 5
	// attempts/minute per client IP is ample for a human while blunting
	// automated guessing.
	pwLimiter := middleware.NewRateLimiter(5, time.Minute)
	protected.POST("/auth/password", pwLimiter.Middleware(), systemHandler.ChangePassword)

	// Pin the file-ACL authorizer to the active storage backend BEFORE any file
	// handler is constructed. Under Postgres this co-locates ACL ownership in the
	// same DB as the files (transactional + replicated); under sqlite/local it
	// uses the separate sqlite ACL store.
	//
	// The second argument is the MULTI-TENANT posture, NOT native-auth alone. It
	// must track WHICHEVER identity source is active — the exact condition that
	// gates the AuthWithSSO/V1Auth middleware above (cfg.Auth.Enabled ||
	// sessionIntrospector != nil). In SSO-only mode native product-JWT auth is
	// OFF (cfg.Auth.Enabled == false) but the session introspector IS wired, so
	// the deployment is fully multi-tenant. Passing cfg.Auth.Enabled alone here
	// would leave FileAuthz in a single-user fail-OPEN posture (unrecorded/legacy
	// docs readable cross-tenant, viewer→editor/owner role checks skipped, and a
	// degraded ACL store silently fail-open) — a cross-tenant isolation collapse.
	// Initializes the process-wide per-file authorizer (defaultFileAuthz global
	// used by the file handlers); the returned instance is not needed here.
	handlers.InitFileAuthz(store, cfg.Auth.Enabled || sessionIntrospector != nil)

	fileHandler := handlers.NewFileHandler(store)
	protected.GET("/files", fileHandler.List)
	// "Shared with me" — files shared TO the caller (owned excluded). Registered
	// under a distinct prefix to avoid a route conflict with /files/:id.
	protected.GET("/shared-files", fileHandler.SharedWithMe)
	protected.GET("/files/:id", fileHandler.Get)
	writes.POST("/files", fileHandler.Create)
	writes.PUT("/files/:id", fileHandler.Update)
	writes.DELETE("/files/:id", fileHandler.Delete)
	// Parity: file organization — move into a folder / star / trash-toggle.
	writes.POST("/files/:id/move", fileHandler.Move)
	// Parity: collaborator roster for @-mention autocomplete.
	protected.GET("/files/:id/collaborators", fileHandler.Collaborators)
	// Per-file sharing (owner/admin grants or revokes another account's access).
	writes.POST("/files/:id/share", fileHandler.Share)

	// ── CRDT-native persistence, phase 1 (persistence.updatelog) ──────────────
	// The per-file append-only CRDT update log — the durability model that
	// supersedes "single blob + 409 CAS": every CRDT frame (opaque, encrypted-
	// or-plain Yjs / sheet / slide update) is kept, so divergent offline edits
	// merge with nothing discarded (see backend/updatelog). Registered ONLY when
	// the flag is on; the whole-doc PUT above always keeps working, and the
	// frontend dual-writes during the transition. Filesystem-backed for phase 1
	// (data/updates/<id>/), independent of the primary storage backend.
	if cfg.Persistence.UpdateLog {
		// Store selection MIRRORS the primary storage backend so the update log
		// lives wherever the documents do:
		//   • postgres storage → Postgres update-log (shares the office schema +
		//     pool; append/prune are transactional with a per-file advisory lock).
		//   • local / S3 storage → filesystem LocalStore under data/updates/<id>/.
		//     (S3 has no append-with-monotonic-seq primitive, so the durable frame
		//     log stays on local disk; the whole-doc PUT still writes through to the
		//     bucket for the object copy.)
		var ulStore updatelog.Store
		var ulWhere string
		if pg, ok := store.(*storage.PostgresStorage); ok {
			s, err := updatelog.NewPostgresStore(pg.Pool())
			if err != nil {
				log.Fatalf("[persistence] failed to open Postgres update log: %v", err)
			}
			ulStore = s
			ulWhere = "Postgres (office.file_updates / office.file_update_snapshots)"
		} else {
			dir := filepath.Join(cfg.Server.DataDir, "updates")
			s, err := updatelog.NewLocalStore(dir)
			if err != nil {
				log.Fatalf("[persistence] failed to open update log: %v", err)
			}
			ulStore = s
			ulWhere = "filesystem under " + dir
		}
		ulHandler := handlers.NewUpdateLogHandler(ulStore, store)
		protected.GET("/files/:id/updates", ulHandler.List)
		writes.POST("/files/:id/updates", ulHandler.Append)
		log.Printf("[persistence] CRDT update-log ENABLED (append-only frames, backend: %s)", ulWhere)
	}

	// Parity: folder tree (per-account, ACL-owned like files).
	folderHandler := handlers.NewFolderHandler(store)
	protected.GET("/folders", folderHandler.List)
	writes.POST("/folders", folderHandler.Create)
	writes.PUT("/folders/:id", folderHandler.Update)
	writes.POST("/folders/:id/trash", folderHandler.Trash)
	writes.DELETE("/folders/:id", folderHandler.Delete)

	// OFFICE-08: version history endpoints.
	versionHandler := handlers.NewVersionHandler(store)
	protected.GET("/files/:id/versions", versionHandler.ListVersions)
	writes.POST("/files/:id/versions/:vid/restore", versionHandler.RestoreVersion)
	// Version diff (readable for Docs, coarse summary for Sheets/Slides). Read-only.
	protected.GET("/files/:id/versions/:vid/diff", versionHandler.Diff)

	// Global full-text search across the caller's ACL-scoped documents. Query time
	// ACL enforcement (owned + shared only); no cross-account content leak.
	searchHandler := handlers.NewSearchHandler(store)
	protected.GET("/search", searchHandler.Search)

	// Expiring / password-protected read-only share links + transfer ownership.
	shareLinkHandler := handlers.NewShareLinkHandler(store)
	protected.GET("/files/:id/share-links", shareLinkHandler.List)
	writes.POST("/files/:id/share-links", shareLinkHandler.Create)
	writes.DELETE("/files/:id/share-links/:lid", shareLinkHandler.Revoke)
	writes.POST("/files/:id/transfer-owner", fileHandler.TransferOwner)
	// Anonymous, token-gated, READ-ONLY document view (no auth — the token IS the
	// credential). GET returns metadata (and content when no password); POST with
	// the password returns content for password-gated links.
	//
	// The POST path calls bcrypt.CompareHashAndPassword on the link password. It is
	// UNAUTHENTICATED, so without a limit it is an online brute-force oracle against
	// the share-link password — exactly the risk /auth/login and /auth/password
	// already guard against. Rate-limit the POST per client IP (10/min), matching
	// those sensitive endpoints. GET is NOT password-bearing (its content is gated
	// by the 256-bit token capability, not a guessable secret), so it is left
	// unthrottled to avoid falsely blocking many legitimate viewers behind one NAT.
	shareViewLimiter := middleware.NewRateLimiter(10, time.Minute)
	api.GET("/share/:token", shareLinkHandler.ViewMeta)
	api.POST("/share/:token", shareViewLimiter.Middleware(), shareLinkHandler.View)

	// OFFICE-28: activity feed + named snapshots.
	activityHandler := handlers.NewActivityHandler(store)
	protected.GET("/files/:id/activity", activityHandler.GetActivity)
	writes.POST("/files/:id/versions", activityHandler.CreateNamedSnapshot)
	writes.PUT("/files/:id/versions/:vid/label", activityHandler.LabelVersion)

	// OFFICE-26: comments (anchored, threaded, resolvable).
	commentHandler := handlers.NewCommentHandler(store)
	protected.GET("/files/:id/comments", commentHandler.List)
	writes.POST("/files/:id/comments", commentHandler.Create)
	writes.PUT("/files/:id/comments/:cid", commentHandler.Update)
	writes.DELETE("/files/:id/comments/:cid", commentHandler.Delete)
	writes.POST("/files/:id/comments/:cid/replies", commentHandler.CreateReply)
	writes.PUT("/files/:id/comments/:cid/replies/:rid", commentHandler.UpdateReply)
	writes.DELETE("/files/:id/comments/:cid/replies/:rid", commentHandler.DeleteReply)

	// Parity: in-app notifications (surfaces @-mentions to the mentioned user).
	notificationHandler := handlers.NewNotificationHandler()
	protected.GET("/notifications", notificationHandler.List)
	writes.POST("/notifications/read-all", notificationHandler.MarkAllRead)
	writes.POST("/notifications/:id/read", notificationHandler.MarkRead)

	// OFFICE-27: suggestion / track-changes mode.
	suggestionHandler := handlers.NewSuggestionHandler(store)
	protected.GET("/files/:id/suggestions", suggestionHandler.List)
	writes.POST("/files/:id/suggestions", suggestionHandler.Create)
	writes.PUT("/files/:id/suggestions/:sid", suggestionHandler.Update)
	writes.DELETE("/files/:id/suggestions/:sid", suggestionHandler.Delete)

	// Docs export: PDF + DOCX server-side generation.
	docsExportHandler := handlers.NewDocsExportHandler(store)
	protected.GET("/files/:id/export", docsExportHandler.Export)

	// ── Public /v1 developer API ──────────────────────────────────────────────
	// A clean, documented JSON REST surface over the SAME document engine (storage,
	// FileAuthz, billing gates, export services). It authenticates with EITHER the
	// existing Office session OR a `Authorization: Bearer vk_…` API key validated
	// via the cloud introspection seam (POST {CP}/api/keys/introspect). The key
	// path is enabled only when VULOS_CP_BASE_URL is configured; otherwise /v1
	// falls back to session-only auth (self-host unchanged). See docs/API.md.
	keyCfg := apikey.FromEnv()
	v1Introspector := apikey.NewIntrospector(keyCfg)
	if v1Introspector != nil {
		log.Printf("[v1] API-key introspection enabled (control plane %s)", keyCfg.BaseURL)
	} else {
		log.Printf("[v1] API-key path disabled (no %s); /v1 uses session auth only", apikey.EnvCPBaseURL)
	}
	v1Handler := handlers.NewV1Handler(store)
	v1 := r.Group("/v1")
	v1.Use(middleware.V1Auth(cfg, v1Introspector, sessionIntrospector))
	// Reads.
	v1.GET("/documents", v1Handler.ListDocuments)
	v1.GET("/documents/:id", v1Handler.GetDocument)
	v1.GET("/documents/:id/content", v1Handler.GetContent)
	v1.GET("/documents/:id/collaborators", v1Handler.ListCollaborators)
	// NOTE (collab architecture): Office collaboration is ALWAYS peer-to-peer —
	// Yjs CRDT updates carried over WebRTC data channels (direct, STUN-assisted),
	// end-to-end encrypted, with a content-blind relay only as a NAT-traversal
	// fallback. There is deliberately NO central document server: this binary
	// hosts no op-relay, no doc-state hub, and no server-mediated collab endpoint.
	// The only server role in collaboration is lightweight, content-blind peer
	// DISCOVERY (signaling + ICE), which the Vulos OS host supplies at
	// /api/peering/* — never document content. See src/lib/crdt/yP2PSession.js.
	// Writes (rate-limited alongside the rest of the write surface).
	if !*noRateLimitWrites {
		v1.Use(middleware.NewTokenBucket(30, 10).Middleware())
	}
	v1.POST("/documents", v1Handler.CreateDocument)
	v1.PATCH("/documents/:id", v1Handler.PatchDocument)
	v1.DELETE("/documents/:id", v1Handler.DeleteDocument)
	v1.POST("/documents/:id/export", v1Handler.ExportDocument)
	v1.POST("/documents/:id/collaborators", v1Handler.ShareDocument)

	uploadHandler := handlers.NewUploadHandler(cfg)
	writes.POST("/upload", uploadHandler.Upload)
	api.GET("/uploads/:filename", uploadHandler.Serve)

	// Local-files browse/serve exposes the SERVER PROCESS's own ~/Documents,
	// ~/Downloads and ~/Desktop. That is a convenience for a single-user /
	// standalone self-host (the operator browsing their own machine), but in a
	// multi-tenant deploy (auth enabled) it would let ANY authenticated user read
	// the operator's personal files. Register these routes ONLY when auth is
	// disabled (standalone single-user mode); when auth is enabled they are
	// intentionally absent (404).
	if !cfg.Auth.Enabled {
		localFilesHandler := handlers.NewLocalFilesHandler()
		protected.GET("/local-files", localFilesHandler.Scan)
		protected.GET("/local-files/serve", localFilesHandler.Serve)
	} else {
		log.Printf("[local-files] auth enabled (multi-tenant): local-files browse/serve routes disabled to avoid cross-tenant exposure of the server's home directory")
	}

	// Team chat + huddles ("Spaces") are not an Office feature. Per the VulOS
	// product standard, comms are third-party (Matrix/Element for chat,
	// Element Call/Jitsi for video) — Office neither hosts nor proxies them.

	// OFFICE-41: envelope CRUD (field-placement setup).
	envelopeHandler := handlers.NewEnvelopeHandler(store)
	protected.GET("/envelopes", envelopeHandler.List)
	protected.GET("/envelopes/:id", envelopeHandler.Get)
	writes.POST("/envelopes", envelopeHandler.Create)
	writes.PUT("/envelopes/:id", envelopeHandler.Update)
	writes.DELETE("/envelopes/:id", envelopeHandler.Delete)

	// OFFICE-42: signing link generation + scoped signer view.
	// Send is protected (only the document owner can issue tokens).
	// GetSignerView and Complete are public — no Vulos account required.
	//
	// All /sign/:id routes share a single wildcard param name "id" to avoid gin's
	// "conflicting wildcard" panic — handlers distinguish tokens from envelope IDs
	// by value format (tokens are long UUIDs; envelope IDs are short strings).
	signingHandler := handlers.NewSigningHandler(store)
	writes.POST("/sign/:id/send", signingHandler.Send)
	api.GET("/sign/:id", signingHandler.GetSignerView)
	// OFFICE-43: signer ceremony submission.
	api.POST("/sign/:id/complete", signingHandler.Complete)

	// OFFICE-45: multi-signer orchestration + reminders.
	orchHandler := handlers.NewOrchestrationHandler(store)
	api.GET("/sign/:id/status", orchHandler.Status)
	writes.POST("/sign/:id/remind", orchHandler.Remind)
	writes.POST("/sign/:id/cancel", orchHandler.Cancel)
	api.POST("/sign/:id/decline", orchHandler.Decline)

	// OFFICE-46: sealed PDF download + audit manifest.
	// Protected: only the document owner/authenticated users may download.
	sealHandler := handlers.NewSealHandler(store, cfg.Server.UploadsDir)
	protected.GET("/sign/:id/download", sealHandler.Download)
	protected.GET("/sign/:id/manifest", sealHandler.Manifest)

	// OFFICE-47: signature + audit verification tool (public — no auth required).
	verifyHandler := handlers.NewVerifyHandler(store)
	api.POST("/sign/verify", verifyHandler.Verify)
	// PublicKey — expose server Ed25519 public key for independent token verification.
	api.GET("/sign/pubkey", verifyHandler.PublicKey)

	// SLIDES-07: slide deck PDF/PPTX export.
	slidesExportHandler := handlers.NewSlidesExportHandler(store)
	protected.GET("/slides/:id/export", slidesExportHandler.Export)

	// Sheets XLSX import/export endpoints.
	sheetsHandler := handlers.NewSheetsHandler(store)
	writes.POST("/sheets/:id/import", sheetsHandler.Import)
	protected.GET("/sheets/:id/export", sheetsHandler.Export)

	// Calendar + Contacts are bring-your-own PIM via lilmail (CalDAV/CardDAV,
	// /v1/calendar + /v1/contacts). Office does not serve /calendar/* or
	// /contacts/* — it is documents-only.

	// Admin: invite-token issuance (mint/list/revoke) + audit-log viewer.
	// Every handler additionally enforces the admin scope (requireAdmin).
	adminHandler := handlers.NewAdminHandler()
	writes.POST("/admin/invites", adminHandler.MintInvite)
	protected.GET("/admin/invites", adminHandler.ListInvites)
	writes.DELETE("/admin/invites/:id", adminHandler.RevokeInvite)
	protected.GET("/admin/audit", adminHandler.ListAudit)

	// NOTE: presence/channels/DMs/threads/messages and meeting APIs are not
	// served by Office. Per the VulOS product standard, chat and video are
	// third-party (Matrix/Element, Element Call/Jitsi) — Office neither hosts
	// nor redirects to them.

	// Serve embedded frontend (SPA fallback to index.html)
	staticFS, err := fs.Sub(distFS, "dist")
	if err != nil {
		log.Fatal("Failed to create static FS:", err)
	}
	mountStatic(r, staticFS)

	addr := cfg.Server.Addr
	if addr == "" {
		addr = ":8080"
	}

	log.Printf("Ofisi running → http://localhost%s", addr)
	if err := r.Run(addr); err != nil {
		log.Fatal(err)
	}
}

// isJSONAPIPath reports whether a request path belongs to a JSON API surface
// (the SPA's /api, the public /v1 developer API) rather than to the front-end.
// Those surfaces must never be answered with the SPA's index.html: a client
// reading "200 text/html" as success turns a missing, mistyped or
// method-mismatched route into a silent fail-OPEN.
func isJSONAPIPath(p string) bool {
	for _, prefix := range []string{"/api", "/v1"} {
		if p == prefix || strings.HasPrefix(p, prefix+"/") {
			return true
		}
	}
	return false
}

// mountStatic serves the embedded front-end: real files when they exist, the
// SPA's index.html for client-router paths — but a JSON 404/405 for the API
// surfaces, which own their own error shape.
func mountStatic(r *gin.Engine, staticFS fs.FS) {
	// Owned here, next to the NoMethod handler it exists to reach: without the
	// flag the router answers a method mismatch out of NoRoute, which would send
	// POST /api/auth/status to the SPA as 200 text/html. Gin reads it per request,
	// so setting it after the routes are registered is fine.
	r.HandleMethodNotAllowed = true

	staticServer := http.FileServer(http.FS(staticFS))

	serveSPA := func(c *gin.Context) {
		// fs.FS requires paths without a leading slash.
		// Strip it before probing, then let http.FileServer handle the request
		// (which re-adds the slash internally).
		fsPath := strings.TrimPrefix(c.Request.URL.Path, "/")
		f, err := staticFS.Open(fsPath)
		if err == nil {
			f.Close()
			staticServer.ServeHTTP(c.Writer, c.Request)
			return
		}
		// SPA fallback: serve index.html for unknown routes (React Router)
		c.Request.URL.Path = "/"
		staticServer.ServeHTTP(c.Writer, c.Request)
	}

	// "/" serves the SPA for everyone (it shows the login screen when the
	// visitor is unauthenticated). There is no separate marketing site gating
	// the root.
	r.GET("/", func(c *gin.Context) {
		c.Request.URL.Path = "/"
		staticServer.ServeHTTP(c.Writer, c.Request)
	})

	r.NoRoute(func(c *gin.Context) {
		if isJSONAPIPath(c.Request.URL.Path) {
			c.JSON(http.StatusNotFound, gin.H{"error": "no such endpoint"})
			return
		}
		serveSPA(c)
	})

	// Reached only when the path matches a route registered under a DIFFERENT
	// method (gin.Engine.HandleMethodNotAllowed).
	r.NoMethod(func(c *gin.Context) {
		if isJSONAPIPath(c.Request.URL.Path) {
			c.JSON(http.StatusMethodNotAllowed, gin.H{"error": "method not allowed"})
			return
		}
		serveSPA(c)
	})
}

// runMigrateCredential implements the `migrate-credential` subcommand.
func runMigrateCredential(args []string) {
	fs := flag.NewFlagSet("migrate-credential", flag.ExitOnError)
	adminID := fs.String("admin", "", "admin account id to create the first per-user credential for (required)")
	password := fs.String("password", "", "password for the credential (default: auth.password from config.yaml)")
	dbPath := fs.String("db", "", "credential DB path (default: $VULOS_USERAUTH_DB or ./data/userauth.db)")
	_ = fs.Parse(args)

	cfg, err := config.Load("config.yaml")
	if err != nil {
		cfg = config.Default()
	}
	pw := *password
	if pw == "" {
		pw = cfg.Auth.Password
	}
	if *adminID == "" || pw == "" {
		fmt.Fprintln(os.Stderr, "migrate-credential: -admin is required, and a password must be available "+
			"(via -password or auth.password in config.yaml)")
		os.Exit(2)
	}

	dsn := *dbPath
	if dsn == "" {
		if v := os.Getenv("VULOS_USERAUTH_DB"); v != "" {
			dsn = v
		} else {
			dsn = "./data/userauth.db"
		}
	}

	store, err := userauth.NewSQLiteStore(dsn)
	if err != nil {
		log.Fatalf("migrate-credential: open credential store %q: %v", dsn, err)
	}
	defer store.Close()

	switch err := userauth.MigrateSharedPassword(store, *adminID, pw); err {
	case nil:
		fmt.Printf("migrate-credential: created per-user credential for %q in %s\n", *adminID, dsn)
		fmt.Println("You can now log in with that account + password, then mint invites for the rest of your team.")
	case userauth.ErrAlreadyMigrated:
		fmt.Println("migrate-credential: credential store already has users — nothing to do (no lockout risk).")
	default:
		log.Fatalf("migrate-credential: %v", err)
	}
}
