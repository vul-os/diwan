package signing

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
)

// GenerateShareLinkToken mints an opaque, unguessable credential for an
// anonymous read-only document share link.
//
// Unlike the Ed25519 signer tokens (which embed signed claims), a share-link
// token is a pure random capability: 32 bytes of cryptographic randomness,
// base64url-encoded WITHOUT padding so it is a single URL/path-safe segment
// (matching the storage layer's validID charset [A-Za-z0-9_-]). The token is
// the lookup key; the record it resolves to carries the file id, expiry,
// password hash, and revoked flag. Security therefore rests on the token being
// unguessable (256 bits of entropy) and revocable — NOT on it being unforgeable
// in the signature sense, because there is nothing to forge: an attacker cannot
// invent a token that maps to a stored record.
//
// The raw token is shown to the owner ONCE, at mint. It is never persisted; see
// HashShareLinkToken.
func GenerateShareLinkToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("signing: generate share-link token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// ShareLinkTokenHashLen is the length of a HashShareLinkToken result (SHA-256
// rendered as lowercase hex). Storage backends use it to tell a stored hash
// apart from a legacy plaintext token, which is 43 base64url characters and so
// can never be 64 hex characters.
const ShareLinkTokenHashLen = sha256.Size * 2

// HashShareLinkToken returns the lowercase hex SHA-256 of a raw share-link
// token. The hash — never the token — is what a storage backend persists and
// keys on, exactly as backend/invites does for registration invites.
//
// Why a bare SHA-256 and not bcrypt/argon2: the input is not a password. It is
// 256 bits from crypto/rand, so there is no dictionary to run and no work
// factor to buy. A password-hashing KDF here would only make every anonymous
// view-route lookup expensive enough to be a denial-of-service lever.
//
// The property this buys: anyone who reads the share-link store (a leaked
// backup, a stray `cat data/sharelinks/*.json`, a `SELECT * FROM share_links`)
// gets hashes, not working capabilities. Recovering a token from its hash means
// inverting SHA-256 over a 256-bit space.
func HashShareLinkToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}
