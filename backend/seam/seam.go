// Package seam defines the integration "seam" between diwan's core and
// any external control plane (e.g. an optional gateway / "cp").
//
// GOAL: diwan must run COMPLETELY STANDALONE as an open-source project
// with NO dependency on any external control plane. The standalone path is the
// default and works with zero cloud configuration.
//
// The seam is a small set of interfaces with two kinds of implementation:
//
//   - STANDALONE DEFAULTS (this package, *_standalone.go): need no cloud. They
//     reuse office's existing local auth (JWT secret / per-user store / dev
//     single-user mode), return generous/unlimited entitlements from local
//     config, and report usage to Prometheus (or no-op).
//
//   - CLOUD ADAPTER (backend/integration/cloud, a SEPARATE package): implements
//     the same interfaces against the control plane. The core MUST NOT import
//     it; only the composition root (main.go) wires it, and only when explicitly
//     selected via env/config. So removing the cloud package never breaks core.
//
// This mirrors the spirit of lilmail's seam (Identity / Entitlements / Usage
// / SignupGate), adapted to what office actually needs.
package seam

import "context"

// AccountIdentity is the verified identity of a request's caller.
type AccountIdentity struct {
	// AccountID is the canonical, verified account id for the caller (e.g. the
	// JWT subject, or "self" in single-user mode). Handlers scope data by this
	// value and never trust a client-supplied header for it.
	AccountID string

	// IsAdmin is true when the caller carries the admin scope.
	IsAdmin bool

	// OrgID is the tenant/organisation the account belongs to. Empty in
	// single-tenant / OSS mode (no org prefix). Populated by the cloud adapter.
	OrgID string

	// Authenticated reports whether a credential was actually presented and
	// verified. False in auth-disabled single-user mode (caller still gets a
	// usable "self" AccountID so the app keeps working).
	Authenticated bool
}

// Identity authenticates a request and returns the caller's verified identity.
//
// The transport-neutral form takes the raw bearer token (and a hint of whether
// a credential was present at all). Standalone validates it against office's
// local JWT secret; the cloud adapter may validate against the control plane.
//
// token == "" means no credential was presented. Implementations decide whether
// that is allowed (single-user mode) or an error (auth required).
type Identity interface {
	// Authenticate verifies token and returns the caller identity. It returns a
	// non-nil error only for a *presented-but-invalid* credential; a missing
	// credential in a mode that permits anonymous access returns a valid
	// single-user identity with Authenticated=false.
	Authenticate(ctx context.Context, token string) (AccountIdentity, error)

	// AuthEnabled reports whether authentication is enforced. When false the
	// service runs in single-user / local mode.
	AuthEnabled() bool
}

// Entitlement describes the tier and quota limits for an account.
//
// A value of <= 0 for any numeric limit means "unlimited", which is the
// standalone default (self-hosters are not metered).
type Entitlement struct {
	// Tier is a free-form tier name ("self-hosted", "free", "pro", ...).
	Tier string

	// MaxStorageBytes caps total object/file storage for the account. <=0 = unlimited.
	MaxStorageBytes int64

	// MaxFiles caps the number of files/documents. <=0 = unlimited.
	MaxFiles int64

	// MaxSeats caps the number of members/seats for the account/org. <=0 = unlimited.
	MaxSeats int64

	// Suspended, when true, means the account is delinquent/disabled at the
	// control plane: writes and invites must be blocked even if caps are not yet
	// reached. The standalone default is always false.
	Suspended bool

	// Features is a set of optional feature flags ("office", "signing",
	// ...). A nil/empty map in the standalone default means "all
	// features enabled" (see Entitlements.Allowed). An explicit false disables
	// the named feature (e.g. features["office"] == false gates office access).
	Features map[string]bool
}

// FeatureOffice is the feature flag that gates whether the office product is
// enabled for an account's tier. Absent/true = enabled; explicit false = gated.
const FeatureOffice = "office"

// Unlimited reports whether the entitlement imposes no storage/file caps.
func (e Entitlement) Unlimited() bool {
	return e.MaxStorageBytes <= 0 && e.MaxFiles <= 0
}

// Entitlements resolves tier/quota for an account.
type Entitlements interface {
	// For returns the entitlement for accountID. Implementations must never
	// return an error for an unknown account in standalone mode — they return
	// the permissive default instead.
	For(ctx context.Context, accountID string) (Entitlement, error)

	// Allowed reports whether accountID may use feature. The standalone default
	// returns true for everything.
	Allowed(ctx context.Context, accountID, feature string) bool
}

// Metered dimensions. Kind values are part of the cp usage contract (the cloud
// adapter maps these onto count/bytes).
const (
	// KindStorage meters bytes written to object/file storage.
	KindStorage = "storage"
	// KindSeats meters members/seats added to an account/org.
	KindSeats = "seats"
)

// UsageEvent is a single metering data point.
type UsageEvent struct {
	AccountID string
	OrgID     string
	// Kind names the metered dimension (seam.KindStorage / seam.KindSeats).
	Kind string
	// Value is the quantity for this event (count or bytes or minutes).
	Value int64
	// IdempotencyKey uniquely identifies this event so the control plane can
	// dedupe retries / at-least-once delivery and never double-bill a single
	// action. The billing layer assigns a fresh UUID per emitted event. Empty in
	// standalone mode (the no-op Usage reporter ignores it).
	IdempotencyKey string
}

// Usage reports metering for billing/observability.
//
// The standalone default is a no-op (or Prometheus only); the cloud adapter
// forwards events to the control plane. Reporting must never block request
// handling — implementations should be fast / fire-and-forget.
type Usage interface {
	Report(ctx context.Context, ev UsageEvent)
}

// Provider bundles the three seams so the composition root can pass one value
// around. The core depends only on these interfaces, never on a concrete
// (standalone or cloud) implementation.
type Provider struct {
	Identity     Identity
	Entitlements Entitlements
	Usage        Usage
}
