/* tslint:disable */
/* eslint-disable */

/**
 * A Hybrid Logical Clock (§3) — the per-replica clock a product ticks to stamp its own ops and
 * advances when it observes a remote op.
 *
 * The order is lexicographic by `(wall, counter, author)`, and because `author` is a public key
 * two distinct authors never tie, so the order is total across every replica.
 */
export class HlcClock {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * A clock for `author` (a 32-byte Ed25519 public key), starting at zero.
     */
    constructor(author: Uint8Array);
    /**
     * Fold a remote timestamp in, so this clock never lags behind causality it has seen.
     */
    observe(hlc_json: string): void;
    /**
     * Advance and return the next timestamp for a locally-minted op.
     */
    tick(now_ms: number): string;
    /**
     * The current timestamp without advancing.
     */
    readonly current: string;
}

/**
 * A replica's sync state: the six-kind CRDT algebra (§4.3–§4.8), the idempotent ingest path, the
 * §5.1 version vector, and the §6.1 observable-state projection.
 *
 * In-memory only. Ops are deduplicated by `op-id`, so re-delivering one is a no-op, and every
 * merge is commutative/associative/idempotent — the arrival order of concurrent ops never changes
 * the outcome.
 */
export class SyncEngine {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * The per-author `P`/`N` entries behind a counter — the union of op-id-keyed deltas (§4.6,
     * correction C-01), which is what makes the merge associative.
     */
    counter_entries(target: string, field: string): string;
    /**
     * A PN-counter's total, as a decimal string (the §4.6 sum is an `i128` and does not in
     * general fit a JS number).
     */
    counter_total(target: string, field: string): string;
    /**
     * The death dimension for an object: `{deleted, class}`.
     */
    death_state(object: string): string;
    /**
     * Whether this replica already holds an op, by `op-id`.
     */
    has_op(op_id: Uint8Array): boolean;
    /**
     * Apply an op whose authenticity was **already established out of band** — the §5.6 profile,
     * where ops ride unsigned inside an MLS group and authenticity is ambient group membership.
     *
     * The op is still fully validated (§4); only the signature check is skipped, because there is
     * no signature to check. Use this **only** when the transport itself authenticates every
     * writer. On a multi-author or untrusted path, [`SyncEngine::ingest_signed`] is the correct
     * entry point and this one is a hole: it will accept any well-formed op claiming any author.
     */
    ingest_ambient_authenticated(op_bytes: Uint8Array, receiver_now_ms: number): boolean;
    /**
     * **The network ingest path.** Verify a `COSE_Sign1` envelope, then validate and apply the op
     * it carries. Returns `true` if the op was new, `false` if it was already held.
     *
     * Signature (`0x0A02`), structure/causality (`0x0A03`) and skew (`0x0A05`) are all checked
     * **before** state is touched, so a refused op leaves the replica exactly as it was.
     */
    ingest_signed(cose_bytes: Uint8Array, receiver_now_ms: number): boolean;
    /**
     * The winning LWW cell for `target`/`field`: `{hlc, value}`, or `null`.
     */
    lww_cell(target: string, field: string): string;
    /**
     * Fold another replica's state in. State-based merge: idempotent and order-independent.
     */
    merge(other: SyncEngine): void;
    /**
     * An empty replica.
     */
    constructor();
    /**
     * The canonical six-section observable state (§6.1.1) as deterministic CBOR. **This is the
     * artifact two replicas compare** — equal bytes mean equal observable state.
     */
    observable_state(): Uint8Array;
    /**
     * The same projection as JSON, for a product that wants to render it rather than hash it.
     */
    observable_state_json(): string;
    /**
     * Reclaim collapsed add/tombstone pairs strictly below a §6.2 stability cut. Returns the
     * number of entries dropped; **observable state is unchanged by construction** — GC below the
     * cut can only remove causal evidence no replica can still cite.
     */
    prune_below(cut_hlc_json: string): number;
    /**
     * An RGA sequence: `{values, atoms}`, where `atoms` carries every element id including
     * tombstones (§4.7 keeps them until the §6.2 stability cut) and `values` is the visible
     * sequence.
     */
    sequence(target: string): string;
    /**
     * Whether an OR-Set element is present (add-wins, unless a death certificate dominates).
     */
    set_contains(target: string, value_json: string): boolean;
    /**
     * Every present `(target, element)` pair.
     */
    set_members(): string;
    /**
     * The add-tags of an element that no observed-remove has tombstoned — the causal evidence
     * behind "present".
     */
    set_surviving_tags(target: string, value_json: string): string;
    /**
     * The §6.1 observable-state root:
     * `0x1e ‖ BLAKE3-256(DMTAP-SYNC-v0/snapshot-state ‖ 0x00 ‖ state)`.
     */
    state_root(): Uint8Array;
    /**
     * The movable tree after §4.8 cycle-safe replay: `{edges, applied, skipped}`. A move that
     * would close a cycle is **skipped**, deterministically and identically on every replica —
     * a skip is not an error.
     */
    tree(): string;
    /**
     * Recompute the root and compare it to a claimed one. A mismatch is `0x0A09` — evidence of
     * divergence, whose §12 action is `HALT_ALERT`, not a retry.
     */
    verify_root(claimed: Uint8Array): void;
    /**
     * The §5.1 version vector — the per-author max HLC this replica has applied.
     */
    version_vector(): string;
    /**
     * The version vector's canonical CBOR (the `covers` member of a §6.1 snapshot).
     */
    version_vector_cbor(): Uint8Array;
}

