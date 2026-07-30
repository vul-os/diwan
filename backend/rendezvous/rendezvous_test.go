package rendezvous

import (
	"bytes"
	"crypto/ed25519"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

// These tests exercise the surface the way an attacker and a browser both do:
// over real HTTP, with real Ed25519 signatures. The point is not that the happy
// path works (it obviously must) but that every REFUSAL is a refusal — nothing is
// stored, nothing is delivered, and the status says which rule was broken.

func init() { gin.SetMode(gin.TestMode) }

// ── test identity + signing (mirrors src/lib/collab/webrtc/rendezvous.js) ────

type ident struct {
	pub  ed25519.PublicKey
	priv ed25519.PrivateKey
	key  string
}

func newIdent(t *testing.T, seed byte) *ident {
	t.Helper()
	s := bytes.Repeat([]byte{seed}, ed25519.SeedSize)
	priv := ed25519.NewKeyFromSeed(s)
	pub := priv.Public().(ed25519.PublicKey)
	return &ident{pub: pub, priv: priv, key: b64.EncodeToString(pub)}
}

func (i *ident) sign(domain string, fields ...string) string {
	return b64.EncodeToString(ed25519.Sign(i.priv, CanonicalMessage(domain, fields...)))
}

// ── harness ─────────────────────────────────────────────────────────────────

type harness struct {
	t   *testing.T
	svc *Service
	r   *gin.Engine
	now time.Time
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	svc := New(Limits{})
	h := &harness{t: t, svc: svc, r: gin.New(), now: time.Unix(1_800_000_000, 0)}
	svc.SetClock(func() time.Time { return h.now })
	Mount(h.r, svc)
	return h
}

// advance moves the harness clock. Every TTL / skew / replay assertion below uses
// this rather than time.Sleep, so the suite proves expiry instead of waiting for
// it (and cannot flake on a slow machine).
func (h *harness) advance(d time.Duration) { h.now = h.now.Add(d) }

func (h *harness) post(path string, body any) (*httptest.ResponseRecorder, map[string]any) {
	h.t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		h.t.Fatalf("marshal: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.r.ServeHTTP(w, req)
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w, out
}

func (h *harness) get(path string) (*httptest.ResponseRecorder, map[string]any) {
	h.t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	w := httptest.NewRecorder()
	h.r.ServeHTTP(w, req)
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w, out
}

func (h *harness) ts() int64 { return h.now.Unix() }

func i64(v int64) string { return strconv.FormatInt(v, 10) }

// announce builds and posts a well-formed announce for id, with an overridable
// nonce so replay can be exercised.
func (h *harness) announce(id *ident, nonce string, ttl int64) (*httptest.ResponseRecorder, map[string]any) {
	req := AnnounceRequest{
		Key: id.key, Endpoints: []string{}, Meta: "vulos-fabric", TTL: ttl,
		Nonce: nonce, TS: h.ts(),
	}
	req.Sig = id.sign(DomainAnnounce, req.Key, i64(req.TS), i64(req.TTL), req.Nonce, req.Meta)
	return h.post(Prefix+"/announce", req)
}

// deposit posts a signal deposit from `from` to `to`.
func (h *harness) deposit(from *ident, to string, payload string, nonce string) (*httptest.ResponseRecorder, map[string]any) {
	req := DepositRequest{From: from.key, To: to, Payload: payload, TTL: 0, Nonce: nonce, TS: h.ts()}
	req.Sig = from.sign(DomainSignalDeposit, req.From, req.To, i64(req.TS), i64(req.TTL), req.Nonce, req.Payload)
	return h.post(Prefix+"/signal/"+to, req)
}

// poll posts a (non-blocking) signal poll for id's own inbox.
func (h *harness) poll(id *ident, nonce string) (*httptest.ResponseRecorder, map[string]any) {
	req := PollRequest{Key: id.key, Nonce: nonce, TS: h.ts(), Wait: 0}
	req.Sig = id.sign(DomainSignalPoll, req.Key, i64(req.TS), req.Nonce)
	return h.post(Prefix+"/signal/"+id.key+"/poll", req)
}

func (h *harness) ack(id *ident, ids []string, nonce string) (*httptest.ResponseRecorder, map[string]any) {
	req := AckRequest{Key: id.key, IDs: ids, Nonce: nonce, TS: h.ts()}
	req.Sig = id.sign(DomainSignalAck, append([]string{req.Key, i64(req.TS), req.Nonce}, ids...)...)
	return h.post(Prefix+"/signal/"+id.key+"/ack", req)
}

func blobsOf(t *testing.T, body map[string]any) []map[string]any {
	t.Helper()
	raw, ok := body["blobs"].([]any)
	if !ok {
		t.Fatalf("no blobs array in %v", body)
	}
	out := make([]map[string]any, 0, len(raw))
	for _, b := range raw {
		m, ok := b.(map[string]any)
		if !ok {
			t.Fatalf("blob is not an object: %#v", b)
		}
		out = append(out, m)
	}
	return out
}

// ── the happy path, end to end ──────────────────────────────────────────────

// The whole point of the surface in one test: A deposits for B, B reads it, B
// acks it, and it is gone. If this passes, two browsers can be introduced.
func TestSignalRoundTrip(t *testing.T) {
	h := newHarness(t)
	a, b := newIdent(t, 1), newIdent(t, 2)

	payload := b64.EncodeToString([]byte(`{"type":"offer"}`))
	w, body := h.deposit(a, b.key, payload, "n-dep-1")
	if w.Code != http.StatusOK {
		t.Fatalf("deposit: got %d %s", w.Code, w.Body.String())
	}
	id, _ := body["id"].(string)
	if id == "" {
		t.Fatalf("deposit returned no id: %v", body)
	}

	w, body = h.poll(b, "n-poll-1")
	if w.Code != http.StatusOK {
		t.Fatalf("poll: got %d %s", w.Code, w.Body.String())
	}
	blobs := blobsOf(t, body)
	if len(blobs) != 1 {
		t.Fatalf("want 1 blob, got %d: %v", len(blobs), body)
	}
	if got := blobs[0]["from"]; got != a.key {
		t.Errorf("blob from: want %s, got %v", a.key, got)
	}
	if got := blobs[0]["payload"]; got != payload {
		t.Errorf("payload round-trip: want %s, got %v", payload, got)
	}

	// A second poll must STILL see it: reads are non-destructive so every member
	// of a room can read the shared presence board.
	w, body = h.poll(b, "n-poll-2")
	if w.Code != http.StatusOK || len(blobsOf(t, body)) != 1 {
		t.Fatalf("second poll should still see the blob: %d %s", w.Code, w.Body.String())
	}

	w, body = h.ack(b, []string{id}, "n-ack-1")
	if w.Code != http.StatusOK {
		t.Fatalf("ack: got %d %s", w.Code, w.Body.String())
	}
	if got := body["deleted"]; got != float64(1) {
		t.Errorf("deleted: want 1, got %v", got)
	}
	_, body = h.poll(b, "n-poll-3")
	if n := len(blobsOf(t, body)); n != 0 {
		t.Errorf("after ack: want 0 blobs, got %d", n)
	}
}

func TestAnnounceResolveWithdraw(t *testing.T) {
	h := newHarness(t)
	a := newIdent(t, 3)

	w, _ := h.announce(a, "n-1", 0)
	if w.Code != http.StatusOK {
		t.Fatalf("announce: %d %s", w.Code, w.Body.String())
	}

	w, body := h.get(Prefix + "/resolve/" + a.key)
	if w.Code != http.StatusOK {
		t.Fatalf("resolve: %d %s", w.Code, w.Body.String())
	}
	if body["online"] != true {
		t.Errorf("want online:true, got %v", body)
	}
	if body["meta"] != "vulos-fabric" {
		t.Errorf("meta not echoed: %v", body)
	}

	// Presence expires on its own TTL — no withdraw needed for a peer that
	// vanished without saying goodbye.
	h.advance(h.svc.Limits().DefaultPresenceTTL + time.Second)
	w, body = h.get(Prefix + "/resolve/" + a.key)
	if w.Code != http.StatusNotFound {
		t.Fatalf("expired presence: want 404, got %d", w.Code)
	}
	if body["online"] != false {
		t.Errorf("404 body must say online:false, got %v", body)
	}

	// Re-announce, then withdraw explicitly.
	if w, _ := h.announce(a, "n-2", 0); w.Code != http.StatusOK {
		t.Fatalf("re-announce: %d", w.Code)
	}
	req := WithdrawRequest{Key: a.key, Nonce: "n-3", TS: h.ts()}
	req.Sig = a.sign(DomainWithdraw, req.Key, i64(req.TS), req.Nonce)
	if w, _ := h.post(Prefix+"/withdraw", req); w.Code != http.StatusOK {
		t.Fatalf("withdraw: %d", w.Code)
	}
	if w, _ := h.get(Prefix + "/resolve/" + a.key); w.Code != http.StatusNotFound {
		t.Fatalf("after withdraw: want 404, got %d", w.Code)
	}
}

// ── refusals ────────────────────────────────────────────────────────────────

// A forged signature must be refused AND must store nothing. Checking the second
// half matters: a surface that 403s but keeps the record would still let an
// attacker publish presence.
func TestForgedSignatureIsRefusedAndStoresNothing(t *testing.T) {
	h := newHarness(t)
	victim, attacker := newIdent(t, 4), newIdent(t, 5)

	// The attacker signs with ITS key but claims the victim's.
	req := AnnounceRequest{Key: victim.key, Meta: "impostor", TTL: 0, Nonce: "n-f", TS: h.ts()}
	req.Sig = attacker.sign(DomainAnnounce, req.Key, i64(req.TS), i64(req.TTL), req.Nonce, req.Meta)
	w, _ := h.post(Prefix+"/announce", req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("forged announce: want 403, got %d %s", w.Code, w.Body.String())
	}
	if w, _ := h.get(Prefix + "/resolve/" + victim.key); w.Code != http.StatusNotFound {
		t.Fatalf("forged announce must store nothing: resolve got %d", w.Code)
	}

	// Same for a deposit: forging the `from` address must not queue anything.
	payload := b64.EncodeToString([]byte("x"))
	dep := DepositRequest{From: victim.key, To: victim.key, Payload: payload, Nonce: "n-g", TS: h.ts()}
	dep.Sig = attacker.sign(DomainSignalDeposit, dep.From, dep.To, i64(dep.TS), i64(dep.TTL), dep.Nonce, dep.Payload)
	if w, _ := h.post(Prefix+"/signal/"+victim.key, dep); w.Code != http.StatusForbidden {
		t.Fatalf("forged deposit: want 403, got %d", w.Code)
	}
	_, body := h.poll(victim, "n-h")
	if n := len(blobsOf(t, body)); n != 0 {
		t.Fatalf("forged deposit must queue nothing, got %d blobs", n)
	}
}

// A signature is valid for exactly ONE domain. Without domain separation, an
// announce signature could be spent as a withdraw (both sign key/ts/nonce), so
// one captured heartbeat would let anyone delete a peer's presence.
func TestSignatureIsNotTransferableAcrossDomains(t *testing.T) {
	h := newHarness(t)
	a := newIdent(t, 6)
	if w, _ := h.announce(a, "n-dom-1", 0); w.Code != http.StatusOK {
		t.Fatalf("announce: %d", w.Code)
	}

	// A WITHDRAW body signed under the ANNOUNCE domain over the same three fields.
	req := WithdrawRequest{Key: a.key, Nonce: "n-dom-2", TS: h.ts()}
	req.Sig = a.sign(DomainAnnounce, req.Key, i64(req.TS), req.Nonce)
	if w, _ := h.post(Prefix+"/withdraw", req); w.Code != http.StatusForbidden {
		t.Fatalf("cross-domain signature: want 403, got %d", w.Code)
	}
	if w, _ := h.get(Prefix + "/resolve/" + a.key); w.Code != http.StatusOK {
		t.Fatalf("presence must survive a refused withdraw, got %d", w.Code)
	}
}

// Replay: the identical, correctly-signed envelope sent twice. The second must be
// refused — otherwise a captured request can be re-flown for as long as its
// signature is valid, which is forever.
func TestReplayIsRefused(t *testing.T) {
	h := newHarness(t)
	a, b := newIdent(t, 7), newIdent(t, 8)

	payload := b64.EncodeToString([]byte("dup"))
	req := DepositRequest{From: a.key, To: b.key, Payload: payload, Nonce: "n-replay", TS: h.ts()}
	req.Sig = a.sign(DomainSignalDeposit, req.From, req.To, i64(req.TS), i64(req.TTL), req.Nonce, req.Payload)

	if w, _ := h.post(Prefix+"/signal/"+b.key, req); w.Code != http.StatusOK {
		t.Fatalf("first deposit: %d", w.Code)
	}
	w, _ := h.post(Prefix+"/signal/"+b.key, req)
	if w.Code != http.StatusConflict {
		t.Fatalf("replayed deposit: want 409, got %d %s", w.Code, w.Body.String())
	}
	_, body := h.poll(b, "n-replay-poll")
	if n := len(blobsOf(t, body)); n != 1 {
		t.Fatalf("replay must not duplicate the blob: got %d", n)
	}
}

// A timestamp outside the skew window is refused in BOTH directions. A
// far-future ts would otherwise let an attacker mint an envelope now and hold it
// to replay long after the nonce cache has forgotten it.
func TestStaleAndFutureTimestampsAreRefused(t *testing.T) {
	h := newHarness(t)
	a := newIdent(t, 9)
	skew := h.svc.Limits().ClockSkew

	for _, tc := range []struct {
		name  string
		offAt time.Duration
	}{
		{"too old", -(skew + time.Minute)},
		{"too far in the future", skew + time.Minute},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ts := h.now.Add(tc.offAt).Unix()
			req := AnnounceRequest{Key: a.key, Meta: "", TTL: 0, Nonce: "n-" + tc.name, TS: ts}
			req.Sig = a.sign(DomainAnnounce, req.Key, i64(req.TS), i64(req.TTL), req.Nonce, req.Meta)
			w, _ := h.post(Prefix+"/announce", req)
			if w.Code != http.StatusConflict {
				t.Fatalf("want 409, got %d %s", w.Code, w.Body.String())
			}
			if w, _ := h.get(Prefix + "/resolve/" + a.key); w.Code != http.StatusNotFound {
				t.Fatalf("stale announce must store nothing, resolve got %d", w.Code)
			}
		})
	}
}

