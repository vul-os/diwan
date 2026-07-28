// Package billing enforces entitlements and emits usage through the integration
// seam, applying the "no-holes" rule to office's billable actions:
//
//   - GATED:    every billable action is checked against a freshly-fetched
//     entitlement BEFORE the action (server-side, before resource issuance).
//   - METERED:  every successful billable action is reported via the Usage seam.
//   - BYPASS-PROOF: the gate runs on the server using the verified account id,
//     never a client-supplied value, and before any resource is issued.
//
// CRITICAL: enforcement must be a NO-OP in standalone mode. The standalone seam
// returns an unlimited, never-suspended entitlement, so:
//
//   - a 0/negative cap means "unlimited" → allow;
//   - Suspended is always false → never block;
//   - features["office"] is absent → office enabled.
//
// This package imports ONLY backend/seam (the interface), never the optional
// backend/integration/cloud adapter, preserving the core's independence: office
// stays self-hostable with zero cloud configuration and the cloud package can be
// deleted without breaking this enforcement layer.
package billing

import (
	"context"
	"log"
	"sync"
	"time"

	"diwan/backend/seam"

	"github.com/google/uuid"
)

// provider is the process-wide seam provider wired by main.go. Until Configure
// is called it is the unlimited standalone default, so any handler that runs
// before wiring (e.g. a test) behaves as a no-op rather than panicking.
var (
	mu       sync.RWMutex
	provider = seam.NewStandaloneProvider(func() ([]byte, error) { return nil, nil }, false)

	// storageUsed tracks bytes this process has admitted per account, INCLUDING
	// bytes reserved by an in-flight GateStorage that has not yet committed or
	// released. The control plane is authoritative for true cross-process usage
	// (via reported Usage events), but a local running total makes the storage cap
	// enforceable before each write without an expensive full-store scan. It only
	// matters when a finite cap is configured (cloud); in standalone the cap is 0
	// and the counter is never consulted for a decision.
	//
	// committed[acct] is the durable used total (advanced by MeterStorage).
	// reserved[acct] is the sum of outstanding reservations (added at the gate,
	// removed when the reservation is committed or released). A gate decision uses
	// committed+reserved so two concurrent uploads cannot both pass a cap that
	// only one of them fits under (TOCTOU close).
	committed = map[string]int64{}
	reserved  = map[string]int64{}
	storageMu sync.Mutex

	// entCache is the bounded last-known-entitlement cache that makes the
	// fail-open posture deliberate (see entitlementFor). It is consulted ONLY when
	// a fresh resolve errors. A warm entry that says suspended/over-limit stays
	// authoritative through a cp blip; a cold-cache error allows + logs degraded.
	entCache   = map[string]cachedEnt{}
	entCacheMu sync.Mutex
)

// entCacheTTL bounds how long a last-known entitlement is trusted after the cp
// stops answering. Short by design: long enough to ride out a transient blip,
// short enough that a real tier change (e.g. un-suspension) is picked up soon.
const entCacheTTL = 60 * time.Second

type cachedEnt struct {
	ent     seam.Entitlement
	fetched time.Time
}

// Configure installs the active seam provider. Called once from main.go after
// the standalone/cloud selection. Safe to call in tests to inject a stub.
//
// Configure also resets the per-process storage and entitlement caches so a
// re-wire (e.g. between tests) does not carry stale reservations or cached
// entitlements across providers.
func Configure(p seam.Provider) {
	mu.Lock()
	provider = p
	mu.Unlock()

	storageMu.Lock()
	committed = map[string]int64{}
	reserved = map[string]int64{}
	storageMu.Unlock()

	entCacheMu.Lock()
	entCache = map[string]cachedEnt{}
	entCacheMu.Unlock()
}

// current returns the active provider under a read lock.
func current() seam.Provider {
	mu.RLock()
	defer mu.RUnlock()
	return provider
}