/**
 * **The §5.2.1 responder predicate**: is a caller holding `vector` below the floor this snapshot
 * stands in for — i.e. would the surviving suffix be an incomplete answer for it?
 *
 * The test is domination of `covers`, not a comparison against the floor alone. A responder for
 * which this is true MUST answer fast-join; one for which it is false MUST answer with ops.
 */
export function caller_is_below_floor(snapshot_bytes: Uint8Array, vector_json: string): boolean;

/**
 * Whether an author is in the admitted set (§8/§9). Throws `0x0A01` if not.
 *
 * This is a **list membership check**, not a policy engine: resolving `DeviceCert` chains,
 * namespace policy objects and revocation is capability ① and lives outside this binding.
 */
export function check_admitted(author: Uint8Array, admitted_hex_json: string): void;

/**
 * Whether a PN-counter op may touch an entry: an author may only mutate its **own** `P`/`N`
 * (§4.6). Throws `0x0A06` otherwise.
 */
export function check_counter_entry(op_author: Uint8Array, entry_author: Uint8Array): void;

/**
 * Whether an op may reference a target: cross-namespace references are `0x0A0A` (§7).
 */
export function check_ns_ref(op_ns: string, referenced_target_ns: string): void;

/**
 * Compare two HLCs in the normative total order: `-1`, `0` or `1`.
 */
export function compare_hlc(a_json: string, b_json: string): number;

/**
 * Decode a canonical observable-state body to its JSON projection.
 */
export function decode_observable_state(bytes: Uint8Array): string;

/**
 * Decode canonical `SyncOp` bytes to JSON. Non-canonical encodings are **refused**, never
 * silently re-canonicalized (§2.2).
 */
export function decode_op(bytes: Uint8Array): string;

/**
 * The four wire parts of a `COSE_Sign1`, for inspection without trusting it:
 * `{protected, unprotected, payload, signature, alg, kid}`. Decoding and trusting are
 * deliberately separate steps — this does **not** verify.
 */
export function decode_signed_op(cose_bytes: Uint8Array): string;

/**
 * Decode deterministic CBOR back to a tagged JSON value.
 */
export function decode_value(bytes: Uint8Array): string;

/**
 * The canonical CBOR encoding of an HLC — the bytes §2.2 tiebreaks and §6.1.1 sorts compare.
 */
export function encode_hlc(hlc_json: string): Uint8Array;

