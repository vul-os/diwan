package rendezvous

import (
	"time"
)

// This file holds the protocol OPERATIONS. They are pure state transitions over
// Service with no net/http in sight, so each one can be tested for exactly what
// it accepts and refuses without a server, and the HTTP layer (handler.go) is
// reduced to decoding, status mapping, and long-poll plumbing.
//
// Every operation follows the same order, and the order is the security
// property: parse → verify the signature → check freshness → enforce limits →
// mutate. Verification precedes freshness so an unauthenticated caller cannot
// burn a real key's nonces; limits precede mutation so a refused request stores
// nothing.

// ── announce / withdraw / resolve ───────────────────────────────────────────

// AnnounceRequest is the wire body of POST /announce.
type AnnounceRequest struct {
	Key       string   `json:"key"`
	Endpoints []string `json:"endpoints"`
	Meta      string   `json:"meta"`
	TTL       int64    `json:"ttl"`
	Nonce     string   `json:"nonce"`
	TS        int64    `json:"ts"`
	Sig       string   `json:"sig"`
}

// AnnounceResult is the wire response of POST /announce.
type AnnounceResult struct {
	OK        bool   `json:"ok"`
	Key       string `json:"key"`
	TTL       int64  `json:"ttl"`
	ExpiresAt int64  `json:"expires_at"`
}