// The recipient in the URL and the one in the signed body must agree. If they did
// not have to, a signature addressed to peer B could be re-posted to peer C's
// queue — a routing forgery that needs no key at all.
func TestPathAndBodyRecipientMustAgree(t *testing.T) {
	h := newHarness(t)
	a, b, c := newIdent(t, 10), newIdent(t, 11), newIdent(t, 12)

	payload := b64.EncodeToString([]byte("misroute"))
	req := DepositRequest{From: a.key, To: b.key, Payload: payload, Nonce: "n-mis", TS: h.ts()}
	req.Sig = a.sign(DomainSignalDeposit, req.From, req.To, i64(req.TS), i64(req.TTL), req.Nonce, req.Payload)

	// Posted to C's queue while signed for B.
	if w, _ := h.post(Prefix+"/signal/"+c.key, req); w.Code != http.StatusBadRequest {
		t.Fatalf("mismatched recipient: want 400, got %d", w.Code)
	}
	_, body := h.poll(c, "n-mis-poll")
	if n := len(blobsOf(t, body)); n != 0 {
		t.Fatalf("mismatched deposit must queue nothing, got %d", n)
	}
}

// Only the inbox owner may ack. A third party deleting another peer's pending
// offer/answer frames would be a denial of service that needs no crypto.
func TestOnlyInboxOwnerCanAck(t *testing.T) {
	h := newHarness(t)
	a, b, evil := newIdent(t, 13), newIdent(t, 14), newIdent(t, 15)

	_, body := h.deposit(a, b.key, b64.EncodeToString([]byte("keep")), "n-ack-dep")
	id, _ := body["id"].(string)
	if id == "" {
		t.Fatal("no blob id")
	}

	// evil signs an ack for B's queue with its own key.
	req := AckRequest{Key: b.key, IDs: []string{id}, Nonce: "n-evil", TS: h.ts()}
	req.Sig = evil.sign(DomainSignalAck, append([]string{req.Key, i64(req.TS), req.Nonce}, req.IDs...)...)
	if w, _ := h.post(Prefix+"/signal/"+b.key+"/ack", req); w.Code != http.StatusForbidden {
		t.Fatalf("third-party ack: want 403, got %d", w.Code)
	}
	_, body = h.poll(b, "n-evil-poll")
	if n := len(blobsOf(t, body)); n != 1 {
		t.Fatalf("third-party ack must delete nothing, got %d blobs", n)
	}
}

