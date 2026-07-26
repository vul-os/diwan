// resolve.go — FIX-OFFICE-STORE-WIRE-01: bridge between the OS-side
// storage-mode env contract (STORE-LOCAL-01 in `vulos`) and this binary's
// startup. main.go calls ResolveOfficeBackend at boot to pick up the
// VULOS_STORAGE_MODE + VULOS_MINIO_* env vars (set by the OS bundle's
// storagemode.EnvFor) and to materialise either:
//
//   - a MinIO-backed OfficeS3Client (when VULOS_STORAGE_MODE=local-minio-sync
//     OR any VULOS_MINIO_* env var is present), or
//   - the Tigris default (otherwise — env-filled by OfficeTigrisDefaults).
//
// The "file CRUD" Storage interface (local/postgres) is intentionally
// orthogonal to the object-store client — both paths still build a
// Storage via the existing `New(cfg)` selector. This resolver only adds the
// object-store layer the OFFICE-STORE-01 deliverable shipped but never wired.
//
// No endpoint-selection logic lives here beyond the env→struct mapping that
// OFFICE-STORE-01 explicitly requires: "vulos-office accepts the endpoint, it
// does NOT decide between Tigris or MinIO".
package storage

import (
	"fmt"
	"log"
	"os"
	"strings"
)

// Environment-variable names consumed at office startup. These mirror the
// OS-side storagemode.EnvFor contract (vulos/backend/internal/storagemode).
const (
	EnvStorageMode = "VULOS_STORAGE_MODE"

	EnvMinIOEndpoint = "VULOS_MINIO_ENDPOINT"
	EnvMinIORegion   = "VULOS_MINIO_REGION"
	EnvMinIOBucket   = "VULOS_MINIO_BUCKET"
	EnvMinIOCredsRef = "VULOS_MINIO_CREDS_REF"

	// modeLocalMinioSync mirrors storagemode.ModeLocalMinIOSync without
	// importing the vulos OS module (office is a separate repo, MIT, no
	// cross-repo Go dependency).
	modeLocalMinioSync = "local-minio-sync"
)

// ResolvedBackend is the object-store handle produced at startup. Exactly one
// of Client / TigrisDefault is set; both can be nil in pathological env
// configurations (which the caller should treat as "fall back to direct").
type ResolvedBackend struct {
	// Kind is the resolved backend family ("tigris" or "minio").
	Kind OfficeBEKind

	// Endpoint is the resolved endpoint URL (for the startup log line).
	Endpoint string

	// SyncMode mirrors VULOS_STORAGE_MODE so the caller can wire OFFICE-SYNC-01
	// without re-reading the env.
	SyncMode OfficeSyncMode

	// Client is the live S3 client when the resolver successfully built one.
	// Nil when no MinIO env is present and Tigris credentials are also absent
	// (in which case the binary still serves file CRUD via the local/postgres
	// storage interface — the S3 backend is simply not engaged).
	Client *OfficeS3Client
}

// ResolveOfficeBackend reads the env vars defined above and returns a
// ResolvedBackend. It NEVER panics and always returns a non-nil struct; if
// no S3 endpoint is reachable from env it returns Kind=tigris with the
// default Tigris URL so the startup log line is still meaningful.
//
// Selection rules (per FIX-OFFICE-STORE-WIRE-01 scope):
//   - if VULOS_STORAGE_MODE=local-minio-sync OR any VULOS_MINIO_* env var is
//     non-empty → build a MinIO-kind OfficeS3Client.
//   - otherwise → build a Tigris-kind OfficeS3Client from OfficeTigrisDefaults
//     (no client returned when Tigris creds are absent — env-default endpoint
//     is still reported for logging).
func ResolveOfficeBackend() (*ResolvedBackend, error) {
	mode := strings.TrimSpace(os.Getenv(EnvStorageMode))

	minioEndpoint := strings.TrimSpace(os.Getenv(EnvMinIOEndpoint))
	minioRegion := strings.TrimSpace(os.Getenv(EnvMinIORegion))
	minioBucket := strings.TrimSpace(os.Getenv(EnvMinIOBucket))
	minioCreds := strings.TrimSpace(os.Getenv(EnvMinIOCredsRef))

	anyMinIO := minioEndpoint != "" || minioRegion != "" || minioBucket != "" || minioCreds != ""

	syncMode := OfficeSyncDirect
	if mode == modeLocalMinioSync {
		syncMode = OfficeSyncLocalMinio
	}

	if mode == modeLocalMinioSync || anyMinIO {
		ak, sk, err := readMinIOCreds(minioCreds)
		if err != nil {
			return nil, fmt.Errorf("storage: resolve minio creds: %w", err)
		}
		cfg := OfficeBackendConfig{
			Kind:            OfficeBEKindMinIO,
			Endpoint:        minioEndpoint,
			Region:          minioRegion,
			Bucket:          minioBucket,
			AccessKeyID:     ak,
			SecretAccessKey: sk,
		}
		client, err := NewOfficeS3Client(cfg)
		if err != nil {
			return nil, fmt.Errorf("storage: new minio client: %w", err)
		}
		return &ResolvedBackend{
			Kind:     OfficeBEKindMinIO,
			Endpoint: cfg.Endpoint,
			SyncMode: syncMode,
			Client:   client,
		}, nil
	}

	// Default: Tigris (managed). Build a client only when creds are present.
	tcfg := OfficeTigrisDefaults()
	rb := &ResolvedBackend{
		Kind:     OfficeBEKindTigris,
		Endpoint: tcfg.Endpoint,
		SyncMode: syncMode,
	}
	if tcfg.AccessKeyID != "" && tcfg.SecretAccessKey != "" {
		client, err := NewOfficeS3Client(tcfg)
		if err != nil {
			return nil, fmt.Errorf("storage: new tigris client: %w", err)
		}
		rb.Client = client
	}
	return rb, nil
}