/**
 * Encode a §6.1.1 observable state from its JSON projection (the shape
 * [`SyncEngine::observable_state_json`] emits) to canonical CBOR.
 *
 * A replica adopting a fast-join checkpoint receives a **state body** rather than a history, so it
 * needs to move between the two representations without going through the op log: fetch the body,
 * re-encode it, hash it, and compare against `Snapshot.root` before trusting a byte of it.
 * Section entries are re-sorted canonically on the way out, so a body that arrives in any other
 * order still hashes to the same root — or, if it was tampered with, visibly does not.
 */
export function encode_observable_state(state_json: string): Uint8Array;

/**
 * Encode a `SyncOp` (JSON) to its canonical §4.1 deterministic-CBOR bytes.
 */
export function encode_op(op_json: string): Uint8Array;

/**
 * Encode a tagged JSON value (see the `jsonval` module docs) to deterministic CBOR (§18.1.1).
 */
export function encode_value(value_json: string): Uint8Array;

/**
 * The `0x0A` error registry, for a product mapping refusals to its own UI:
 * `[{code, name, action}, …]`.
 */
export function error_registry(): string;

/**
 * The §5.2.1 caller-side sequence, steps 1–3: verify the snapshot, check it closes the gap, and
 * obtain and verify the body. Returns the **verified** observable-state bytes.
 *
 * **The body is a [`SnapshotBody`](dmtap_sync::SnapshotBody) — a compacted set of signed ops, not
 * a state document (§6.1.2).** It is verified by **fold-then-recompute**: every member is ingested
 * through the ordinary §4 op path into a provisional state, that state's §6.1.1 projection is
 * hashed, and the hash must equal `Snapshot.root`. Hashing the received bytes would prove only
 * that the sender shipped what it promised; this proves the ops *produce* the committed state.
 *
 * `fetched_body` is what the host retrieved from `GET /sync/state/<root>`, or `undefined` if it
 * could not retrieve anything. **The fetch itself is the host's job** — this binding does no I/O
 * (see the crate docs), and keeping the network out of it is also what keeps this call
 * synchronous. An inline `state` in the FastJoin is tried first and held to exactly the same
 * fold-then-recompute, then discarded on failure: it is a cache hint, never a second source of
 * truth.
 *
 * Throws `0x0A02`/`0x0A01`/`0x0A0A` for an unverifiable or out-of-scope snapshot or member,
 * `0x0A09` if it does not close the caller's gap or the body does not reproduce `root`, and
 * `0x0A0C` if no body could be obtained at all.
 *
 * **On any failure the caller MUST keep its old vector and MUST NOT fall back to the responder's
 * surviving suffix.** That fallback is the silent lost-write this whole path exists to prevent,
 * which is why this function returns state rather than mutating an engine: adoption is a separate,
 * deliberate step the host takes only on success.
 */
export function fastjoin_adopt(fastjoin_bytes: Uint8Array, caller_vector_json: string, subscribed_json: string, admitted_hex_json: string, receiver_now_ms: number, fetched_body?: Uint8Array | null): Uint8Array;

/**
 * [`fastjoin_adopt`] preceded by the [progress MUST](fastjoin_check_progress) — the call a real
 * pull loop should use.
 */
export function fastjoin_adopt_after(fastjoin_bytes: Uint8Array, previous_root: Uint8Array | null | undefined, previous_covers_json: string | null | undefined, caller_vector_json: string, subscribed_json: string, admitted_hex_json: string, receiver_now_ms: number, fetched_body?: Uint8Array | null): Uint8Array;

/**
 * **§5.2.1 step 2 in isolation** (§5.2.2): `covers` well-formed and non-empty (`0x0A03`), and the
 * caller genuinely below the floor (`0x0A09`). Throws the structured refusal; returns nothing when
 * the fast-join passes.
 *
 * There is deliberately **no** floor-vs-`covers` comparison in here — see
 * [`fastjoin_naive_covers_lacks_floor_rejected`] for the predicate that was removed and why.
 */
export function fastjoin_check_covers(fastjoin_bytes: Uint8Array, caller_vector_json: string): void;