// One peer must not be able to read another's inbox: the poll is signed by the
// key whose queue it names, and a mismatch is refused before anything is read.
func TestPollCannotReadAnotherKeysInbox(t *testing.T) {
	h := newHarness(t)
	a, b, snoop := newIdent(t, 16), newIdent(t, 17), newIdent(t, 18)
	h.deposit(a, b.key, b64.EncodeToString([]byte("private")), "n-priv")

	// Signed by snoop for its own key, but posted at B's path.
	req := PollRequest{Key: snoop.key, Nonce: "n-snoop", TS: h.ts()}
	req.Sig = snoop.sign(DomainSignalPoll, req.Key, i64(req.TS), req.Nonce)
	w, _ := h.post(Prefix+"/signal/"+b.key+"/poll", req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("cross-key poll: want 400, got %d %s", w.Code, w.Body.String())
	}

	// And claiming B's key without B's private key fails verification.
	req = PollRequest{Key: b.key, Nonce: "n-snoop-2", TS: h.ts()}
	req.Sig = snoop.sign(DomainSignalPoll, req.Key, i64(req.TS), req.Nonce)
	w, body := h.post(Prefix+"/signal/"+b.key+"/poll", req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("forged poll: want 403, got %d", w.Code)
	}
	if _, leaked := body["blobs"]; leaked {
		t.Fatalf("a refused poll must not return blobs: %v", body)
	}
}

