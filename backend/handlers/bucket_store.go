package handlers

// bucket_store.go — UNIFIED-STORAGE-01: per-request blob storage seam.
//
// Office writes file/seal blobs through this thin wrapper. The underlying S3
// client is now derived FROM THE REQUEST:
//
//   - When the OS gateway injects X-Vulos-Storage-* headers, every blob is
//     written to that per-user bucket/endpoint/credentials, namespaced under
//     "<X-Vulos-Storage-Prefix>/office/...". Injection is per-request/per-user,
//     so the client is resolved per call (cached by credential fingerprint in
//     the storage package) — never assumed process-wide.
//
//   - When the headers are absent (Office running standalone, not behind the
//     gateway), it falls back EXACTLY to today's behavior: the process-wide
//     OrgBucketClient() (env TIGRIS_*/VULOS_MINIO_*) or a silent no-op when no
//     S3 backend is configured.
//
// In both modes the object key is storage.OrgScopedKey(accountID, name), so the
// per-account scoping that fileacl relies on is preserved — under the injected
// prefix in seam mode, and under the org prefix (if any) otherwise.

import (
	"io"
	"log"

	"diwan/backend/storage"

	"github.com/gin-gonic/gin"
)

// BucketStore is a thin convenience wrapper around the office object store.
// Create instances via SharedBucketStore().
type BucketStore struct{}

// sharedBucketStore is the process-wide singleton (always non-nil).
var sharedBucketStore = &BucketStore{}

// SharedBucketStore returns the process-wide BucketStore singleton.
// The BucketStore itself is always non-nil; the resolved S3 client may be nil
// for a given request when no backend applies, in which case every method is a
// no-op.
func SharedBucketStore() *BucketStore {
	return sharedBucketStore
}

// seamConfigFromContext reads the per-request storage seam injected by the OS
// gateway. All values are empty when running standalone (headers absent).
func seamConfigFromContext(c *gin.Context) storage.SeamStorageConfig {
	if c == nil {
		return storage.SeamStorageConfig{}
	}
	return storage.SeamStorageConfig{
		Endpoint:     c.GetHeader("X-Vulos-Storage-Endpoint"),
		Bucket:       c.GetHeader("X-Vulos-Storage-Bucket"),
		Prefix:       c.GetHeader("X-Vulos-Storage-Prefix"),
		Region:       c.GetHeader("X-Vulos-Storage-Region"),
		AccessKey:    c.GetHeader("X-Vulos-Storage-Access-Key"),
		SecretKey:    c.GetHeader("X-Vulos-Storage-Secret-Key"),
		SessionToken: c.GetHeader("X-Vulos-Storage-Session-Token"),
		BrokerAuth:   c.GetHeader("X-Vulos-Storage-Broker-Auth"),
	}
}

// clientFor resolves the S3 client to use for this request: the gateway-injected
// per-user client when the seam headers are present AND prove they came from the
// trusted OS gateway (valid X-Vulos-Storage-Broker-Auth against the configured
// VULOS_STORAGE_BROKER_SECRET — see SeamStorageConfig.Trusted). Otherwise the
// injected headers are ignored entirely and we fall back to the process-wide
// OrgBucketClient(). May return (nil, nil) when neither is configured.
func (b *BucketStore) clientFor(c *gin.Context) (*storage.OfficeS3Client, error) {
	cfg := seamConfigFromContext(c)
	if cfg.Trusted() {
		return storage.SeamS3Client(cfg)
	}
	return storage.OrgBucketClient(), nil
}

// PutObject uploads data for the current request's caller under the key
// "<accountID>/<name>" (further namespaced by the resolved client's prefix).
// When no S3 client applies (standalone, no backend) it is a silent no-op so
// callers can treat SQLite/local as the sole source. The contentType argument
// is informational and currently unused.
func (b *BucketStore) PutObject(c *gin.Context, accountID, name string, data []byte, contentType string) error {
	client, err := b.clientFor(c)
	if err != nil {
		log.Printf("[bucket_store] resolve client: %v", err)
		return err
	}
	if client == nil {
		return nil // no backend — silent no-op
	}
	key := storage.OrgScopedKey(accountID, name)
	if err := client.Put(key, data); err != nil {
		log.Printf("[bucket_store] PutObject key=%q: %v", key, err)
		return err
	}
	return nil
}

// GetObject downloads the object for the current request's caller at the key
// "<accountID>/<name>". Returns (nil, nil) when no S3 client applies so callers
// can skip the object-store path cleanly.
func (b *BucketStore) GetObject(c *gin.Context, accountID, name string) ([]byte, error) {
	client, err := b.clientFor(c)
	if err != nil {
		return nil, err
	}
	if client == nil {
		return nil, nil // no backend — signal "no object, not an error"
	}
	key := storage.OrgScopedKey(accountID, name)
	rc, err := client.Get(key)
	if err != nil {
		log.Printf("[bucket_store] GetObject key=%q: %v", key, err)
		return nil, err
	}
	defer rc.Close()
	data, err := io.ReadAll(rc)
	if err != nil {
		return nil, err
	}
	return data, nil
}

// DeleteObject removes the object for the current request's caller at the key
// "<accountID>/<name>". Silent no-op when no S3 client applies.
func (b *BucketStore) DeleteObject(c *gin.Context, accountID, name string) error {
	client, err := b.clientFor(c)
	if err != nil {
		return err
	}
	if client == nil {
		return nil // no backend — no-op
	}
	key := storage.OrgScopedKey(accountID, name)
	if err := client.Delete(key); err != nil {
		log.Printf("[bucket_store] DeleteObject key=%q: %v", key, err)
		return err
	}
	return nil
}
