package middleware

import (
	"fmt"
	"os"
	"sync"
)

// JWT secret handling.
//
// Security contract (replaces the former hardcoded constant):
//   - The signing secret is read from DIWAN_JWT_SECRET.
//   - In production the secret MUST be set; if it is unset, JWTSecret returns
//     an error so the server refuses to mint or accept tokens (fail closed).
//   - A dev default is only allowed when DIWAN_DEV=1 (or "true") is set
//     explicitly, so a misconfigured production deploy can never silently fall
//     back to a well-known key.
//
// Both the issuer (handlers/auth.go Login + Status) and the verifier
// (middleware/auth.go) call JWTSecret so they always agree on the key.

const (
	// EnvJWTSecret is the env var the office backend reads the HS256 signing
	// secret from. The cloud/OS issuer (if/when external issuance is added)
	// must sign office tokens with the same secret.
	EnvJWTSecret = "DIWAN_JWT_SECRET"

	// EnvDevMode, when set to "1"/"true", permits an insecure in-memory dev
	// secret if EnvJWTSecret is unset. Never set this in production.
	EnvDevMode = "DIWAN_DEV"

	// devSecret is the fallback used ONLY in explicit dev mode. It is clearly
	// labelled so it can never be mistaken for a production key.
	devSecret = "diwan-dev-only-INSECURE-do-not-use-in-prod"
)

var (
	secretMu     sync.Mutex
	cachedSecret []byte
)

// devModeEnabled reports whether explicit dev mode is on.
func devModeEnabled() bool {
	v := os.Getenv(EnvDevMode)
	return v == "1" || v == "true" || v == "TRUE" || v == "yes"
}

// JWTSecret returns the HS256 signing secret.
//
// It returns an error (fail closed) when DIWAN_JWT_SECRET is unset and
// dev mode is not explicitly enabled — so production never signs or verifies
// tokens with a predictable key.
func JWTSecret() ([]byte, error) {
	secretMu.Lock()
	defer secretMu.Unlock()
	if cachedSecret != nil {
		return cachedSecret, nil
	}
	if raw := os.Getenv(EnvJWTSecret); raw != "" {
		cachedSecret = []byte(raw)
		return cachedSecret, nil
	}
	if devModeEnabled() {
		cachedSecret = []byte(devSecret)
		return cachedSecret, nil
	}
	return nil, fmt.Errorf(
		"%s is not set; refusing to use a default signing key. "+
			"Set %s to a strong random value in production, "+
			"or set %s=1 for local development",
		EnvJWTSecret, EnvJWTSecret, EnvDevMode)
}

// JWTSecretConfigured reports whether a usable signing secret is available
// (env secret set, or dev mode enabled). Used by main.go to fail fast at
// startup when auth is enabled but no secret is configured.
func JWTSecretConfigured() bool {
	_, err := JWTSecret()
	return err == nil
}

// resetSecretCacheForTest clears the cached secret so tests can flip env vars.
func resetSecretCacheForTest() {
	secretMu.Lock()
	defer secretMu.Unlock()
	cachedSecret = nil
}