/**
 * **The §5.2.1 step-5 progress MUST (§14 C-07).** A re-pull answered with another `fast-join`
 * carrying the *same* `Snapshot.root` **and** `covers` means the responder is looping — adopting
 * again cannot advance the caller. Throws `0x0A09`; returns nothing on progress.
 *
 * Pass `previous_root`/`previous_covers_json` from the fast-join adopted on the preceding round of
 * the same join, or `undefined` on the first round. A host driving a pull loop MUST call this (or
 * [`fastjoin_adopt_after`]) rather than [`fastjoin_adopt`] alone: the loop it prevents is
 * unbounded, and nothing else in the protocol terminates it.
 */
export function fastjoin_check_progress(fastjoin_bytes: Uint8Array, previous_root?: Uint8Array | null, previous_covers_json?: string | null): void;

/**
 * **Advisory only (§5.2.2, MAY).** Does the fast-join's `covers` carry a mark for `floor.author`?
 *
 * Exposed so a host can *log* the signal, and deliberately named so it cannot be mistaken for a
 * verdict. It is **not** a conformance test: an author whose only op sits *at* the floor is
 * retained rather than truncated, so `covers` need never name it. Treating `false` as a failure
 * rejects conformant peers — the defect §14 C-07 removed.
 */
export function fastjoin_covers_carries_floor_author_mark(fastjoin_bytes: Uint8Array): boolean;

/**
 * Decode a `FastJoin` — the answer a `pull` returns to a caller below the responder's §6.2
 * truncation floor — **without** trusting it: `{snapshot, floor, state}`.
 */
export function fastjoin_decode(bytes: Uint8Array): string;

/**
 * Encode a `FastJoin` from `{snapshot, floor, state?}` (the shape [`fastjoin_decode`] emits).
 */
export function fastjoin_encode(fastjoin_json: string): Uint8Array;

/**
 * The **rejected** naive predicate `covers.lacks(floor)`, exposed *only* so the cross-surface trace
 * can prove both surfaces agree it fires TRUE on a well-formed fast-join — and that neither acts
 * on it.
 *
 * **Never gate adoption on this.** `floor` is a single `Hlc` and `covers` is a per-author
 * `VersionVector`; there is no ordering between them (§5.2.2). This is a counterexample witness,
 * not an API for deciding anything.
 */
export function fastjoin_naive_covers_lacks_floor_rejected(fastjoin_bytes: Uint8Array): boolean;

/**
 * The content address a fast-join's body must be fetched from (`GET /sync/state/<root>`) — what
 * the host needs before it can call [`fastjoin_adopt`].
 */
export function fastjoin_state_address(fastjoin_bytes: Uint8Array): Uint8Array;

/**
 * The range-Merkle fingerprint of a set of `{hlc, id}` entries: `{fp, count}`.
 *
 * `count` is carried alongside the hash on purpose — without it an empty range and a range whose
 * ops happen to fold to the same value would be indistinguishable (§5.3).
 */
export function fingerprint(entries_json: string): string;

/**
 * Whether a value is a legal §4.1 `cv` (the `ext-value` subset). A `SyncOp` carrying anything
 * else is refused at validation, so a product can check before it mints.
 */
export function is_ext_value(value_json: string): boolean;

/**
 * The §6.1 root of an already-encoded observable state — for verifying a state body fetched by
 * address against a `Snapshot.root` before adopting it.
 */
export function observable_state_root(state_cbor: Uint8Array): Uint8Array;

/**
 * Assemble the wire `COSE_Sign1` from an op and a detached signature over
 * [`op_signing_input`]'s `sig_structure`.
 *
 * The assembled envelope is **verified before it is returned**: a signature produced under the
 * wrong key, over the wrong preimage, or by a custodian that silently failed cannot leave this
 * function as a well-formed op. A binding that emitted unverifiable envelopes would just push the
 * failure onto some other replica's ingest path, hours later and with no context.
 */
export function op_attach_signature(op_bytes: Uint8Array, signature: Uint8Array): Uint8Array;

/**
 * The §4.1 `op-id` content address of an encoded op (`0x1e ‖ BLAKE3-256(DS-tag ‖ 0x00 ‖ body)`).
 */
export function op_id(op_bytes: Uint8Array): Uint8Array;