// Announce publishes a presence record for req.Key, valid for a clamped TTL.
//
// The endpoints and meta are stored and echoed VERBATIM and never interpreted:
// the server does not dial them, resolve them, or validate their shape beyond a
// size cap. They are hints one peer leaves for another, and treating them as
// data rather than as instructions is what keeps this surface incapable of being
// turned into an SSRF lever.
func (s *Service) Announce(req AnnounceRequest) (AnnounceResult, error) {
	pub, err := DecodeKey(req.Key)
	if err != nil {
		return AnnounceResult{}, err
	}
	if len(req.Meta) > s.limits.MaxMetaBytes {
		return AnnounceResult{}, ErrTooLarge
	}
	if len(req.Endpoints) > s.limits.MaxEndpoints {
		return AnnounceResult{}, ErrTooLarge
	}
	for _, e := range req.Endpoints {
		if len(e) > s.limits.MaxEndpointBytes {
			return AnnounceResult{}, ErrTooLarge
		}
	}
	fields := append([]string{
		req.Key, itoa(req.TS), itoa(req.TTL), req.Nonce, req.Meta,
	}, req.Endpoints...)
	if err := verify(pub, CanonicalMessage(DomainAnnounce, fields...), req.Sig); err != nil {
		return AnnounceResult{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.checkFresh(DomainAnnounce, req.Key, req.Nonce, req.TS); err != nil {
		return AnnounceResult{}, err
	}
	s.gc()

	ttl := clampTTL(time.Duration(req.TTL)*time.Second, s.limits.DefaultPresenceTTL, s.limits.MaxPresenceTTL)
	now := s.now()
	// A re-announce of a key we already hold is a refresh, not a new key, so it
	// must never be refused for capacity — a heartbeat losing to a capacity cap
	// would drop an ESTABLISHED session while admitting strangers.
	if _, known := s.presence[req.Key]; !known {
		if _, hasQueue := s.queues[req.Key]; !hasQueue && s.keyCount() >= s.limits.MaxKeys {
			return AnnounceResult{}, ErrCapacity
		}
	}
	eps := make([]string, len(req.Endpoints))
	copy(eps, req.Endpoints)
	exp := now.Add(ttl)
	s.presence[req.Key] = &presenceRec{endpoints: eps, meta: req.Meta, expiresAt: exp}
	return AnnounceResult{OK: true, Key: req.Key, TTL: int64(ttl.Seconds()), ExpiresAt: exp.Unix()}, nil
}

// WithdrawRequest is the wire body of POST /withdraw.
type WithdrawRequest struct {
	Key   string `json:"key"`
	Nonce string `json:"nonce"`
	TS    int64  `json:"ts"`
	Sig   string `json:"sig"`
}

// Withdraw removes req.Key's presence record. Only the key itself can withdraw
// it (the signature is over the key's own name), so presence cannot be censored
// by a third party.
//
// Queued blobs are deliberately LEFT in place: a peer that goes away for a
// moment and comes back should still find what was addressed to it, and those
// blobs expire on their own TTL anyway.
func (s *Service) Withdraw(req WithdrawRequest) error {
	pub, err := DecodeKey(req.Key)
	if err != nil {
		return err
	}
	msg := CanonicalMessage(DomainWithdraw, req.Key, itoa(req.TS), req.Nonce)
	if err := verify(pub, msg, req.Sig); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.checkFresh(DomainWithdraw, req.Key, req.Nonce, req.TS); err != nil {
		return err
	}
	delete(s.presence, req.Key)
	s.gc()
	return nil
}

// Presence is the wire response of GET /resolve/:key.
type Presence struct {
	Key       string   `json:"key"`
	Online    bool     `json:"online"`
	Endpoints []string `json:"endpoints,omitempty"`
	Meta      string   `json:"meta,omitempty"`
	ExpiresAt int64    `json:"expires_at,omitempty"`
}

// Resolve reads a presence record. Unauthenticated, because it returns only what
// its subject chose to publish about itself; ErrNotFound when absent or expired
// (the handler renders that as 404 with `online:false`, which is what the JS
// client already treats as "offline").
func (s *Service) Resolve(key string) (Presence, error) {
	if _, err := DecodeKey(key); err != nil {
		return Presence{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.presence[key]
	if !ok || !p.expiresAt.After(s.now()) {
		return Presence{Key: key, Online: false}, ErrNotFound
	}
	eps := make([]string, len(p.endpoints))
	copy(eps, p.endpoints)
	return Presence{
		Key: key, Online: true, Endpoints: eps, Meta: p.meta, ExpiresAt: p.expiresAt.Unix(),
	}, nil
}

// ── deposit / poll / ack ────────────────────────────────────────────────────

// DepositRequest is the wire body of POST /signal/:key and POST /mailbox/:key.
type DepositRequest struct {
	From    string `json:"from"`
	To      string `json:"to"`
	Payload string `json:"payload"` // base64url, opaque
	TTL     int64  `json:"ttl"`
	Nonce   string `json:"nonce"`
	TS      int64  `json:"ts"`
	Sig     string `json:"sig"`
}

// DepositResult is the wire response of a deposit. The id is what the RECIPIENT
// later acks; the client also keeps it to replace its own previous presence-board
// blob (see _announceAndJoin in rendezvousSignaling.js).
type DepositResult struct {
	OK        bool   `json:"ok"`
	ID        string `json:"id"`
	ExpiresAt int64  `json:"expires_at"`
}

// Deposit queues an opaque payload for the recipient key.
//
// The signature is by the SENDER over both addresses and the payload, so a blob
// carries proof of who deposited it and cannot be re-addressed to a different
// recipient by anything in the middle. The recipient key is taken from the URL
// and must equal req.To — the handler passes both — so a signature over one
// address can never be spent on another.
//
// pathKey is the recipient from the URL; it is compared to req.To.
func (s *Service) Deposit(kind queueKind, pathKey string, req DepositRequest) (DepositResult, error) {
	if pathKey != req.To {
		return DepositResult{}, ErrBadRequest
	}
	from, err := DecodeKey(req.From)
	if err != nil {
		return DepositResult{}, err
	}
	if _, err := DecodeKey(req.To); err != nil {
		return DepositResult{}, err
	}
	// Size is checked on the DECODED length so the cap means what it says
	// regardless of encoding overhead, and the decode also rejects a payload that
	// is not valid base64url before it can be stored and echoed to a peer.
	raw, decErr := b64.DecodeString(req.Payload)
	if decErr != nil {
		return DepositResult{}, ErrBadRequest
	}
	if len(raw) > s.limits.MaxPayloadBytes {
		return DepositResult{}, ErrTooLarge
	}
	domain := DomainSignalDeposit
	if kind == queueMailbox {
		domain = DomainMailboxDeposit
	}
	msg := CanonicalMessage(domain, req.From, req.To, itoa(req.TS), itoa(req.TTL), req.Nonce, req.Payload)
	if err := verify(from, msg, req.Sig); err != nil {
		return DepositResult{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.checkFresh(domain, req.From, req.Nonce, req.TS); err != nil {
		return DepositResult{}, err
	}
	s.gc()

	def, max := s.limits.DefaultSignalTTL, s.limits.MaxSignalTTL
	if kind == queueMailbox {
		def, max = s.limits.DefaultMailboxTTL, s.limits.MaxMailboxTTL
	}
	ttl := clampTTL(time.Duration(req.TTL)*time.Second, def, max)

	q, err := s.queueFor(req.To, kind, true)
	if err != nil {
		return DepositResult{}, err
	}
	now := s.now()
	b := &blob{
		id:        newBlobID(),
		from:      req.From,
		payload:   req.Payload,
		size:      len(raw),
		depositAt: now,
		expiresAt: now.Add(ttl),
	}
	q.blobs = append(q.blobs, b)
	q.bytes += b.size
	// Oldest-first eviction at the cap: in a signalling queue the newest frame is
	// the valuable one, and refusing the newest would stall a live negotiation.
	for len(q.blobs) > s.limits.MaxQueueBlobs || q.bytes > s.limits.MaxQueueBytes {
		q.bytes -= q.blobs[0].size
		q.blobs = q.blobs[1:]
	}
	s.wake(q)
	return DepositResult{OK: true, ID: b.id, ExpiresAt: b.expiresAt.Unix()}, nil
}

// wake releases every long-poller parked on q. Caller holds s.mu.
func (s *Service) wake(q *queue) {
	for _, ch := range q.waiters {
		close(ch)
	}
	q.waiters = nil
}

// PollRequest is the wire body of POST /{signal,mailbox}/:key/poll.
type PollRequest struct {
	Key   string `json:"key"`
	Nonce string `json:"nonce"`
	TS    int64  `json:"ts"`
	Wait  int64  `json:"wait"`
	Sig   string `json:"sig"`
}

// Blob is one queued item as the wire renders it.
type Blob struct {
	ID      string `json:"id"`
	From    string `json:"from"`
	Payload string `json:"payload"`
	TS      int64  `json:"ts"`
	Exp     int64  `json:"exp"`
}

// PollResult is the wire response of a poll.
type PollResult struct {
	Blobs []Blob `json:"blobs"`
}

// authPoll verifies a poll envelope and returns the wait duration to honour.
// Split out from Poll so the handler can verify FIRST, then block, then read —
// an unverified request must never be able to hold a connection open.
//
// NOTE the signed fields: key, ts, nonce — NOT wait. That matches the JS client
// byte-for-byte (`_poll` signs [key, ts, nonce]); `wait` is a hint about how long
// the caller is willing to be parked, and it is clamped server-side, so leaving
// it unsigned grants an attacker who tampers with it nothing a legitimate caller
// could not ask for anyway.
func (s *Service) authPoll(kind queueKind, pathKey string, req PollRequest) (time.Duration, error) {
	if pathKey != req.Key {
		return 0, ErrBadRequest
	}
	pub, err := DecodeKey(req.Key)
	if err != nil {
		return 0, err
	}
	domain := DomainSignalPoll
	if kind == queueMailbox {
		domain = DomainMailboxPoll
	}
	msg := CanonicalMessage(domain, req.Key, itoa(req.TS), req.Nonce)
	if err := verify(pub, msg, req.Sig); err != nil {
		return 0, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.checkFresh(domain, req.Key, req.Nonce, req.TS); err != nil {
		return 0, err
	}
	wait := time.Duration(req.Wait) * time.Second
	if wait < 0 {
		wait = 0
	}
	if wait > s.limits.MaxWait {
		wait = s.limits.MaxWait
	}
	return wait, nil
}

// Read returns the CURRENT contents of a key's queue WITHOUT deleting anything.
//
// Non-destructive reads are load-bearing, not an oversight. The session
// "presence board" is one key's inbox that EVERY member of a room polls (they all
// derive the same room identity), so a destructive read would mean the first
// member to poll consumed everyone else's presence and nobody would ever
// discover anybody. Deletion is a separate, explicit Ack.
//
// Callers must have passed authPoll first.
func (s *Service) Read(kind queueKind, key string) PollResult {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.readLocked(kind, key)
}

func (s *Service) readLocked(kind queueKind, key string) PollResult {
	out := PollResult{Blobs: []Blob{}}
	qs, ok := s.queues[key]
	if !ok || qs[kind] == nil {
		return out
	}
	now := s.now()
	for _, b := range qs[kind].blobs {
		if !b.expiresAt.After(now) {
			continue
		}
		out.Blobs = append(out.Blobs, Blob{
			ID: b.id, From: b.from, Payload: b.payload,
			TS: b.depositAt.Unix(), Exp: b.expiresAt.Unix(),
		})
	}
	return out
}

// park registers a long-poll waiter on a key's queue and returns the channel to
// select on, or nil when there is already something to read. Caller must NOT
// hold s.mu.
func (s *Service) park(kind queueKind, key string) chan struct{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.readLocked(kind, key).Blobs) > 0 {
		return nil
	}
	q, err := s.queueFor(key, kind, true)
	if err != nil || q == nil {
		// At capacity we simply do not park: the caller returns an empty result
		// immediately rather than holding a connection open for a queue we are
		// not willing to allocate.
		return nil
	}
	ch := make(chan struct{})
	q.waiters = append(q.waiters, ch)
	return ch
}

// unpark removes a waiter that gave up (timeout or client disconnect) so an
// abandoned long-poll cannot leak a channel into the queue for the rest of the
// process's life.
func (s *Service) unpark(kind queueKind, key string, ch chan struct{}) {
	s.mu.Lock()
	defer s.mu.Unlock()
	qs, ok := s.queues[key]
	if !ok || qs[kind] == nil {
		return
	}
	q := qs[kind]
	for i, w := range q.waiters {
		if w == ch {
			q.waiters = append(q.waiters[:i], q.waiters[i+1:]...)
			return
		}
	}
}

// AckRequest is the wire body of POST /{signal,mailbox}/:key/ack.
type AckRequest struct {
	Key   string   `json:"key"`
	IDs   []string `json:"ids"`
	Nonce string   `json:"nonce"`
	TS    int64    `json:"ts"`
	Sig   string   `json:"sig"`
}

// AckResult is the wire response of an ack.
type AckResult struct {
	Deleted int `json:"deleted"`
}

// Ack deletes named blobs from a key's OWN queue.
//
// Authority is the INBOX OWNER's: the signature is by the key whose queue is
// being pruned, and only ids in that queue can be deleted. A third party
// therefore cannot delete a peer's pending signalling frames, and one room
// member acking the board (which every member can, since they all hold the room
// key) is a deliberate protocol behaviour rather than a hole.
func (s *Service) Ack(kind queueKind, pathKey string, req AckRequest) (AckResult, error) {
	if pathKey != req.Key {
		return AckResult{}, ErrBadRequest
	}
	pub, err := DecodeKey(req.Key)
	if err != nil {
		return AckResult{}, err
	}
	if len(req.IDs) > s.limits.MaxAckIDs {
		return AckResult{}, ErrTooLarge
	}
	domain := DomainSignalAck
	if kind == queueMailbox {
		domain = DomainMailboxAck
	}
	fields := append([]string{req.Key, itoa(req.TS), req.Nonce}, req.IDs...)
	if err := verify(pub, CanonicalMessage(domain, fields...), req.Sig); err != nil {
		return AckResult{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.checkFresh(domain, req.Key, req.Nonce, req.TS); err != nil {
		return AckResult{}, err
	}
	qs, ok := s.queues[req.Key]
	if !ok || qs[kind] == nil {
		return AckResult{Deleted: 0}, nil
	}
	q := qs[kind]
	drop := make(map[string]struct{}, len(req.IDs))
	for _, id := range req.IDs {
		drop[id] = struct{}{}
	}
	kept := q.blobs[:0]
	deleted, bytes := 0, 0
	for _, b := range q.blobs {
		if _, gone := drop[b.id]; gone {
			deleted++
			continue
		}
		kept = append(kept, b)
		bytes += b.size
	}
	q.blobs = kept
	q.bytes = bytes
	return AckResult{Deleted: deleted}, nil
}

// ── helpers ─────────────────────────────────────────────────────────────────

// clampTTL applies "0 means default, anything else is clamped to [1s, max]".
func clampTTL(req, def, max time.Duration) time.Duration {
	if req <= 0 {
		return def
	}
	if req > max {
		return max
	}
	return req
}

// itoa formats an int64 in base 10 — the ONE numeric spelling the canonical
// message uses on both sides of the wire.
func itoa(v int64) string {
	if v == 0 {
		return "0"
	}
	neg := v < 0
	var buf [20]byte
	i := len(buf)
	u := v
	if neg {
		u = -v
	}
	for u > 0 {
		i--
		buf[i] = byte('0' + u%10)
		u /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