// Decision is the outcome of a gate check. Code == 0 means allowed.
type Decision struct {
	Code   int    // HTTP status to return when not allowed (402/403); 0 = allow
	Reason string // human-readable reason for the rejection
}

// Allowed reports whether the action may proceed.
func (d Decision) Allowed() bool { return d.Code == 0 }

var allow = Decision{}

// entitlementFor fetches a FRESH entitlement for accountID. Fail-open is now
// DELIBERATE and bounded:
//
//   - A successful resolve refreshes the last-known-entitlement cache and is
//     returned as-is.
//   - On a resolver error (cp unreachable) we consult the bounded cache:
//   - a WARM entry (within entCacheTTL) is authoritative — so a known
//     suspended / over-limit account stays enforced through a cp blip;
//   - a COLD/absent entry → we fail open to the unlimited self-host default
//     (so a cp outage never hard-downs office) and log the degraded decision.
func entitlementFor(ctx context.Context, accountID string) seam.Entitlement {
	ent, err := current().Entitlements.For(ctx, accountID)
	if err == nil {
		entCacheMu.Lock()
		entCache[accountID] = cachedEnt{ent: ent, fetched: time.Now()}
		entCacheMu.Unlock()
		return ent
	}

	entCacheMu.Lock()
	c, ok := entCache[accountID]
	fresh := ok && time.Since(c.fetched) < entCacheTTL
	entCacheMu.Unlock()
	if fresh {
		// Authoritative last-known entitlement: a suspended/over-limit account is
		// still blocked even though the cp is momentarily unreachable.
		return c.ent
	}

	// Cold cache: allow (fail-open) but make the degraded decision visible.
	log.Printf("[billing] entitlement resolve failed for %q and no warm cache (TTL %s); "+
		"failing OPEN (degraded): %v", accountID, entCacheTTL, err)
	return seam.DefaultEntitlement()
}

// GateOffice gates access to the office product itself. Returns a 403 Decision
// when the entitlement explicitly disables the "office" feature OR the account
// is suspended. Unlimited/standalone → allow (the standalone entitlement has no
// "office" key and is never suspended).
func GateOffice(ctx context.Context, accountID string) Decision {
	ent := entitlementFor(ctx, accountID)
	if ent.Suspended {
		return Decision{Code: 403, Reason: "account suspended"}
	}
	if ent.Features != nil {
		if v, ok := ent.Features[seam.FeatureOffice]; ok && !v {
			return Decision{Code: 403, Reason: "office not enabled for this tier"}
		}
	}
	return allow
}

// StorageReservation is a held claim on newBytes of an account's storage quota.
// It is the result of a successful GateStorage call when a finite cap applies.
//
// EXACTLY ONE of Commit / Release must be called for every reservation that
// Allowed():
//
//   - Commit:  the write succeeded — promote the reserved bytes to the durable
//     used total and report a storage Usage event through the seam.
//   - Release: the write failed / was abandoned — drop the held bytes so the
//     quota is not permanently consumed by a failed upload.
//
// Reservation methods are no-ops on a denied or unlimited/standalone decision,
// so callers can always defer Release and conditionally Commit without checking
// whether a cap was in force.
type StorageReservation struct {
	accountID string
	bytes     int64
	active    bool // true only when bytes were actually reserved against a cap
	done      bool // guards against double commit/release
}

