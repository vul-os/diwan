// Package rendezvous is Diwan's OWN peer-discovery surface: the signed,
// content-blind announce / resolve / signal / mailbox protocol that two browsers
// need in order to exchange WebRTC offer/answer/ICE and then talk directly to
// each other.
//
// WHY THIS EXISTS
// ---------------
// Two browsers cannot find each other without something in the middle to pass
// the first few packets. That "something" is signalling, and it is a genuine
// requirement of WebRTC, not a design choice we can decline. Until now Diwan
// could only get it from somewhere ELSE: a Vulos OS / Ephor host mounting
// `/api/peering/*`, or an operator-run `vulos-relayd` named in
// `collab.rendezvous_url`. With neither, a standalone Diwan binary had NO path
// to peer-to-peer collaboration at all — `transportSelection.js` fell through to
// LOCAL_ONLY and the UI honestly said "Offline".
//
// That made the product's central claim conditional on another product being
// deployed. This package removes that condition: the Diwan binary serves the
// same protocol itself, on its own origin, so an operator who runs one Diwan on
// one VPS has everything two users need. Ephor remains a legitimate CHOICE (an
// operator who wants a shared relay across several deployments, or its NAT
// traversal) — it is no longer a prerequisite.
//
// WHAT THE SERVER CAN SEE
// -----------------------
// Nothing about a document. Every payload it moves is opaque bytes addressed by
// an Ed25519 public key; the room key that seals those bytes lives in an invite
// link's URL fragment and is never sent to any server (see
// docs/COLLABORATION.md §4). What it necessarily does see is discovery
// METADATA: which keys are present, which key sent bytes to which, sizes and
// timing. That is the honest cost of hosting your own signalling, and it is
// visible only to the operator's own box.
//
// SAFETY ON THE OPEN INTERNET
// ---------------------------
// A cloud node is exposed, so the surface is authenticated by construction
// rather than by being hidden:
//
//   - Every WRITE is Ed25519-signed by the key it claims to act for, over a
//     domain-separated, length-prefixed canonical message. A signature proves
//     the write on its own; nothing is trusted merely for having arrived.
//   - Each write carries a fresh nonce and a timestamp. A replayed envelope is
//     refused (bounded nonce cache) and one outside the clock-skew window is
//     refused, so a captured request cannot be re-flown later.
//   - `resolve` is the only unauthenticated read, and it returns only what its
//     subject signed and published about itself.
//   - Every dimension is CAPPED (payload size, queue depth, key count, TTL) and
//     enforced before anything is stored, so an anonymous caller cannot make the
//     box allocate without bound.
//   - Failures are refusals: a bad signature, a stale timestamp, a reused nonce,
//     an over-cap payload are all 4xx with nothing stored. There is no "accept
//     it anyway" branch.
//
// It is deliberately OPEN in the sense that no account is required — anonymous
// invite-link collaboration is the feature — and same-origin only: unlike
// Ephor's rendezvous role this surface serves NO CORS headers, because the only
// browsers that need it are the ones already loading Diwan from this origin.
//
// INTEROPERABILITY
// ----------------
// The wire protocol is byte-for-byte the one `src/lib/collab/webrtc/rendezvous.js`
// already speaks, so the browser client is unchanged: it is pointed at this
// origin with a different prefix and everything else is identical. That also
// means a deployment can move between this built-in surface and an external
// relayd without a rebuild. `canonicalMessage` below is the Go twin of the JS
// function of the same name, and `rendezvous_canonical_test.go` pins the two
// against fixed vectors so they cannot drift apart silently.
package rendezvous

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"sync"
	"time"
)