// A blob expires on its own TTL even if nobody ever acks it, so an inbox nobody
// drains cannot grow without bound.
func TestBlobsExpire(t *testing.T) {
	h := newHarness(t)
	a, b := newIdent(t, 19), newIdent(t, 20)
	h.deposit(a, b.key, b64.EncodeToString([]byte("transient")), "n-exp")

	_, body := h.poll(b, "n-exp-1")
	if n := len(blobsOf(t, body)); n != 1 {
		t.Fatalf("want 1 blob before expiry, got %d", n)
	}
	h.advance(h.svc.Limits().DefaultSignalTTL + time.Second)
	_, body = h.poll(b, "n-exp-2")
	if n := len(blobsOf(t, body)); n != 0 {
		t.Fatalf("want 0 blobs after TTL, got %d", n)
	}
}

// An oversize payload is refused, and refused BEFORE it is stored.
func TestOversizePayloadIsRefused(t *testing.T) {
	h := newHarness(t)
	a, b := newIdent(t, 21), newIdent(t, 22)
	big := b64.EncodeToString(bytes.Repeat([]byte{0xAB}, h.svc.Limits().MaxPayloadBytes+1))
	w, _ := h.deposit(a, b.key, big, "n-big")
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversize payload: want 413, got %d %s", w.Code, w.Body.String())
	}
	_, body := h.poll(b, "n-big-poll")
	if n := len(blobsOf(t, body)); n != 0 {
		t.Fatalf("oversize deposit must store nothing, got %d", n)
	}
}