/**
 * The eight §4.2 op kinds by name, so a JS caller never hard-codes a magic number.
 */
export function op_kinds(): string;

/**
 * The signing material for an op: everything a key custodian needs to produce the §4.1
 * `COSE_Sign1` signature, and nothing that would require it to surrender the key.
 *
 * Returns `{author, protected, external_aad, sig_structure}` (all lowercase hex). **Sign
 * `sig_structure` with Ed25519 under the key named by `author`, then call
 * [`op_attach_signature`].** `author` is read out of `hlc.author`, so the key you sign with and
 * the key the op claims are the same by construction.
 *
 * ## Why there is no `sign_op(seed)` here
 *
 * It would be one line, and it would be wrong. WASM linear memory is an ordinary
 * `ArrayBuffer`: any script sharing the page — an analytics tag, a compromised dependency, a
 * devtools heap snapshot — can read every byte of it, and neither `mlock`, guard pages, nor
 * reliable zeroization exist in that address space. Handing a raw Ed25519 seed across this
 * boundary would therefore downgrade a `CryptoKey` the browser *guarantees* is non-extractable
 * into bytes sitting in a readable buffer for the lifetime of the tab. That is a real loss of a
 * real protection, bought for the price of one `crypto.subtle.sign` call.
 *
 * The detached protocol costs one extra hop through JS and preserves the property that matters:
 * the signing key can live in WebCrypto with `extractable: false`, in a hardware token, or behind
 * a remote signing service, and this crate never learns it. Verification needs only public keys,
 * so the ingest path is unaffected.
 *
 * The insecure path is not "discouraged" here — it is **absent**, because a documented-but-present
 * footgun is still a footgun. `dmtap_sync::cose::sign_op` remains available to native Rust
 * callers, who have a memory model in which holding a secret key is a defensible thing to do.
 */
export function op_signing_input(op_bytes: Uint8Array): string;

/**
 * Recursive range-Merkle diff between what this replica holds and what a peer holds:
 * `{missing_here, missing_there, ranges_compared}` (op-ids as hex).
 *
 * Matching `(fp, count)` prunes a whole range with **nothing exchanged**, which is the entire
 * point: reconciliation cost tracks the size of the difference, not the size of the history.
 */
export function reconcile(here_json: string, there_json: string, lo_json: string, hi_json: string): string;

/**
 * Filter ops down to a caller's subscribed namespaces (§7) — the responder-side sparse-sync
 * scope. Takes ops as JSON and returns their canonical bytes as hex, so nothing is re-encoded on
 * the way out.
 */
export function scope_to_subscription(ops_json: string, subscribed_json: string): string;

/**
 * Assemble the signed snapshot wire bytes from its JSON and a detached signature. As with ops,
 * the signature is **verified before the bytes are returned**.
 */
export function snapshot_assemble(snapshot_json_no_sig: string, signature: Uint8Array): Uint8Array;

/**
 * Decode a [`SnapshotBody`](dmtap_sync::SnapshotBody) into its members: a JSON array of hex
 * `COSE_Sign1(SyncOp)` envelopes, in wire order.
 *
 * A host adopts a body by feeding each member to [`SyncEngine::ingest_signed`] — the **ordinary op
 * path**, which is the whole of §6.1.2: same signature check, same `ext-value` validation, same
 * CRDT apply, same `op-id` dedup. There is deliberately **no** "load state" entry point on this
 * binding, and §6.1.2 is explicit that an implementation exposing none is not thereby incomplete.
 */
export function snapshot_body_decode(body_bytes: Uint8Array): string;

/**
 * Encode a body from a JSON array of hex `COSE_Sign1` envelopes — the responder side of
 * `GET /sync/state/<root>`.
 *
 * Members are embedded as CBOR **items**, never `bstr`-wrapped (§5.2's op-framing rule, which
 * §5.2.1 says governs the ops inside a body too). A `bstr`-wrapped member is the C-06
 * non-conformant framing and is refused on decode rather than unwrapped.
 */
export function snapshot_body_encode(members_hex_json: string): Uint8Array;