// ── canonical domain tags ───────────────────────────────────────────────────
//
// MUST match DOMAIN in src/lib/collab/webrtc/rendezvous.js exactly. A mismatch
// makes every signature fail to verify, which is why they are pinned by test.
const (
	DomainAnnounce       = "vulos-rdv/announce/1"
	DomainWithdraw       = "vulos-rdv/withdraw/1"
	DomainSignalDeposit  = "vulos-rdv/signal-deposit/1"
	DomainSignalPoll     = "vulos-rdv/signal-poll/1"
	DomainSignalAck      = "vulos-rdv/signal-ack/1"
	DomainMailboxDeposit = "vulos-rdv/mailbox-deposit/1"
	DomainMailboxPoll    = "vulos-rdv/mailbox-poll/1"
	DomainMailboxAck     = "vulos-rdv/mailbox-ack/1"
)

// Queue names. Signal carries WebRTC offer/answer/ICE (short-lived, high churn);
// mailbox carries the already-sealed application payloads of the content-blind
// relay circuit fallback (longer-lived, larger). They are separate namespaces
// with separate limits so signalling latency cannot be starved by relay traffic.
type queueKind int

const (
	queueSignal queueKind = iota
	queueMailbox
)

// Limits bounds every dimension an anonymous caller can push on. Zero values are
// replaced by DefaultLimits() in New, so a partially-filled Limits is safe.
type Limits struct {
	// MaxPayloadBytes caps one deposited payload, measured on the DECODED bytes.
	MaxPayloadBytes int
	// MaxMetaBytes caps an announce's opaque `meta` blob.
	MaxMetaBytes int
	// MaxEndpoints / MaxEndpointBytes cap the announce endpoint hint list.
	MaxEndpoints     int
	MaxEndpointBytes int
	// MaxQueueBlobs caps how many undelivered blobs one recipient key may hold
	// per queue. At the cap the OLDEST blob is dropped, because in this protocol
	// the newest signal is the one that matters (a stale ICE candidate is worth
	// less than a fresh offer) and refusing the write would stall the live peer.
	MaxQueueBlobs int
	// MaxQueueBytes caps the total decoded bytes one recipient key may hold per
	// queue, evicting oldest-first the same way.
	MaxQueueBytes int
	// MaxKeys caps how many distinct keys may hold presence or queue state at
	// once. Past it, writes for a NEW key are refused (503) rather than evicting
	// a live session's state — refusing a newcomer is honest, silently dropping
	// an established peer's inbox is not.
	MaxKeys int
	// MaxPresenceTTL / DefaultPresenceTTL bound an announce's requested lifetime.
	DefaultPresenceTTL time.Duration
	MaxPresenceTTL     time.Duration
	// Signal / mailbox blob lifetimes.
	DefaultSignalTTL  time.Duration
	MaxSignalTTL      time.Duration
	DefaultMailboxTTL time.Duration
	MaxMailboxTTL     time.Duration
	// ClockSkew is how far a request's `ts` may sit from the server's clock in
	// either direction before it is refused as stale (replay defence).
	ClockSkew time.Duration
	// MaxWait caps a long-poll's requested hold time.
	MaxWait time.Duration
	// MaxAckIDs caps the ids one ack may name.
	MaxAckIDs int
	// MaxNonces caps the replay cache. It is a bound on MEMORY, not on security:
	// entries only ever need to outlive the skew window, and the cache refuses
	// to grow past this by evicting already-expired entries first (and, if there
	// are none, by refusing the write rather than forgetting a live nonce).
	MaxNonces int
}

// DefaultLimits are sized for the traffic two-to-a-dozen collaborators actually
// generate, not for a public relay. Signalling frames are hundreds of bytes;
// 64 KiB is already generous. The whole state is bounded by
// MaxKeys × 2 queues × MaxQueueBytes ≈ 4096 × 2 × 256 KiB worst case, and in
// practice orders of magnitude less because queues drain on ack.
func DefaultLimits() Limits {
	return Limits{
		MaxPayloadBytes:    64 * 1024,
		MaxMetaBytes:       2 * 1024,
		MaxEndpoints:       8,
		MaxEndpointBytes:   256,
		MaxQueueBlobs:      64,
		MaxQueueBytes:      256 * 1024,
		MaxKeys:            4096,
		DefaultPresenceTTL: 5 * time.Minute,
		MaxPresenceTTL:     time.Hour,
		DefaultSignalTTL:   2 * time.Minute,
		MaxSignalTTL:       10 * time.Minute,
		DefaultMailboxTTL:  time.Hour,
		MaxMailboxTTL:      12 * time.Hour,
		ClockSkew:          5 * time.Minute,
		MaxWait:            25 * time.Second,
		MaxAckIDs:          128,
		MaxNonces:          65536,
	}
}