// A body larger than MaxBodyBytes is refused without being buffered whole.
func TestOversizeBodyIsRefused(t *testing.T) {
	h := newHarness(t)
	junk := `{"key":"` + strings.Repeat("A", MaxBodyBytes+16) + `"}`
	req := httptest.NewRequest(http.MethodPost, Prefix+"/announce", strings.NewReader(junk))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.r.ServeHTTP(w, req)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversize body: want 413, got %d %s", w.Code, w.Body.String())
	}
}

// A key that is not a canonical base64url Ed25519 public key is refused. Sloppy
// key parsing would fragment a peer's address across spellings and make it
// unreachable at one of them.
func TestMalformedKeysAreRefused(t *testing.T) {
	h := newHarness(t)
	for _, k := range []string{
		"",
		"not-base64url!!",
		b64.EncodeToString(bytes.Repeat([]byte{1}, 31)), // too short
		b64.EncodeToString(bytes.Repeat([]byte{1}, 33)), // too long
	} {
		if k == "" {
			// An empty path segment does not match the route at all; assert that
			// too, since "404 because no route" is still a refusal.
			w, _ := h.get(Prefix + "/resolve/")
			if w.Code == http.StatusOK {
				t.Fatalf("empty key resolved OK")
			}
			continue
		}
		w, _ := h.get(Prefix + "/resolve/" + k)
		if w.Code != http.StatusBadRequest {
			t.Errorf("resolve %q: want 400, got %d", k, w.Code)
		}
	}
}