/**
 * **The fold, without the recompute** (§6.1.2): ingest every member through the ordinary §4 op
 * path and return the resulting `det_cbor(ObservableState)`.
 *
 * This is what a **responder** uses — it is building the body, so it has no root to check against
 * yet; the root is *defined* as the hash of what this returns. A **caller** must use
 * [`snapshot_body_verify_root`] instead: folding without checking the result against
 * `Snapshot.root` is exactly the unverified adoption §5.2.1 step 3 forbids.
 */
export function snapshot_body_fold(body_bytes: Uint8Array, ns: string, receiver_now_ms: number): Uint8Array;

/**
 * **Fold-then-recompute** (§6.1.2): ingest every member of `body_bytes` through the ordinary §4 op
 * path into a **provisional** state, derive `ObservableState` per §6.1.1, and require its hash to
 * equal `root`. Returns the canonical observable-state bytes on success.
 *
 * Throws `0x0A09` if the ops do not reproduce `root` — and then **nothing** is returned, because
 * the body is discarded whole; the fold happened in a provisional state the host never saw. Pass
 * `ns` (the snapshot's namespace) to reject a member from any other namespace with `0x0A0A`, or an
 * empty string to skip that scoping.
 *
 * This is **not** `hash(body_bytes) == root`. That would prove only that someone shipped the bytes
 * they promised; this proves the ops *produce* the committed state, which is what makes a body
 * safe to resume from and what bounds a malicious signer to **omission** rather than fabrication.
 */
export function snapshot_body_verify_root(body_bytes: Uint8Array, root: Uint8Array, ns: string, receiver_now_ms: number): Uint8Array;

/**
 * Decode a signed snapshot to JSON **without** trusting it. Call [`snapshot_verify`] before use.
 */
export function snapshot_decode(bytes: Uint8Array): string;

/**
 * The detached signing preimage for a snapshot: `{preimage}` (hex), DS-tagged
 * `DMTAP-SYNC-v0/snapshot`. Same rule as ops — sign it externally, then [`snapshot_assemble`].
 *
 * Takes the snapshot as JSON without `sig` (see [`snapshot_decode`] for the shape).
 */
export function snapshot_signing_input(snapshot_json_no_sig: string): string;

/**
 * Verify a snapshot's own signature under its declared `signer`. Fails closed (`0x0A02`).
 *
 * This proves *who minted the checkpoint* — it does **not** prove the state is correct. A
 * fast-joining replica additionally hash-verifies the state body against `root` and decides
 * whether it trusts `signer` at all; §6.1's trust policy is the deployment's call, not this
 * crate's.
 */
export function snapshot_verify(bytes: Uint8Array): void;

/**
 * The §6.2 stability cut: the minimum over **live** replicas' watermarks, below which history can
 * be truncated. Returns `null` when any live replica's watermark is unknown — an unknown
 * watermark must never be read as "caught up", so the fail-closed answer is "no cut yet".
 *
 * Each element is either an HLC object or `null` for "watermark unknown". Excluding a stale
 * replica is the **caller's** liveness decision; including one drags the cut down forever.
 */
export function stability_cut(watermarks_json: string): string;

/**
 * Fingerprint only the entries within `[lo, hi)`: `{lo, hi, fp, count}`.
 */
export function summarize(entries_json: string, lo_json: string, hi_json: string): string;

/**
 * Run the state-free structural/causality/skew validators (§4) against an encoded op. Throws the
 * structured refusal on failure; this is the same check [`SyncEngine::ingest_signed`] performs.
 */
export function validate_op(op_bytes: Uint8Array, receiver_now_ms: number): void;

/**
 * Verify a `COSE_Sign1` op envelope and return the canonical op bytes it carries.
 *
 * Fails closed (`0x0A02`) on a tampered payload, a substituted `kid`, a non-empty unprotected
 * header, a detached payload, or a signature minted under any other DS-tag.
 */
export function verify_signed_op(cose_bytes: Uint8Array): Uint8Array;

/**
 * The substrate version this binding speaks, and the crate it wraps.
 */
export function version(): string;