// Errors the HTTP layer maps to status codes. They are values (not formatted
// strings) so handlers classify by identity rather than by matching text.
var (
	ErrBadRequest   = errors.New("rendezvous: malformed request")
	ErrBadKey       = errors.New("rendezvous: key is not a base64url Ed25519 public key")
	ErrBadSignature = errors.New("rendezvous: signature does not verify")
	ErrStale        = errors.New("rendezvous: timestamp outside the accepted window")
	ErrReplay       = errors.New("rendezvous: nonce already used")
	ErrTooLarge     = errors.New("rendezvous: payload exceeds the configured limit")
	ErrCapacity     = errors.New("rendezvous: server at capacity")
	ErrNotFound     = errors.New("rendezvous: no presence record for that key")
)

// ── canonical message ───────────────────────────────────────────────────────

// CanonicalMessage builds the exact byte string the browser client signs: the
// domain tag followed by each field, every segment written as a 4-byte
// big-endian length and then its UTF-8 bytes.
//
// The length prefixes are what make it unambiguous: without them, an attacker
// could move bytes across a field boundary ("ab"+"c" and "a"+"bc" would sign
// identically) and re-purpose a signature for a different request. Every field
// crosses the wire as a string — binary as base64url, numbers as base-10 — so
// there is exactly one encoding to agree on.
func CanonicalMessage(domain string, fields ...string) []byte {
	total := 4 + len(domain)
	for _, f := range fields {
		total += 4 + len(f)
	}
	buf := make([]byte, total)
	off := 0
	put := func(s string) {
		binary.BigEndian.PutUint32(buf[off:], uint32(len(s)))
		off += 4
		off += copy(buf[off:], s)
	}
	put(domain)
	for _, f := range fields {
		put(f)
	}
	return buf
}

// b64 is the single binary encoding on the wire: unpadded base64url, matching
// the JS client's b64urlEncode/b64urlDecode.
var b64 = base64.RawURLEncoding

// DecodeKey parses a base64url Ed25519 public key. It is strict on purpose: a
// key is an ADDRESS in this protocol, so two spellings of one key would be two
// mailboxes, and a peer could be made unreachable by addressing the other
// spelling. Requiring the exact canonical form makes the address bijective.
func DecodeKey(s string) (ed25519.PublicKey, error) {
	if len(s) != b64.EncodedLen(ed25519.PublicKeySize) {
		return nil, ErrBadKey
	}
	raw, err := b64.DecodeString(s)
	if err != nil || len(raw) != ed25519.PublicKeySize {
		return nil, ErrBadKey
	}
	return ed25519.PublicKey(raw), nil
}

// verify checks sigB64 over msg for key. Any decode failure is a verification
// failure — never a pass — so a malformed signature cannot skip the check.
func verify(key ed25519.PublicKey, msg []byte, sigB64 string) error {
	sig, err := b64.DecodeString(sigB64)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return ErrBadSignature
	}
	if !ed25519.Verify(key, msg, sig) {
		return ErrBadSignature
	}
	return nil
}

// ── state ───────────────────────────────────────────────────────────────────

type presenceRec struct {
	endpoints []string
	meta      string
	expiresAt time.Time
}

type blob struct {
	id        string
	from      string
	payload   string // base64url, stored exactly as received and echoed back
	size      int    // decoded size, for the byte cap
	depositAt time.Time
	expiresAt time.Time
}