// The queue is capped, and the cap evicts OLDEST-first: in signalling the newest
// frame is the one a live negotiation needs.
func TestQueueCapEvictsOldest(t *testing.T) {
	h := newHarness(t)
	a, b := newIdent(t, 23), newIdent(t, 24)
	cap := h.svc.Limits().MaxQueueBlobs

	for i := 0; i < cap+5; i++ {
		p := b64.EncodeToString([]byte("f" + strconv.Itoa(i)))
		if w, _ := h.deposit(a, b.key, p, "n-cap-"+strconv.Itoa(i)); w.Code != http.StatusOK {
			t.Fatalf("deposit %d: %d", i, w.Code)
		}
	}
	_, body := h.poll(b, "n-cap-poll")
	blobs := blobsOf(t, body)
	if len(blobs) != cap {
		t.Fatalf("want the queue capped at %d, got %d", cap, len(blobs))
	}
	// The newest survives; the oldest is gone.
	want := b64.EncodeToString([]byte("f" + strconv.Itoa(cap+4)))
	if got := blobs[len(blobs)-1]["payload"]; got != want {
		t.Errorf("newest frame missing: want %s, got %v", want, got)
	}
	gone := b64.EncodeToString([]byte("f0"))
	for _, bl := range blobs {
		if bl["payload"] == gone {
			t.Errorf("oldest frame should have been evicted")
		}
	}
}

// A long-poll returns as soon as a deposit lands, rather than sitting out its
// full wait — this is what keeps signalling latency low without busy polling.
func TestLongPollWakesOnDeposit(t *testing.T) {
	h := newHarness(t)
	a, b := newIdent(t, 25), newIdent(t, 26)

	req := PollRequest{Key: b.key, Nonce: "n-lp", TS: h.ts(), Wait: 20}
	req.Sig = b.sign(DomainSignalPoll, req.Key, i64(req.TS), req.Nonce)
	raw, _ := json.Marshal(req)

	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		hreq := httptest.NewRequest(http.MethodPost, Prefix+"/signal/"+b.key+"/poll", bytes.NewReader(raw))
		hreq.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		h.r.ServeHTTP(w, hreq)
		done <- w
	}()

	// Wait until the poller is actually parked before depositing, so the test
	// proves the WAKE-UP rather than accidentally racing to a pre-filled queue.
	deadline := time.Now().Add(5 * time.Second)
	for {
		h.svc.mu.Lock()
		parked := false
		if qs, ok := h.svc.queues[b.key]; ok && qs[queueSignal] != nil {
			parked = len(qs[queueSignal].waiters) > 0
		}
		h.svc.mu.Unlock()
		if parked {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("long-poll never parked")
		}
		time.Sleep(2 * time.Millisecond)
	}

	h.deposit(a, b.key, b64.EncodeToString([]byte("wake")), "n-lp-dep")

	select {
	case w := <-done:
		if w.Code != http.StatusOK {
			t.Fatalf("long-poll: %d %s", w.Code, w.Body.String())
		}
		var body map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &body)
		if n := len(blobsOf(t, body)); n != 1 {
			t.Fatalf("woken poll should carry the blob, got %d", n)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("long-poll did not return after a deposit")
	}
}

