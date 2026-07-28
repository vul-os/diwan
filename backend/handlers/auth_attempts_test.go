package handlers

// auth_attempts_test.go — LOW regression guard: AuthHandler.attempts (the
// per-client-IP login-lockout map) previously had no TTL/eviction/cap, so an
// attacker sending login attempts from a burst of distinct/spoofed source IPs
// (or via a rotating X-Forwarded-For chain) could grow it without bound
// (unbounded-memory DoS). sweepAttemptsLocked now evicts stale entries past
// attemptTTL and hard-caps the map at maxAttemptRecords.

import (
	"fmt"
	"net/http"
	"testing"
	"time"

	"diwan/backend/userauth"

	"github.com/gin-gonic/gin"
)

func newTestAuthHandlerForAttempts() *AuthHandler {
	return &AuthHandler{attempts: make(map[string]*attemptRecord)}
}

func TestSweepAttempts_EvictsStaleEntriesPastTTL(t *testing.T) {
	h := newTestAuthHandlerForAttempts()
	now := time.Now()

	h.attempts["1.1.1.1"] = &attemptRecord{lastSeen: now.Add(-2 * attemptTTL)} // stale
	h.attempts["2.2.2.2"] = &attemptRecord{lastSeen: now}                      // fresh

	h.mu.Lock()
	h.lastSweep = time.Time{} // force the sweep to run regardless of the interval gate
	h.sweepAttemptsLocked(now)
	h.mu.Unlock()

	if _, ok := h.attempts["1.1.1.1"]; ok {
		t.Errorf("VULN: entry past attemptTTL was not evicted by sweepAttemptsLocked")
	}
	if _, ok := h.attempts["2.2.2.2"]; !ok {
		t.Errorf("fresh entry should not be evicted")
	}
}

// TestSweepAttempts_CapsMapSizeEvenWithinTTL proves the hard cap: even a burst
// of distinct IPs all within the TTL window (so the TTL pass alone evicts
// nothing) must not grow the map past maxAttemptRecords — the oldest entries
// are evicted first.
func TestSweepAttempts_CapsMapSizeEvenWithinTTL(t *testing.T) {
	h := newTestAuthHandlerForAttempts()
	base := time.Now()

	n := maxAttemptRecords + 500
	for i := 0; i < n; i++ {
		ip := fmt.Sprintf("10.%d.%d.%d", i/65536, (i/256)%256, i%256)
		h.attempts[ip] = &attemptRecord{lastSeen: base.Add(time.Duration(i) * time.Millisecond)}
	}
	if len(h.attempts) != n {
		t.Fatalf("setup: want %d entries, got %d", n, len(h.attempts))
	}

	h.mu.Lock()
	h.lastSweep = time.Time{}
	h.sweepAttemptsLocked(base.Add(time.Duration(n) * time.Millisecond))
	h.mu.Unlock()

	if len(h.attempts) > maxAttemptRecords {
		t.Fatalf("VULN: unbounded attempts map — size after sweep = %d, want <= %d", len(h.attempts), maxAttemptRecords)
	}

	oldestIP := fmt.Sprintf("10.%d.%d.%d", 0, 0, 0)
	if _, ok := h.attempts[oldestIP]; ok {
		t.Errorf("oldest entry (%s) should have been evicted first to enforce the cap", oldestIP)
	}
	newest := n - 1
	newestIP := fmt.Sprintf("10.%d.%d.%d", newest/65536, (newest/256)%256, newest%256)
	if _, ok := h.attempts[newestIP]; !ok {
		t.Errorf("newest entry (%s) should be retained", newestIP)
	}
}

// TestSweepAttempts_RateLimitedByInterval proves the sweep is skipped when
// called again shortly after (below both the cap and the sweep interval), so a
// busy login endpoint isn't forced to pay an O(n) scan on every request.
func TestSweepAttempts_RateLimitedByInterval(t *testing.T) {
	h := newTestAuthHandlerForAttempts()
	now := time.Now()
	h.lastSweep = now // pretend a sweep just ran

	h.attempts["stale"] = &attemptRecord{lastSeen: now.Add(-2 * attemptTTL)}

	h.mu.Lock()
	h.sweepAttemptsLocked(now.Add(time.Second)) // well within attemptSweepInterval
	h.mu.Unlock()

	if _, ok := h.attempts["stale"]; !ok {
		t.Errorf("sweep should be rate-limited and skip within attemptSweepInterval")
	}
}

// TestSweepAttempts_RunsDespiteIntervalWhenOverCap proves the interval gate
// never suppresses the hard cap: even mid-interval, an oversized map is swept.
func TestSweepAttempts_RunsDespiteIntervalWhenOverCap(t *testing.T) {
	h := newTestAuthHandlerForAttempts()
	now := time.Now()
	h.lastSweep = now // pretend a sweep just ran (interval gate would normally skip)

	n := maxAttemptRecords + 10
	for i := 0; i < n; i++ {
		ip := fmt.Sprintf("172.%d.%d.%d", i/65536, (i/256)%256, i%256)
		h.attempts[ip] = &attemptRecord{lastSeen: now.Add(time.Duration(i) * time.Millisecond)}
	}

	h.mu.Lock()
	h.sweepAttemptsLocked(now.Add(time.Second)) // within the interval, but OVER the cap
	h.mu.Unlock()

	if len(h.attempts) > maxAttemptRecords {
		t.Fatalf("VULN: interval gate suppressed the hard cap — size = %d, want <= %d", len(h.attempts), maxAttemptRecords)
	}
}

// TestLogin_RecordsLastSeenAndSweeps is a light integration check that the
// real Login() handler threads lastSeen through the actual request path (not
// just the standalone sweep unit tests above), and that a stale unrelated
// entry gets swept away by a live login call.
func TestLogin_RecordsLastSeenAndSweeps(t *testing.T) {
	h := NewAuthHandlerWithCreds(credsTestCfg(), userauth.NewNullStore())

	// Seed a long-stale record before the first real request.
	h.attempts["9.9.9.9"] = &attemptRecord{lastSeen: time.Now().Add(-2 * attemptTTL)}
	h.lastSweep = time.Time{} // force the next Login's sweep to actually run

	r := gin.New()
	r.POST("/auth/login", h.Login)
	_ = doReq(r, http.MethodPost, "/auth/login", map[string]string{
		"account_id": "self", "password": "wrong-password",
	})

	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.attempts["9.9.9.9"]; ok {
		t.Errorf("VULN: a live Login() call did not sweep a stale attempt record")
	}
	if len(h.attempts) == 0 {
		t.Fatalf("Login() should have recorded an attempt for the caller's IP")
	}
	for ip, rec := range h.attempts {
		if rec.lastSeen.IsZero() {
			t.Errorf("attempt record for %s has no lastSeen set", ip)
		}
	}
}
