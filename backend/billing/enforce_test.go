package billing

import (
	"context"
	"sync"
	"testing"

	"diwan/backend/seam"
)

// stubEntitlements returns a fixed entitlement (and optional error) for every
// account, so tests can simulate each tier/cp posture.
type stubEntitlements struct {
	ent seam.Entitlement
	err error
}

func (s stubEntitlements) For(context.Context, string) (seam.Entitlement, error) {
	return s.ent, s.err
}
func (s stubEntitlements) Allowed(context.Context, string, string) bool { return true }

// recordingUsage captures reported events so tests can assert metering.
type recordingUsage struct {
	mu     sync.Mutex
	events []seam.UsageEvent
}

func (r *recordingUsage) Report(_ context.Context, ev seam.UsageEvent) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, ev)
}

func (r *recordingUsage) all() []seam.UsageEvent {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]seam.UsageEvent, len(r.events))
	copy(out, r.events)
	return out
}

// withProvider installs a provider for the duration of a test. Configure resets
// the per-process storage and entitlement caches, so cases do not bleed.
func withProvider(t *testing.T, ent seam.Entitlement, err error) *recordingUsage {
	t.Helper()
	usage := &recordingUsage{}
	Configure(seam.Provider{
		Entitlements: stubEntitlements{ent: ent, err: err},
		Usage:        usage,
	})
	t.Cleanup(func() {
		Configure(seam.NewStandaloneProvider(func() ([]byte, error) { return nil, nil }, false))
	})
	return usage
}

// gate is a test helper: it runs GateStorage and discards the reservation handle
// for cases that only assert the Decision. Use gateReserve when the reservation
// must be committed/released.
func gate(ctx context.Context, accountID string, n int64) Decision {
	d, _ := GateStorage(ctx, accountID, n)
	return d
}

const acct = "alice@vulos.org"

// --- Standalone (unlimited): allow everything, meter only on real writes -----

func TestStandalone_AllowsEverything(t *testing.T) {
	usage := withProvider(t, seam.DefaultEntitlement(), nil)
	ctx := context.Background()

	if d := GateOffice(ctx, acct); !d.Allowed() {
		t.Fatalf("office should be enabled standalone, got %+v", d)
	}
	if d := gate(ctx, acct, 5<<30); !d.Allowed() {
		t.Fatalf("storage should be unlimited standalone, got %+v", d)
	}
	if d := GateSeats(ctx, acct, 10_000); !d.Allowed() {
		t.Fatalf("seats should be unlimited standalone, got %+v", d)
	}

	// Metering is harmless: a no-op write (0 bytes) emits nothing; a real write
	// emits a single storage event but never blocks.
	MeterStorage(ctx, acct, 0)
	if got := len(usage.all()); got != 0 {
		t.Fatalf("0-byte write should meter nothing, got %d events", got)
	}
	MeterStorage(ctx, acct, 1024)
	if got := usage.all(); len(got) != 1 || got[0].Kind != seam.KindStorage || got[0].Value != 1024 {
		t.Fatalf("expected one storage event of 1024, got %+v", got)
	}
}

// --- Small cap: over-limit storage is rejected with 402 ----------------------

func TestStorageCap_RejectsOverLimit(t *testing.T) {
	withProvider(t, seam.Entitlement{MaxStorageBytes: 1000}, nil)
	ctx := context.Background()

	d, res := GateStorage(ctx, acct, 600)
	if !d.Allowed() {
		t.Fatalf("600 under 1000 cap should be allowed, got %+v", d)
	}
	res.Commit(ctx) // now 600 committed

	if d := gate(ctx, acct, 600); d.Allowed() || d.Code != 402 {
		t.Fatalf("600+600 over 1000 cap should be 402, got %+v", d)
	}
	// A write that still fits (600+400 == cap) is allowed.
	if d := gate(ctx, acct, 400); !d.Allowed() {
		t.Fatalf("600+400 == cap should be allowed, got %+v", d)
	}
}

func TestSeatCap_RejectsWhenFull(t *testing.T) {
	withProvider(t, seam.Entitlement{MaxSeats: 3}, nil)
	ctx := context.Background()

	if d := GateSeats(ctx, acct, 2); !d.Allowed() {
		t.Fatalf("2 of 3 seats should allow one more, got %+v", d)
	}
	if d := GateSeats(ctx, acct, 3); d.Allowed() || d.Code != 402 {
		t.Fatalf("3 of 3 seats should be 402, got %+v", d)
	}
}

// --- Suspended blocks writes and invites with 402 ----------------------------

func TestSuspended_BlocksWritesAndSeats(t *testing.T) {
	withProvider(t, seam.Entitlement{Suspended: true}, nil)
	ctx := context.Background()

	if d := gate(ctx, acct, 1); d.Code != 402 {
		t.Fatalf("suspended storage should be 402, got %+v", d)
	}
	if d := GateSeats(ctx, acct, 0); d.Code != 402 {
		t.Fatalf("suspended seats should be 402, got %+v", d)
	}
	if d := GateOffice(ctx, acct); d.Code != 403 {
		t.Fatalf("suspended office access should be 403, got %+v", d)
	}
}

// --- Office disabled → 403 ---------------------------------------------------