// An UNVERIFIED long-poll must be refused immediately rather than parked: if it
// could park, an anonymous caller would hold connections open for free.
func TestUnverifiedLongPollDoesNotPark(t *testing.T) {
	h := newHarness(t)
	b, evil := newIdent(t, 27), newIdent(t, 28)

	req := PollRequest{Key: b.key, Nonce: "n-nopark", TS: h.ts(), Wait: 20}
	req.Sig = evil.sign(DomainSignalPoll, req.Key, i64(req.TS), req.Nonce)

	start := time.Now()
	w, _ := h.post(Prefix+"/signal/"+b.key+"/poll", req)
	elapsed := time.Since(start)
	if w.Code != http.StatusForbidden {
		t.Fatalf("want 403, got %d", w.Code)
	}
	if elapsed > 2*time.Second {
		t.Fatalf("a refused poll must not block; took %s", elapsed)
	}
	h.svc.mu.Lock()
	defer h.svc.mu.Unlock()
	if qs, ok := h.svc.queues[b.key]; ok && qs[queueSignal] != nil && len(qs[queueSignal].waiters) > 0 {
		t.Fatal("a refused poll parked a waiter")
	}
}

// Signal and mailbox are separate namespaces with separate domain tags, so a
// signalling signature cannot be spent on the mailbox (or vice-versa) and relay
// traffic cannot crowd out signalling.
func TestSignalAndMailboxAreSeparate(t *testing.T) {
	h := newHarness(t)
	a, b := newIdent(t, 29), newIdent(t, 30)
	payload := b64.EncodeToString([]byte("sealed"))

	// Deposit into the MAILBOX with the mailbox domain.
	req := DepositRequest{From: a.key, To: b.key, Payload: payload, Nonce: "n-mb", TS: h.ts()}
	req.Sig = a.sign(DomainMailboxDeposit, req.From, req.To, i64(req.TS), i64(req.TTL), req.Nonce, req.Payload)
	if w, _ := h.post(Prefix+"/mailbox/"+b.key, req); w.Code != http.StatusOK {
		t.Fatalf("mailbox deposit: %d %s", w.Code, req.Sig)
	}

	// The SIGNAL inbox must be empty — different namespace.
	_, body := h.poll(b, "n-mb-sig")
	if n := len(blobsOf(t, body)); n != 0 {
		t.Fatalf("mailbox deposit leaked into the signal queue: %d blobs", n)
	}

	// The mailbox poll needs the MAILBOX domain; the signal-domain signature is
	// refused on it.
	bad := PollRequest{Key: b.key, Nonce: "n-mb-bad", TS: h.ts()}
	bad.Sig = b.sign(DomainSignalPoll, bad.Key, i64(bad.TS), bad.Nonce)
	if w, _ := h.post(Prefix+"/mailbox/"+b.key+"/poll", bad); w.Code != http.StatusForbidden {
		t.Fatalf("signal-domain signature on a mailbox poll: want 403, got %d", w.Code)
	}

	good := PollRequest{Key: b.key, Nonce: "n-mb-good", TS: h.ts()}
	good.Sig = b.sign(DomainMailboxPoll, good.Key, i64(good.TS), good.Nonce)
	w, body := h.post(Prefix+"/mailbox/"+b.key+"/poll", good)
	if w.Code != http.StatusOK {
		t.Fatalf("mailbox poll: %d", w.Code)
	}
	if n := len(blobsOf(t, body)); n != 1 {
		t.Fatalf("mailbox poll should see its blob, got %d", n)
	}
}

func TestHealthz(t *testing.T) {
	h := newHarness(t)
	w, body := h.get(Prefix + "/healthz")
	if w.Code != http.StatusOK || body["ok"] != true {
		t.Fatalf("healthz: %d %s", w.Code, w.Body.String())
	}
}