// ─── org-bucket resolver ──────────────────────────────────────────────────────

// Environment variables for org-bucket scoping.
// These are injected by an external control plane at instance startup and
// are NOT read from config.yaml — they are deployment-time secrets.
//
//	VULOS_ORG_ID          — the organisation identifier (cloud-managed UUID or slug).
//	                        Used as the top-level key prefix so all orgs share a
//	                        single Tigris/MinIO bucket without collisions.
//	                        For BYO self-hosted deployments this may be the
//	                        hostname or instance name; if absent, no prefix is
//	                        applied (single-tenant OSS mode).
//
// Object key layout inside the bucket:
//
//	<orgID>/<accountID>/<name>     (multi-tenant cloud)
//	<name>                         (OSS / single-tenant — VULOS_ORG_ID absent)
//
// The "seam" for the cloud: the cloud must set VULOS_ORG_ID before starting
// the office binary. It may also override TIGRIS_* or VULOS_MINIO_* vars to
// point at the per-org bucket (or a shared bucket with the org prefix). No
// further code change is required here.
const EnvOrgID = "VULOS_ORG_ID"

// orgBucketClient is the process-wide org-scoped S3 client, set once by
// InitOrgBucket(). Nil when no S3 backend is configured (OSS no-cloud mode).
var orgBucketClient *OfficeS3Client

// InitOrgBucket resolves the org bucket at startup, logs the result, and
// stores the client for OrgScopedKey / OrgBucketClient use.
// Called once from main() after ResolveOfficeBackend (or independently).
// Never panics; if no S3 backend is reachable it logs a warning and continues.
func InitOrgBucket() {
	rb, err := ResolveOfficeBackend()
	if err != nil {
		log.Printf("[storage] org-bucket: ResolveOfficeBackend error: %v — object store disabled", err)
		return
	}
	if rb.Client == nil {
		log.Printf("[storage] org-bucket: no S3 credentials configured — object store disabled (OSS mode)")
		return
	}
	orgID := strings.TrimSpace(os.Getenv(EnvOrgID))
	if orgID == "" {
		log.Printf("[storage] org-bucket: VULOS_ORG_ID not set — single-tenant mode (no org prefix)")
	} else {
		log.Printf("[storage] org-bucket: kind=%s org=%s", rb.Kind, orgID)
	}
	orgBucketClient = rb.Client
}

// OrgBucketClient returns the process-wide org-scoped S3 client, or nil if
// no S3 backend was configured. Callers must nil-check before use.
func OrgBucketClient() *OfficeS3Client {
	return orgBucketClient
}

// ObjectStoreInfo is an honest, secret-free description of the configured blob
// object store, for the standalone Settings → Storage surface. It never exposes
// credentials — only the backend family, endpoint host, bucket, and whether a
// live client is engaged.
type ObjectStoreInfo struct {
	// Kind is "minio", "tigris", or "none" (no object store — local disk only).
	Kind string `json:"kind"`
	// Endpoint is the S3 endpoint URL (host only — no creds). Empty for "none".
	Endpoint string `json:"endpoint,omitempty"`
	// Bucket is the configured bucket name, when one is set.
	Bucket string `json:"bucket,omitempty"`
	// OrgID is the multi-tenant key prefix (VULOS_ORG_ID); empty in single-tenant.
	OrgID string `json:"org_id,omitempty"`
	// Active reports whether a live object-store client is engaged (credentials
	// present). When false, file blobs are served from the local/postgres store.
	Active bool `json:"active"`
}