func TestOfficeDisabled_403(t *testing.T) {
	withProvider(t, seam.Entitlement{Features: map[string]bool{seam.FeatureOffice: false}}, nil)
	ctx := context.Background()

	if d := GateOffice(ctx, acct); d.Code != 403 {
		t.Fatalf("office-disabled should be 403, got %+v", d)
	}
	// Office enabled explicitly true is allowed.
	withProvider(t, seam.Entitlement{Features: map[string]bool{seam.FeatureOffice: true}}, nil)
	if d := GateOffice(ctx, acct); !d.Allowed() {
		t.Fatalf("office-enabled should allow, got %+v", d)
	}
}

// --- Cold-cache fail-open: a cp error with NO warm cache must not hard-down ----

func TestFailOpen_ColdCache_OnEntitlementError(t *testing.T) {
	withProvider(t, seam.Entitlement{Suspended: true, MaxStorageBytes: 1, MaxSeats: 1},
		context.DeadlineExceeded /* simulate cp unreachable */)
	ctx := context.Background()

	// Cold cache (no prior successful resolve for this account): even though the
	// (unused) stub entitlement is suspended/tiny, an error means we fail open to
	// the unlimited default and allow.
	if d := GateOffice(ctx, acct); !d.Allowed() {
		t.Fatalf("cold-cache fail-open: office should allow on cp error, got %+v", d)
	}
	if d := gate(ctx, acct, 1<<40); !d.Allowed() {
		t.Fatalf("cold-cache fail-open: storage should allow on cp error, got %+v", d)
	}
	if d := GateSeats(ctx, acct, 1_000_000); !d.Allowed() {
		t.Fatalf("cold-cache fail-open: seats should allow on cp error, got %+v", d)
	}
}

// --- Warm-cache authority: a known-suspended account stays blocked through a blip.

// flakyEntitlements answers successfully until tripped, then returns an error —
// so a test can warm the cache, then simulate the cp going away.
type flakyEntitlements struct {
	mu   sync.Mutex
	ent  seam.Entitlement
	fail bool
}

func (f *flakyEntitlements) For(context.Context, string) (seam.Entitlement, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail {
		return seam.Entitlement{}, context.DeadlineExceeded
	}
	return f.ent, nil
}
func (f *flakyEntitlements) Allowed(context.Context, string, string) bool { return true }
func (f *flakyEntitlements) trip() {
	f.mu.Lock()
	f.fail = true
	f.mu.Unlock()
}

func TestWarmCache_SuspendedStaysAuthoritative(t *testing.T) {
	fe := &flakyEntitlements{ent: seam.Entitlement{Suspended: true, MaxStorageBytes: 1}}
	Configure(seam.Provider{Entitlements: fe, Usage: &recordingUsage{}})
	t.Cleanup(func() {
		Configure(seam.NewStandaloneProvider(func() ([]byte, error) { return nil, nil }, false))
	})
	ctx := context.Background()

	// First call resolves successfully → warms the cache with a SUSPENDED entitlement.
	if d := GateOffice(ctx, acct); d.Code != 403 {
		t.Fatalf("warm: suspended office should be 403, got %+v", d)
	}
	// cp now goes away.
	fe.trip()
	// Warm cache is authoritative: the known-suspended account stays blocked even
	// though the resolver errors — fail-open does NOT resurrect a suspended acct.
	if d := GateOffice(ctx, acct); d.Code != 403 {
		t.Fatalf("warm-cache: suspended must stay 403 through cp blip, got %+v", d)
	}
	if d := gate(ctx, acct, 1<<40); d.Code != 402 {
		t.Fatalf("warm-cache: suspended storage must stay 402 through cp blip, got %+v", d)
	}
}

// --- Atomic reserve: concurrent uploads cannot both pass a cap only one fits ---

func TestAtomicReserve_PreventsConcurrentOverLimit(t *testing.T) {
	// Cap = 1000. Two concurrent 600-byte reservations: only one may pass.
	withProvider(t, seam.Entitlement{MaxStorageBytes: 1000}, nil)
	ctx := context.Background()

	const goroutines = 32
	var wg sync.WaitGroup
	var passed int64
	var pmu sync.Mutex
	start := make(chan struct{})
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			d, res := GateStorage(ctx, acct, 600)
			if d.Allowed() {
				pmu.Lock()
				passed++
				pmu.Unlock()
				res.Commit(ctx)
			} else {
				res.Release()
			}
		}()
	}
	close(start)
	wg.Wait()

	if passed != 1 {
		t.Fatalf("atomic reserve: exactly one 600-byte upload should fit under a 1000 cap, got %d", passed)
	}
}

// --- Release frees a reservation so a failed write does not consume quota ------

func TestReservation_ReleaseFreesQuota(t *testing.T) {
	withProvider(t, seam.Entitlement{MaxStorageBytes: 1000}, nil)
	ctx := context.Background()

	d, res := GateStorage(ctx, acct, 900)
	if !d.Allowed() {
		t.Fatalf("900 under 1000 should be allowed, got %+v", d)
	}
	// While held, a second 900 cannot fit.
	if d := gate(ctx, acct, 900); d.Allowed() {
		t.Fatalf("second 900 should not fit while first is reserved")
	}
	// Releasing the first reservation frees the quota again.
	res.Release()
	if d := gate(ctx, acct, 900); !d.Allowed() {
		t.Fatalf("900 should fit again after release, got %+v", d)
	}
}
