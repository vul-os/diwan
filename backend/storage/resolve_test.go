package storage_test

import (
	"os"
	"path/filepath"
	"testing"

	"diwan/backend/storage"
)

func clearStorageEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{
		storage.EnvStorageMode,
		storage.EnvMinIOEndpoint,
		storage.EnvMinIORegion,
		storage.EnvMinIOBucket,
		storage.EnvMinIOCredsRef,
		"AWS_ACCESS_KEY_ID",
		"AWS_SECRET_ACCESS_KEY",
		"MINIO_ROOT_USER",
		"MINIO_ROOT_PASSWORD",
		"TIGRIS_ENDPOINT",
		"TIGRIS_REGION",
		"TIGRIS_ACCESS_KEY_ID",
		"TIGRIS_SECRET_ACCESS_KEY",
	} {
		t.Setenv(k, "")
	}
}

// TestResolveOfficeBackendDefaultTigris: with no env, the resolver returns
// Tigris kind, the canonical Tigris endpoint, and SyncMode=direct. No client
// is built (no Tigris creds present).
func TestResolveOfficeBackendDefaultTigris(t *testing.T) {
	clearStorageEnv(t)

	rb, err := storage.ResolveOfficeBackend()
	if err != nil {
		t.Fatalf("ResolveOfficeBackend: %v", err)
	}
	if rb.Kind != storage.OfficeBEKindTigris {
		t.Errorf("Kind = %q, want tigris", rb.Kind)
	}
	if rb.Endpoint != "https://fly.storage.tigris.dev" {
		t.Errorf("Endpoint = %q, want canonical Tigris URL", rb.Endpoint)
	}
	if rb.SyncMode != storage.OfficeSyncDirect {
		t.Errorf("SyncMode = %q, want direct", rb.SyncMode)
	}
	if rb.Client != nil {
		t.Errorf("Client = %v, want nil (no creds)", rb.Client)
	}
}

// TestResolveOfficeBackendTigrisWithCreds: Tigris env creds present → a live
// client is built and the endpoint reflects TIGRIS_ENDPOINT.
func TestResolveOfficeBackendTigrisWithCreds(t *testing.T) {
	clearStorageEnv(t)
	t.Setenv("TIGRIS_ENDPOINT", "https://custom.tigris.example.com")
	t.Setenv("TIGRIS_ACCESS_KEY_ID", "ak")
	t.Setenv("TIGRIS_SECRET_ACCESS_KEY", "sk")

	rb, err := storage.ResolveOfficeBackend()
	if err != nil {
		t.Fatalf("ResolveOfficeBackend: %v", err)
	}
	if rb.Kind != storage.OfficeBEKindTigris {
		t.Errorf("Kind = %q, want tigris", rb.Kind)
	}
	if rb.Endpoint != "https://custom.tigris.example.com" {
		t.Errorf("Endpoint = %q", rb.Endpoint)
	}
	if rb.Client == nil {
		t.Fatal("Client = nil, want non-nil")
	}
}

// TestResolveOfficeBackendMinIOFromMode: VULOS_STORAGE_MODE=local-minio-sync
// triggers the MinIO branch even with no creds, and SyncMode=local-minio-sync.
func TestResolveOfficeBackendMinIOFromMode(t *testing.T) {
	clearStorageEnv(t)
	t.Setenv(storage.EnvStorageMode, "local-minio-sync")
	t.Setenv(storage.EnvMinIOEndpoint, "https://minio.local:9000")
	t.Setenv(storage.EnvMinIOBucket, "diwan")
	t.Setenv(storage.EnvMinIORegion, "auto")

	rb, err := storage.ResolveOfficeBackend()
	if err != nil {
		t.Fatalf("ResolveOfficeBackend: %v", err)
	}
	if rb.Kind != storage.OfficeBEKindMinIO {
		t.Errorf("Kind = %q, want minio", rb.Kind)
	}
	if rb.Endpoint != "https://minio.local:9000" {
		t.Errorf("Endpoint = %q", rb.Endpoint)
	}
	if rb.SyncMode != storage.OfficeSyncLocalMinio {
		t.Errorf("SyncMode = %q, want local-minio-sync", rb.SyncMode)
	}
	if rb.Client == nil {
		t.Fatal("Client = nil, want non-nil")
	}
}

// TestResolveOfficeBackendMinIOFromEnvOnly: any single VULOS_MINIO_* var
// without VULOS_STORAGE_MODE still triggers the MinIO branch.
func TestResolveOfficeBackendMinIOFromEnvOnly(t *testing.T) {
	clearStorageEnv(t)
	t.Setenv(storage.EnvMinIOEndpoint, "https://minio.example.com")
	t.Setenv(storage.EnvMinIOBucket, "office")

	rb, err := storage.ResolveOfficeBackend()
	if err != nil {
		t.Fatalf("ResolveOfficeBackend: %v", err)
	}
	if rb.Kind != storage.OfficeBEKindMinIO {
		t.Errorf("Kind = %q, want minio", rb.Kind)
	}
	if rb.Endpoint != "https://minio.example.com" {
		t.Errorf("Endpoint = %q", rb.Endpoint)
	}
	// SyncMode stays direct because VULOS_STORAGE_MODE was not set.
	if rb.SyncMode != storage.OfficeSyncDirect {
		t.Errorf("SyncMode = %q, want direct", rb.SyncMode)
	}
	if rb.Client == nil {
		t.Fatal("Client = nil, want non-nil")
	}
}

// TestResolveOfficeBackendMinIOCredsFromFile: when CREDS_REF points at a file,
// the resolver reads "ACCESS\nSECRET\n" out of it.
func TestResolveOfficeBackendMinIOCredsFromFile(t *testing.T) {
	clearStorageEnv(t)

	dir := t.TempDir()
	credsPath := filepath.Join(dir, ".minio_secret")
	if err := os.WriteFile(credsPath, []byte("file-ak\nfile-sk\n"), 0o600); err != nil {
		t.Fatalf("write creds: %v", err)
	}

	t.Setenv(storage.EnvStorageMode, "local-minio-sync")
	t.Setenv(storage.EnvMinIOEndpoint, "https://minio.local:9000")
	t.Setenv(storage.EnvMinIOBucket, "diwan")
	t.Setenv(storage.EnvMinIOCredsRef, credsPath)

	rb, err := storage.ResolveOfficeBackend()
	if err != nil {
		t.Fatalf("ResolveOfficeBackend: %v", err)
	}
	if rb.Client == nil {
		t.Fatal("Client = nil")
	}
	// Smoke: client was built with the file-derived creds (we cannot inspect
	// them directly; the success path here is sufficient — invalid creds
	// would have caused NewOfficeS3Client.Validate to error).
}