// DescribeObjectStore reports the configured blob object store WITHOUT building
// a client or reading credential files (so it is safe to call from a request
// handler). It mirrors the selection rules in ResolveOfficeBackend.
func DescribeObjectStore() ObjectStoreInfo {
	info := ObjectStoreInfo{Kind: "none"}
	info.OrgID = strings.TrimSpace(os.Getenv(EnvOrgID))

	mode := strings.TrimSpace(os.Getenv(EnvStorageMode))
	minioEndpoint := strings.TrimSpace(os.Getenv(EnvMinIOEndpoint))
	minioBucket := strings.TrimSpace(os.Getenv(EnvMinIOBucket))
	anyMinIO := minioEndpoint != "" ||
		strings.TrimSpace(os.Getenv(EnvMinIORegion)) != "" ||
		minioBucket != "" ||
		strings.TrimSpace(os.Getenv(EnvMinIOCredsRef)) != ""

	if mode == modeLocalMinioSync || anyMinIO {
		info.Kind = "minio"
		info.Endpoint = minioEndpoint
		info.Bucket = minioBucket
		info.Active = minioEndpoint != "" && minioBucket != ""
		return info
	}

	// Tigris (managed) is engaged only when credentials are present in env.
	if os.Getenv("TIGRIS_ACCESS_KEY_ID") != "" && os.Getenv("TIGRIS_SECRET_ACCESS_KEY") != "" {
		t := OfficeTigrisDefaults()
		info.Kind = "tigris"
		info.Endpoint = t.Endpoint
		info.Active = true
		return info
	}
	return info
}

// OrgScopedKey returns the full object key for a given (accountID, name) pair,
// scoped by the org prefix so objects from different orgs/accounts never collide.
//
// Layout:
//   - When VULOS_ORG_ID is set:   "<orgID>/<accountID>/<name>"
//   - When VULOS_ORG_ID is unset: "<accountID>/<name>"  (single-org)
//   - When accountID is empty:    omits the account segment (shared org-level object)
//
// Security: each segment is sanitized by sanitizeKeySegment so that a
// caller-controlled accountID or name cannot inject path separators ("/" or
// "..") and escape into another org's or account's key namespace.
//
// This is the authoritative key builder — all handlers that write to the org
// bucket must call this function instead of constructing keys ad-hoc.
func OrgScopedKey(accountID, name string) string {
	orgID := strings.TrimSpace(os.Getenv(EnvOrgID))
	var parts []string
	if orgID != "" {
		parts = append(parts, sanitizeKeySegment(orgID))
	}
	if accountID != "" {
		parts = append(parts, sanitizeKeySegment(accountID))
	}
	parts = append(parts, sanitizeKeySegment(name))
	return strings.Join(parts, "/")
}

// sanitizeKeySegment strips characters that could be used to escape an
// object-store key prefix. It collapses any "/" or "\" to "_", removes
// leading/trailing dots, and replaces ".." sequences so a caller-supplied
// segment cannot traverse out of its expected prefix layer.
func sanitizeKeySegment(s string) string {
	// Replace path separators with underscores.
	s = strings.ReplaceAll(s, "/", "_")
	s = strings.ReplaceAll(s, "\\", "_")
	// Collapse ".." to prevent traversal even in object-store key semantics.
	s = strings.ReplaceAll(s, "..", "_")
	// Trim leading/trailing dots that could create hidden-object names.
	s = strings.Trim(s, ".")
	if s == "" {
		return "_"
	}
	return s
}

// readMinIOCreds returns (accessKey, secretKey, error) for a MinIO endpoint.
// credsRef may be:
//   - empty       → fall back to AWS-style env vars (AWS_ACCESS_KEY_ID /
//     AWS_SECRET_ACCESS_KEY), then to MINIO_ROOT_USER /
//     MINIO_ROOT_PASSWORD (matching install-vulos.sh).
//   - a file path → read "ACCESS_KEY\nSECRET_KEY\n" (the format the OS
//     installer writes to $DATA_DIR/minio/.minio_secret).
//
// Empty creds are allowed (some MinIO deployments rely on IAM); the S3 client
// will fail at request time rather than at boot.
func readMinIOCreds(credsRef string) (string, string, error) {
	if credsRef != "" {
		// File path form — read the two lines.
		b, err := os.ReadFile(credsRef)
		if err != nil {
			return "", "", fmt.Errorf("read %q: %w", credsRef, err)
		}
		lines := strings.Split(strings.TrimSpace(string(b)), "\n")
		var ak, sk string
		if len(lines) > 0 {
			ak = strings.TrimSpace(lines[0])
		}
		if len(lines) > 1 {
			sk = strings.TrimSpace(lines[1])
		}
		return ak, sk, nil
	}
	if ak, sk := os.Getenv("AWS_ACCESS_KEY_ID"), os.Getenv("AWS_SECRET_ACCESS_KEY"); ak != "" || sk != "" {
		return ak, sk, nil
	}
	return os.Getenv("MINIO_ROOT_USER"), os.Getenv("MINIO_ROOT_PASSWORD"), nil
}