type queue struct {
	blobs []*blob
	bytes int
	// waiters are long-pollers parked on this queue. A deposit closes each
	// channel exactly once; a waiter that timed out has already removed itself.
	waiters []chan struct{}
}

// Service is the rendezvous state for one Diwan process: in-memory, bounded, and
// deliberately NOT persisted.
//
// Why nothing is written to disk: every record here is soft state with a TTL of
// minutes whose only purpose is to introduce two live browsers to each other. A
// restart drops it, both clients re-announce on their next heartbeat (see
// HEARTBEAT_MS in rendezvousSignaling.js) and the session re-forms. Persisting
// it would buy nothing and would turn a discovery cache into a durable log of
// who talked to whom — the opposite of what this surface should keep.
type Service struct {
	mu       sync.Mutex
	presence map[string]*presenceRec
	queues   map[string]*[2]*queue // key → {signal, mailbox}
	nonces   map[string]time.Time  // domain|key|nonce → expiry
	limits   Limits
	now      func() time.Time
	lastGC   time.Time
}

// New builds a Service. A zero-valued field in limits takes its DefaultLimits
// value, so callers can override one dimension without restating the rest.
func New(limits Limits) *Service {
	d := DefaultLimits()
	if limits.MaxPayloadBytes <= 0 {
		limits.MaxPayloadBytes = d.MaxPayloadBytes
	}
	if limits.MaxMetaBytes <= 0 {
		limits.MaxMetaBytes = d.MaxMetaBytes
	}
	if limits.MaxEndpoints <= 0 {
		limits.MaxEndpoints = d.MaxEndpoints
	}
	if limits.MaxEndpointBytes <= 0 {
		limits.MaxEndpointBytes = d.MaxEndpointBytes
	}
	if limits.MaxQueueBlobs <= 0 {
		limits.MaxQueueBlobs = d.MaxQueueBlobs
	}
	if limits.MaxQueueBytes <= 0 {
		limits.MaxQueueBytes = d.MaxQueueBytes
	}
	if limits.MaxKeys <= 0 {
		limits.MaxKeys = d.MaxKeys
	}
	if limits.DefaultPresenceTTL <= 0 {
		limits.DefaultPresenceTTL = d.DefaultPresenceTTL
	}
	if limits.MaxPresenceTTL <= 0 {
		limits.MaxPresenceTTL = d.MaxPresenceTTL
	}
	if limits.DefaultSignalTTL <= 0 {
		limits.DefaultSignalTTL = d.DefaultSignalTTL
	}
	if limits.MaxSignalTTL <= 0 {
		limits.MaxSignalTTL = d.MaxSignalTTL
	}
	if limits.DefaultMailboxTTL <= 0 {
		limits.DefaultMailboxTTL = d.DefaultMailboxTTL
	}
	if limits.MaxMailboxTTL <= 0 {
		limits.MaxMailboxTTL = d.MaxMailboxTTL
	}
	if limits.ClockSkew <= 0 {
		limits.ClockSkew = d.ClockSkew
	}
	if limits.MaxWait <= 0 {
		limits.MaxWait = d.MaxWait
	}
	if limits.MaxAckIDs <= 0 {
		limits.MaxAckIDs = d.MaxAckIDs
	}
	if limits.MaxNonces <= 0 {
		limits.MaxNonces = d.MaxNonces
	}
	return &Service{
		presence: make(map[string]*presenceRec),
		queues:   make(map[string]*[2]*queue),
		nonces:   make(map[string]time.Time),
		limits:   limits,
		now:      time.Now,
	}
}

// SetClock replaces the Service's time source. Test-only: it lets the TTL,
// clock-skew and replay-window behaviour be asserted deterministically instead
// of with sleeps, which is the difference between a test that proves expiry and
// a test that is merely slow.
func (s *Service) SetClock(now func() time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.now = now
}

// Limits returns the effective limits (after defaults were filled in).
func (s *Service) Limits() Limits { return s.limits }