// GateStorage atomically checks AND reserves a storage write of newBytes for
// accountID. It returns a 402 Decision when the account is suspended, or when
// the configured storage cap is finite and committed+reserved+newBytes would
// exceed it. A cap of <=0 (unlimited / standalone) always allows.
//
// The check-and-reserve is a single critical section, so two concurrent uploads
// that would each fit individually but not together cannot both pass (TOCTOU
// close). On a successful Decision the caller holds the returned reservation and
// MUST Commit (write succeeded) or Release (write failed) it.
//
// Call BEFORE issuing the blob write.
func GateStorage(ctx context.Context, accountID string, newBytes int64) (Decision, *StorageReservation) {
	ent := entitlementFor(ctx, accountID)
	if ent.Suspended {
		return Decision{Code: 402, Reason: "account suspended"}, &StorageReservation{}
	}
	if ent.MaxStorageBytes <= 0 { // unlimited → no reservation needed
		return allow, &StorageReservation{accountID: accountID, bytes: newBytes}
	}
	if newBytes <= 0 {
		return allow, &StorageReservation{accountID: accountID}
	}

	storageMu.Lock()
	used := committed[accountID] + reserved[accountID]
	if used+newBytes > ent.MaxStorageBytes {
		storageMu.Unlock()
		return Decision{Code: 402, Reason: "storage quota exceeded"}, &StorageReservation{}
	}
	reserved[accountID] += newBytes
	storageMu.Unlock()

	return allow, &StorageReservation{accountID: accountID, bytes: newBytes, active: true}
}

// Commit promotes a held reservation to durable usage and reports the storage
// Usage event. A no-op for a denied / unlimited / already-finalised reservation.
func (r *StorageReservation) Commit(ctx context.Context) {
	if r == nil || r.done {
		return
	}
	r.done = true
	if r.active {
		storageMu.Lock()
		reserved[r.accountID] -= r.bytes
		if reserved[r.accountID] <= 0 {
			delete(reserved, r.accountID)
		}
		committed[r.accountID] += r.bytes
		storageMu.Unlock()
	}
	if r.bytes > 0 {
		current().Usage.Report(ctx, seam.UsageEvent{
			AccountID:      r.accountID,
			Kind:           seam.KindStorage,
			Value:          r.bytes,
			IdempotencyKey: uuid.NewString(),
		})
	}
}

// Release drops a held reservation without committing it (the write failed or
// was abandoned). A no-op for a denied / unlimited / already-finalised
// reservation.
func (r *StorageReservation) Release() {
	if r == nil || r.done {
		return
	}
	r.done = true
	if !r.active {
		return
	}
	storageMu.Lock()
	reserved[r.accountID] -= r.bytes
	if reserved[r.accountID] <= 0 {
		delete(reserved, r.accountID)
	}
	storageMu.Unlock()
}

// MeterStorage records a successful storage write of n bytes WITHOUT going
// through the reservation flow. It advances the durable used total and reports a
// storage Usage event. Prefer GateStorage + Reservation.Commit for write paths
// (atomic check-and-reserve); MeterStorage remains for callers that meter a
// write they did not gate (and for backward-compatible tests).
func MeterStorage(ctx context.Context, accountID string, n int64) {
	if n <= 0 {
		return
	}
	storageMu.Lock()
	committed[accountID] += n
	storageMu.Unlock()
	current().Usage.Report(ctx, seam.UsageEvent{
		AccountID:      accountID,
		Kind:           seam.KindStorage,
		Value:          n,
		IdempotencyKey: uuid.NewString(),
	})
}

// GateSeats gates admitting one more member/seat for accountID given the count
// of seats already in use. Returns a 402 Decision when suspended, or when the
// configured seat cap is finite and currentSeats is already at/over it. A cap of
// <=0 (unlimited / standalone) always allows.
//
// Call BEFORE minting an invite / admitting a member. On a successful add, call
// MeterSeats.
func GateSeats(ctx context.Context, accountID string, currentSeats int64) Decision {
	ent := entitlementFor(ctx, accountID)
	if ent.Suspended {
		return Decision{Code: 402, Reason: "account suspended"}
	}
	if ent.MaxSeats <= 0 { // unlimited
		return allow
	}
	if currentSeats >= ent.MaxSeats {
		return Decision{Code: 402, Reason: "seat limit reached"}
	}
	return allow
}

// MeterSeats reports a seats Usage event for one added member/seat.
func MeterSeats(ctx context.Context, accountID string) {
	current().Usage.Report(ctx, seam.UsageEvent{
		AccountID:      accountID,
		Kind:           seam.KindSeats,
		Value:          1,
		IdempotencyKey: uuid.NewString(),
	})
}
