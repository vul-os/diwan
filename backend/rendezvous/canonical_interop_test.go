package rendezvous

import (
	"bytes"
	"crypto/ed25519"
	"encoding/hex"
	"testing"
)

// canonical_interop_test.go — the ONE thing that can silently break the built-in
// rendezvous surface without any test failing: the browser and the server
// disagreeing about which bytes get signed.
//
// Every request to this surface is authenticated by an Ed25519 signature over
// `CanonicalMessage`, and the browser computes that message in JavaScript
// (`canonicalMessage` in src/lib/collab/webrtc/rendezvous.js). The two functions
// are independent implementations of one format. If they diverge by a single byte
// — a different length prefix width, a different endianness, a field in a
// different order, a number formatted differently — every signature stops
// verifying and collaboration dies with a wall of 403s that looks like a crypto
// bug rather than a spec drift.
//
// So the format is pinned to FIXED VECTORS here, and the SAME vectors are pinned
// on the JS side in
// src/lib/collab/webrtc/__tests__/canonicalInterop.test.js.
// Both files must be edited together, deliberately, or one of them fails.
//
// The vectors were produced by running the JS client (the pre-existing
// implementation, so the Go side is what conforms) with an Ed25519 seed of 32
// bytes of 0x07. Each vector carries the exact canonical bytes AND a real
// signature, so this test proves two independent things:
//
//  1. Go builds byte-identical canonical messages, and
//  2. a signature made by the JS client verifies on the Go server.

// jsSeedByte is the fixed seed the vectors were generated with (32 × 0x07).
const jsSeedByte = 0x07

// jsPublicKey is what the JS client reports as its base64url address for that
// seed. Pinning it proves the two runtimes derive the same public key from the
// same seed — i.e. that "the seed IS the private key" means the same thing in
// @noble/curves and crypto/ed25519.
const jsPublicKey = "6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw"

type interopVector struct {
	name   string
	domain string
	fields []string
	msgHex string
	sig    string
}

func interopVectors() []interopVector {
	k := jsPublicKey
	return []interopVector{
		{
			name:   "announce",
			domain: DomainAnnounce,
			fields: []string{k, "1800000000", "0", "nonce-abc", "vulos-fabric"},
			msgHex: "0000001476756c6f732d7264762f616e6e6f756e63652f310000002b366b7073592d4b635567712d3956423745793" +
				"7462d5a56486471362d766e755351683771615252473069770000000a313830303030303030300000000130000000096e6f" +
				"6e63652d6162630000000c76756c6f732d666162726963",
			sig: "zzZTLm_MTwqhAnPhTS_RTcieaku7b_-BIGx5RPqhDw_pje0HR1y1EZBSDaMNfzsfnxUTVp2s5daIa0knUxKJCg",
		},
		{
			name:   "signal-deposit",
			domain: DomainSignalDeposit,
			fields: []string{k, k, "1800000000", "0", "nonce-def", "aGVsbG8"},
			msgHex: "0000001a76756c6f732d7264762f7369676e616c2d6465706f7369742f310000002b366b7073592d4b635567712d3956" +
				"4237457937462d5a56486471362d766e755351683771615252473069770000002b366b7073592d4b635567712d3956423745" +
				"7937462d5a56486471362d766e755351683771615252473069770000000a3138303030303030303000000001300000000" +
				"96e6f6e63652d6465660000000761475673624738",
			sig: "UWsF7I6H1bhOIi_J6RzwFguipgMv0TbO8-aftzb4niQXzCK-i97fE63-ZKgfoxqs9XUnZUrjFu2eVIEfvynqCw",
		},
		{
			name:   "signal-ack",
			domain: DomainSignalAck,
			fields: []string{k, "1800000000", "nonce-ghi", "id1", "id2"},
			msgHex: "0000001676756c6f732d7264762f7369676e616c2d61636b2f310000002b366b7073592d4b635567712d395642374579" +
				"37462d5a56486471362d766e755351683771615252473069770000000a31383030303030303030000000096e6f6e63652d" +
				"6768690000000369643100000003696432",
			sig: "0_ikwrSFCnVZ3ZD_Mqsl2VZXX0hivnRNl3Su1aldfYIh35yb5_N19YF8m2c9VM6ON91wnSrgPkfitN0-lXs-DA",
		},
	}
}

func TestPublicKeyDerivationMatchesJS(t *testing.T) {
	seed := bytes.Repeat([]byte{jsSeedByte}, ed25519.SeedSize)
	priv := ed25519.NewKeyFromSeed(seed)
	got := b64.EncodeToString(priv.Public().(ed25519.PublicKey))
	if got != jsPublicKey {
		t.Fatalf("public key from the shared seed differs between runtimes:\n  go = %s\n  js = %s", got, jsPublicKey)
	}
}

func TestCanonicalMessageMatchesJSVectors(t *testing.T) {
	for _, v := range interopVectors() {
		t.Run(v.name, func(t *testing.T) {
			want, err := hex.DecodeString(v.msgHex)
			if err != nil {
				t.Fatalf("bad vector hex: %v", err)
			}
			got := CanonicalMessage(v.domain, v.fields...)
			if !bytes.Equal(got, want) {
				t.Fatalf("canonical message drifted from the JS implementation\n  got  %x\n  want %x", got, want)
			}
		})
	}
}

func TestJSSignaturesVerifyOnTheGoServer(t *testing.T) {
	pub, err := DecodeKey(jsPublicKey)
	if err != nil {
		t.Fatalf("pinned JS key does not decode: %v", err)
	}
	for _, v := range interopVectors() {
		t.Run(v.name, func(t *testing.T) {
			msg := CanonicalMessage(v.domain, v.fields...)
			if err := verify(pub, msg, v.sig); err != nil {
				t.Fatalf("a signature made by the JS client does not verify here: %v", err)
			}
			// And the negative: flipping one byte of the message must break it, so
			// the check above is not passing for some degenerate reason.
			tampered := append([]byte(nil), msg...)
			tampered[len(tampered)-1] ^= 0x01
			if err := verify(pub, tampered, v.sig); err == nil {
				t.Fatal("a tampered message still verified")
			}
		})
	}
}

// The domain tags themselves are part of the wire contract. Pin their literal
// strings: renaming one in Go alone would make every signature of that operation
// fail to verify, and the failure would look like a key problem.
func TestDomainTagsArePinned(t *testing.T) {
	for name, want := range map[string]string{
		DomainAnnounce:       "vulos-rdv/announce/1",
		DomainWithdraw:       "vulos-rdv/withdraw/1",
		DomainSignalDeposit:  "vulos-rdv/signal-deposit/1",
		DomainSignalPoll:     "vulos-rdv/signal-poll/1",
		DomainSignalAck:      "vulos-rdv/signal-ack/1",
		DomainMailboxDeposit: "vulos-rdv/mailbox-deposit/1",
		DomainMailboxPoll:    "vulos-rdv/mailbox-poll/1",
		DomainMailboxAck:     "vulos-rdv/mailbox-ack/1",
	} {
		if name != want {
			t.Errorf("domain tag drifted: %q != %q", name, want)
		}
	}
}