// ── replay / freshness ──────────────────────────────────────────────────────

// checkFresh enforces the two halves of replay defence for one signed envelope:
// the timestamp must be inside the skew window, and the (domain, key, nonce)
// triple must not have been seen before. Both must hold, and the nonce is
// recorded only when the caller's signature has ALREADY verified — otherwise an
// unauthenticated flood could burn nonces on a key's behalf.
//
// Caller holds s.mu.
func (s *Service) checkFresh(domain, key, nonce string, ts int64) error {
	if nonce == "" || len(nonce) > 128 {
		return ErrBadRequest
	}
	now := s.now()
	t := time.Unix(ts, 0)
	skew := s.limits.ClockSkew
	if t.Before(now.Add(-skew)) || t.After(now.Add(skew)) {
		return ErrStale
	}
	id := domain + "|" + key + "|" + nonce
	if exp, ok := s.nonces[id]; ok && exp.After(now) {
		return ErrReplay
	}
	if len(s.nonces) >= s.limits.MaxNonces {
		s.gcNonces(now)
		if len(s.nonces) >= s.limits.MaxNonces {
			// Refuse rather than forget: dropping a live nonce would re-open the
			// replay window for exactly the request under attack.
			return ErrCapacity
		}
	}
	// An envelope can only be replayed while it is still inside the skew window,
	// so the nonce need not outlive that.
	s.nonces[id] = now.Add(skew * 2)
	return nil
}

func (s *Service) gcNonces(now time.Time) {
	for id, exp := range s.nonces {
		if !exp.After(now) {
			delete(s.nonces, id)
		}
	}
}

// gc drops expired presence records and blobs. Called opportunistically from
// write paths at most once every 30s, which keeps the state bounded without a
// background goroutine whose lifetime nothing in this process would own.
//
// Caller holds s.mu.
func (s *Service) gc() {
	now := s.now()
	if now.Sub(s.lastGC) < 30*time.Second {
		return
	}
	s.lastGC = now
	for k, p := range s.presence {
		if !p.expiresAt.After(now) {
			delete(s.presence, k)
		}
	}
	for k, qs := range s.queues {
		empty := true
		for i := range qs {
			q := qs[i]
			if q == nil {
				continue
			}
			kept := q.blobs[:0]
			bytes := 0
			for _, b := range q.blobs {
				if b.expiresAt.After(now) {
					kept = append(kept, b)
					bytes += b.size
				}
			}
			q.blobs = kept
			q.bytes = bytes
			if len(q.blobs) > 0 || len(q.waiters) > 0 {
				empty = false
			}
		}
		if empty {
			delete(s.queues, k)
		}
	}
	s.gcNonces(now)
}

// touchedKeys reports how many distinct keys currently hold state.
// Caller holds s.mu.
func (s *Service) keyCount() int {
	n := len(s.presence)
	for k := range s.queues {
		if _, dup := s.presence[k]; !dup {
			n++
		}
	}
	return n
}

// queueFor returns the queue for (key, kind), creating it if allowed. It returns
// ErrCapacity when a NEW key would push the process past MaxKeys.
//
// Caller holds s.mu.
func (s *Service) queueFor(key string, kind queueKind, create bool) (*queue, error) {
	qs, ok := s.queues[key]
	if !ok {
		if !create {
			return nil, nil
		}
		if _, known := s.presence[key]; !known && s.keyCount() >= s.limits.MaxKeys {
			return nil, ErrCapacity
		}
		qs = &[2]*queue{}
		s.queues[key] = qs
	}
	if qs[kind] == nil {
		if !create {
			return nil, nil
		}
		qs[kind] = &queue{}
	}
	return qs[kind], nil
}

func newBlobID() string {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand failing is not a condition this process can paper over: a
		// predictable blob id would let a third party ack (delete) another
		// peer's signalling frames. Refuse loudly instead.
		panic("rendezvous: crypto/rand unavailable: " + err.Error())
	}
	return b64.EncodeToString(b)
}
