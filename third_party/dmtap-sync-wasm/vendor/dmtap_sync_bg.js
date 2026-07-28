/**
 * A Hybrid Logical Clock (§3) — the per-replica clock a product ticks to stamp its own ops and
 * advances when it observes a remote op.
 *
 * The order is lexicographic by `(wall, counter, author)`, and because `author` is a public key
 * two distinct authors never tie, so the order is total across every replica.
 */
export class HlcClock {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        HlcClockFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_hlcclock_free(ptr, 0);
    }
    /**
     * The current timestamp without advancing.
     * @returns {string}
     */
    get current() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.hlcclock_current(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * A clock for `author` (a 32-byte Ed25519 public key), starting at zero.
     * @param {Uint8Array} author
     */
    constructor(author) {
        const ptr0 = passArray8ToWasm0(author, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.hlcclock_new(ptr0, len0);
        this.__wbg_ptr = ret;
        HlcClockFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Fold a remote timestamp in, so this clock never lags behind causality it has seen.
     * @param {string} hlc_json
     */
    observe(hlc_json) {
        const ptr0 = passStringToWasm0(hlc_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.hlcclock_observe(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Advance and return the next timestamp for a locally-minted op.
     * @param {number} now_ms
     * @returns {string}
     */
    tick(now_ms) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.hlcclock_tick(this.__wbg_ptr, now_ms);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
}
if (Symbol.dispose) HlcClock.prototype[Symbol.dispose] = HlcClock.prototype.free;

/**
 * A replica's sync state: the six-kind CRDT algebra (§4.3–§4.8), the idempotent ingest path, the
 * §5.1 version vector, and the §6.1 observable-state projection.
 *
 * In-memory only. Ops are deduplicated by `op-id`, so re-delivering one is a no-op, and every
 * merge is commutative/associative/idempotent — the arrival order of concurrent ops never changes
 * the outcome.
 */
export class SyncEngine {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SyncEngineFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_syncengine_free(ptr, 0);
    }
    /**
     * The per-author `P`/`N` entries behind a counter — the union of op-id-keyed deltas (§4.6,
     * correction C-01), which is what makes the merge associative.
     * @param {string} target
     * @param {string} field
     * @returns {string}
     */
    counter_entries(target, field) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(target, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(field, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            const ret = wasm.syncengine_counter_entries(this.__wbg_ptr, ptr0, len0, ptr1, len1);
            deferred3_0 = ret[0];
            deferred3_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * A PN-counter's total, as a decimal string (the §4.6 sum is an `i128` and does not in
     * general fit a JS number).
     * @param {string} target
     * @param {string} field
     * @returns {string}
     */
    counter_total(target, field) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(target, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(field, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            const ret = wasm.syncengine_counter_total(this.__wbg_ptr, ptr0, len0, ptr1, len1);
            deferred3_0 = ret[0];
            deferred3_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * The death dimension for an object: `{deleted, class}`.
     * @param {string} object
     * @returns {string}
     */
    death_state(object) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ptr0 = passStringToWasm0(object, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.syncengine_death_state(this.__wbg_ptr, ptr0, len0);
            deferred2_0 = ret[0];
            deferred2_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Whether this replica already holds an op, by `op-id`.
     * @param {Uint8Array} op_id
     * @returns {boolean}
     */
    has_op(op_id) {
        const ptr0 = passArray8ToWasm0(op_id, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.syncengine_has_op(this.__wbg_ptr, ptr0, len0);
        return ret !== 0;
    }
    /**
     * Apply an op whose authenticity was **already established out of band** — the §5.6 profile,
     * where ops ride unsigned inside an MLS group and authenticity is ambient group membership.
     *
     * The op is still fully validated (§4); only the signature check is skipped, because there is
     * no signature to check. Use this **only** when the transport itself authenticates every
     * writer. On a multi-author or untrusted path, [`SyncEngine::ingest_signed`] is the correct
     * entry point and this one is a hole: it will accept any well-formed op claiming any author.
     * @param {Uint8Array} op_bytes
     * @param {number} receiver_now_ms
     * @returns {boolean}
     */
    ingest_ambient_authenticated(op_bytes, receiver_now_ms) {
        const ptr0 = passArray8ToWasm0(op_bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.syncengine_ingest_ambient_authenticated(this.__wbg_ptr, ptr0, len0, receiver_now_ms);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * **The network ingest path.** Verify a `COSE_Sign1` envelope, then validate and apply the op
     * it carries. Returns `true` if the op was new, `false` if it was already held.
     *
     * Signature (`0x0A02`), structure/causality (`0x0A03`) and skew (`0x0A05`) are all checked
     * **before** state is touched, so a refused op leaves the replica exactly as it was.
     * @param {Uint8Array} cose_bytes
     * @param {number} receiver_now_ms
     * @returns {boolean}
     */
    ingest_signed(cose_bytes, receiver_now_ms) {
        const ptr0 = passArray8ToWasm0(cose_bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.syncengine_ingest_signed(this.__wbg_ptr, ptr0, len0, receiver_now_ms);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * The winning LWW cell for `target`/`field`: `{hlc, value}`, or `null`.
     * @param {string} target
     * @param {string} field
     * @returns {string}
     */
    lww_cell(target, field) {
        let deferred4_0;
        let deferred4_1;
        try {
            const ptr0 = passStringToWasm0(target, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(field, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            const ret = wasm.syncengine_lww_cell(this.__wbg_ptr, ptr0, len0, ptr1, len1);
            var ptr3 = ret[0];
            var len3 = ret[1];
            if (ret[3]) {
                ptr3 = 0; len3 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred4_0 = ptr3;
            deferred4_1 = len3;
            return getStringFromWasm0(ptr3, len3);
        } finally {
            wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
        }
    }
    /**
     * Fold another replica's state in. State-based merge: idempotent and order-independent.
     * @param {SyncEngine} other
     */
    merge(other) {
        _assertClass(other, SyncEngine);
        wasm.syncengine_merge(this.__wbg_ptr, other.__wbg_ptr);
    }
    /**
     * An empty replica.
     */
    constructor() {
        const ret = wasm.syncengine_new();
        this.__wbg_ptr = ret;
        SyncEngineFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * The canonical six-section observable state (§6.1.1) as deterministic CBOR. **This is the
     * artifact two replicas compare** — equal bytes mean equal observable state.
     * @returns {Uint8Array}
     */
    observable_state() {
        const ret = wasm.syncengine_observable_state(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * The same projection as JSON, for a product that wants to render it rather than hash it.
     * @returns {string}
     */
    observable_state_json() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.syncengine_observable_state_json(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Reclaim collapsed add/tombstone pairs strictly below a §6.2 stability cut. Returns the
     * number of entries dropped; **observable state is unchanged by construction** — GC below the
     * cut can only remove causal evidence no replica can still cite.
     * @param {string} cut_hlc_json
     * @returns {number}
     */
    prune_below(cut_hlc_json) {
        const ptr0 = passStringToWasm0(cut_hlc_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.syncengine_prune_below(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * An RGA sequence: `{values, atoms}`, where `atoms` carries every element id including
     * tombstones (§4.7 keeps them until the §6.2 stability cut) and `values` is the visible
     * sequence.
     * @param {string} target
     * @returns {string}
     */
    sequence(target) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(target, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.syncengine_sequence(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Whether an OR-Set element is present (add-wins, unless a death certificate dominates).
     * @param {string} target
     * @param {string} value_json
     * @returns {boolean}
     */
    set_contains(target, value_json) {
        const ptr0 = passStringToWasm0(target, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(value_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.syncengine_set_contains(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * Every present `(target, element)` pair.
     * @returns {string}
     */
    set_members() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.syncengine_set_members(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * The add-tags of an element that no observed-remove has tombstoned — the causal evidence
     * behind "present".
     * @param {string} target
     * @param {string} value_json
     * @returns {string}
     */
    set_surviving_tags(target, value_json) {
        let deferred4_0;
        let deferred4_1;
        try {
            const ptr0 = passStringToWasm0(target, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(value_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            const ret = wasm.syncengine_set_surviving_tags(this.__wbg_ptr, ptr0, len0, ptr1, len1);
            var ptr3 = ret[0];
            var len3 = ret[1];
            if (ret[3]) {
                ptr3 = 0; len3 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred4_0 = ptr3;
            deferred4_1 = len3;
            return getStringFromWasm0(ptr3, len3);
        } finally {
            wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
        }
    }
    /**
     * The §6.1 observable-state root:
     * `0x1e ‖ BLAKE3-256(DMTAP-SYNC-v0/snapshot-state ‖ 0x00 ‖ state)`.
     * @returns {Uint8Array}
     */
    state_root() {
        const ret = wasm.syncengine_state_root(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * The movable tree after §4.8 cycle-safe replay: `{edges, applied, skipped}`. A move that
     * would close a cycle is **skipped**, deterministically and identically on every replica —
     * a skip is not an error.
     * @returns {string}
     */
    tree() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.syncengine_tree(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Recompute the root and compare it to a claimed one. A mismatch is `0x0A09` — evidence of
     * divergence, whose §12 action is `HALT_ALERT`, not a retry.
     * @param {Uint8Array} claimed
     */
    verify_root(claimed) {
        const ptr0 = passArray8ToWasm0(claimed, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.syncengine_verify_root(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * The §5.1 version vector — the per-author max HLC this replica has applied.
     * @returns {string}
     */
    version_vector() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.syncengine_version_vector(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * The version vector's canonical CBOR (the `covers` member of a §6.1 snapshot).
     * @returns {Uint8Array}
     */
    version_vector_cbor() {
        const ret = wasm.syncengine_version_vector_cbor(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) SyncEngine.prototype[Symbol.dispose] = SyncEngine.prototype.free;

/**
 * **The §5.2.1 responder predicate**: is a caller holding `vector` below the floor this snapshot
 * stands in for — i.e. would the surviving suffix be an incomplete answer for it?
 *
 * The test is domination of `covers`, not a comparison against the floor alone. A responder for
 * which this is true MUST answer fast-join; one for which it is false MUST answer with ops.
 * @param {Uint8Array} snapshot_bytes
 * @param {string} vector_json
 * @returns {boolean}
 */
export function caller_is_below_floor(snapshot_bytes, vector_json) {
    const ptr0 = passArray8ToWasm0(snapshot_bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(vector_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.caller_is_below_floor(ptr0, len0, ptr1, len1);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] !== 0;
}

/**
 * Whether an author is in the admitted set (§8/§9). Throws `0x0A01` if not.
 *
 * This is a **list membership check**, not a policy engine: resolving `DeviceCert` chains,
 * namespace policy objects and revocation is capability ① and lives outside this binding.
 * @param {Uint8Array} author
 * @param {string} admitted_hex_json
 */
export function check_admitted(author, admitted_hex_json) {
    const ptr0 = passArray8ToWasm0(author, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(admitted_hex_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.check_admitted(ptr0, len0, ptr1, len1);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

/**
 * Whether a PN-counter op may touch an entry: an author may only mutate its **own** `P`/`N`
 * (§4.6). Throws `0x0A06` otherwise.
 * @param {Uint8Array} op_author
 * @param {Uint8Array} entry_author
 */
export function check_counter_entry(op_author, entry_author) {
    const ptr0 = passArray8ToWasm0(op_author, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(entry_author, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.check_counter_entry(ptr0, len0, ptr1, len1);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

/**
 * Whether an op may reference a target: cross-namespace references are `0x0A0A` (§7).
 * @param {string} op_ns
 * @param {string} referenced_target_ns
 */
export function check_ns_ref(op_ns, referenced_target_ns) {
    const ptr0 = passStringToWasm0(op_ns, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(referenced_target_ns, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.check_ns_ref(ptr0, len0, ptr1, len1);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

/**
 * Compare two HLCs in the normative total order: `-1`, `0` or `1`.
 * @param {string} a_json
 * @param {string} b_json
 * @returns {number}
 */
export function compare_hlc(a_json, b_json) {
    const ptr0 = passStringToWasm0(a_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(b_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.compare_hlc(ptr0, len0, ptr1, len1);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0];
}

/**
 * Decode a canonical observable-state body to its JSON projection.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function decode_observable_state(bytes) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.decode_observable_state(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Decode canonical `SyncOp` bytes to JSON. Non-canonical encodings are **refused**, never
 * silently re-canonicalized (§2.2).
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function decode_op(bytes) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.decode_op(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * The four wire parts of a `COSE_Sign1`, for inspection without trusting it:
 * `{protected, unprotected, payload, signature, alg, kid}`. Decoding and trusting are
 * deliberately separate steps — this does **not** verify.
 * @param {Uint8Array} cose_bytes
 * @returns {string}
 */
export function decode_signed_op(cose_bytes) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passArray8ToWasm0(cose_bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.decode_signed_op(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Decode deterministic CBOR back to a tagged JSON value.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function decode_value(bytes) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.decode_value(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * The canonical CBOR encoding of an HLC — the bytes §2.2 tiebreaks and §6.1.1 sorts compare.
 * @param {string} hlc_json
 * @returns {Uint8Array}
 */
export function encode_hlc(hlc_json) {
    const ptr0 = passStringToWasm0(hlc_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.encode_hlc(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * Encode a §6.1.1 observable state from its JSON projection (the shape
 * [`SyncEngine::observable_state_json`] emits) to canonical CBOR.
 *
 * A replica adopting a fast-join checkpoint receives a **state body** rather than a history, so it
 * needs to move between the two representations without going through the op log: fetch the body,
 * re-encode it, hash it, and compare against `Snapshot.root` before trusting a byte of it.
 * Section entries are re-sorted canonically on the way out, so a body that arrives in any other
 * order still hashes to the same root — or, if it was tampered with, visibly does not.
 * @param {string} state_json
 * @returns {Uint8Array}
 */
export function encode_observable_state(state_json) {
    const ptr0 = passStringToWasm0(state_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.encode_observable_state(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * Encode a `SyncOp` (JSON) to its canonical §4.1 deterministic-CBOR bytes.
 * @param {string} op_json
 * @returns {Uint8Array}
 */
export function encode_op(op_json) {
    const ptr0 = passStringToWasm0(op_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.encode_op(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * Encode a tagged JSON value (see the `jsonval` module docs) to deterministic CBOR (§18.1.1).
 * @param {string} value_json
 * @returns {Uint8Array}
 */
export function encode_value(value_json) {
    const ptr0 = passStringToWasm0(value_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.encode_value(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * The `0x0A` error registry, for a product mapping refusals to its own UI:
 * `[{code, name, action}, …]`.
 * @returns {string}
 */
export function error_registry() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.error_registry();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

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
 * @param {Uint8Array} fastjoin_bytes
 * @param {string} caller_vector_json
 * @param {string} subscribed_json
 * @param {string} admitted_hex_json
 * @param {number} receiver_now_ms
 * @param {Uint8Array | null} [fetched_body]
 * @returns {Uint8Array}
 */
export function fastjoin_adopt(fastjoin_bytes, caller_vector_json, subscribed_json, admitted_hex_json, receiver_now_ms, fetched_body) {
    const ptr0 = passArray8ToWasm0(fastjoin_bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(caller_vector_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(subscribed_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passStringToWasm0(admitted_hex_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len3 = WASM_VECTOR_LEN;
    var ptr4 = isLikeNone(fetched_body) ? 0 : passArray8ToWasm0(fetched_body, wasm.__wbindgen_malloc);
    var len4 = WASM_VECTOR_LEN;
    const ret = wasm.fastjoin_adopt(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, receiver_now_ms, ptr4, len4);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v6 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v6;
}

/**
 * [`fastjoin_adopt`] preceded by the [progress MUST](fastjoin_check_progress) — the call a real
 * pull loop should use.
 * @param {Uint8Array} fastjoin_bytes
 * @param {Uint8Array | null | undefined} previous_root
 * @param {string | null | undefined} previous_covers_json
 * @param {string} caller_vector_json
 * @param {string} subscribed_json
 * @param {string} admitted_hex_json
 * @param {number} receiver_now_ms
 * @param {Uint8Array | null} [fetched_body]
 * @returns {Uint8Array}
 */
export function fastjoin_adopt_after(fastjoin_bytes, previous_root, previous_covers_json, caller_vector_json, subscribed_json, admitted_hex_json, receiver_now_ms, fetched_body) {
    const ptr0 = passArray8ToWasm0(fastjoin_bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    var ptr1 = isLikeNone(previous_root) ? 0 : passArray8ToWasm0(previous_root, wasm.__wbindgen_malloc);
    var len1 = WASM_VECTOR_LEN;
    var ptr2 = isLikeNone(previous_covers_json) ? 0 : passStringToWasm0(previous_covers_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len2 = WASM_VECTOR_LEN;
    const ptr3 = passStringToWasm0(caller_vector_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passStringToWasm0(subscribed_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len4 = WASM_VECTOR_LEN;
    const ptr5 = passStringToWasm0(admitted_hex_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len5 = WASM_VECTOR_LEN;
    var ptr6 = isLikeNone(fetched_body) ? 0 : passArray8ToWasm0(fetched_body, wasm.__wbindgen_malloc);
    var len6 = WASM_VECTOR_LEN;
    const ret = wasm.fastjoin_adopt_after(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, receiver_now_ms, ptr6, len6);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v8 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v8;
}

/**
 * **§5.2.1 step 2 in isolation** (§5.2.2): `covers` well-formed and non-empty (`0x0A03`), and the
 * caller genuinely below the floor (`0x0A09`). Throws the structured refusal; returns nothing when
 * the fast-join passes.
 *
 * There is deliberately **no** floor-vs-`covers` comparison in here — see
 * [`fastjoin_naive_covers_lacks_floor_rejected`] for the predicate that was removed and why.
 * @param {Uint8Array} fastjoin_bytes
 * @param {string} caller_vector_json
 */
export function fastjoin_check_covers(fastjoin_bytes, caller_vector_json) {
    const ptr0 = passArray8ToWasm0(fastjoin_bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(caller_vector_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.fastjoin_check_covers(ptr0, len0, ptr1, len1);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

/**
 * **The §5.2.1 step-5 progress MUST (§14 C-07).** A re-pull answered with another `fast-join`
 * carrying the *same* `Snapshot.root` **and** `covers` means the responder is looping — adopting
 * again cannot advance the caller. Throws `0x0A09`; returns nothing on progress.
 *
 * Pass `previous_root`/`previous_covers_json` from the fast-join adopted on the preceding round of
 * the same join, or `undefined` on the first round. A host driving a pull loop MUST call this (or
 * [`fastjoin_adopt_after`]) rather than [`fastjoin_adopt`] alone: the loop it prevents is
 * unbounded, and nothing else in the protocol terminates it.
 * @param {Uint8Array} fastjoin_bytes
 * @param {Uint8Array | null} [previous_root]
 * @param {string | null} [previous_covers_json]
 */
export function fastjoin_check_progress(fastjoin_bytes, previous_root, previous_covers_json) {
    const ptr0 = passArray8ToWasm0(fastjoin_bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    var ptr1 = isLikeNone(previous_root) ? 0 : passArray8ToWasm0(previous_root, wasm.__wbindgen_malloc);
    var len1 = WASM_VECTOR_LEN;
    var ptr2 = isLikeNone(previous_covers_json) ? 0 : passStringToWasm0(previous_covers_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len2 = WASM_VECTOR_LEN;
    const ret = wasm.fastjoin_check_progress(ptr0, len0, ptr1, len1, ptr2, len2);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

/**
 * **Advisory only (§5.2.2, MAY).** Does the fast-join's `covers` carry a mark for `floor.author`?
 *
 * Exposed so a host can *log* the signal, and deliberately named so it cannot be mistaken for a
 * verdict. It is **not** a conformance test: an author whose only op sits *at* the floor is
 * retained rather than truncated, so `covers` need never name it. Treating `false` as a failure
 * rejects conformant peers — the defect §14 C-07 removed.
 * @param {Uint8Array} fastjoin_bytes
 * @returns {boolean}
 */
export function fastjoin_covers_carries_floor_author_mark(fastjoin_bytes) {
    const ptr0 = passArray8ToWasm0(fastjoin_bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.fastjoin_covers_carries_floor_author_mark(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] !== 0;
}

/**
 * Decode a `FastJoin` — the answer a `pull` returns to a caller below the responder's §6.2
 * truncation floor — **without** trusting it: `{snapshot, floor, state}`.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function fastjoin_decode(bytes) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fastjoin_decode(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Encode a `FastJoin` from `{snapshot, floor, state?}` (the shape [`fastjoin_decode`] emits).
 * @param {string} fastjoin_json
 * @returns {Uint8Array}
 */
export function fastjoin_encode(fastjoin_json) {
    const ptr0 = passStringToWasm0(fastjoin_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.fastjoin_encode(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * The **rejected** naive predicate `covers.lacks(floor)`, exposed *only* so the cross-surface trace
 * can prove both surfaces agree it fires TRUE on a well-formed fast-join — and that neither acts
 * on it.
 *
 * **Never gate adoption on this.** `floor` is a single `Hlc` and `covers` is a per-author
 * `VersionVector`; there is no ordering between them (§5.2.2). This is a counterexample witness,
 * not an API for deciding anything.
 * @param {Uint8Array} fastjoin_bytes
 * @returns {boolean}
 */
export function fastjoin_naive_covers_lacks_floor_rejected(fastjoin_bytes) {
    const ptr0 = passArray8ToWasm0(fastjoin_bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.fastjoin_naive_covers_lacks_floor_rejected(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] !== 0;
}

/**
 * The content address a fast-join's body must be fetched from (`GET /sync/state/<root>`) — what
 * the host needs before it can call [`fastjoin_adopt`].
 * @param {Uint8Array} fastjoin_bytes
 * @returns {Uint8Array}
 */
export function fastjoin_state_address(fastjoin_bytes) {
    const ptr0 = passArray8ToWasm0(fastjoin_bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.fastjoin_state_address(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * The range-Merkle fingerprint of a set of `{hlc, id}` entries: `{fp, count}`.
 *
 * `count` is carried alongside the hash on purpose — without it an empty range and a range whose
 * ops happen to fold to the same value would be indistinguishable (§5.3).
 * @param {string} entries_json
 * @returns {string}
 */
export function fingerprint(entries_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(entries_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fingerprint(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Whether a value is a legal §4.1 `cv` (the `ext-value` subset). A `SyncOp` carrying anything
 * else is refused at validation, so a product can check before it mints.
 * @param {string} value_json
 * @returns {boolean}
 */
export function is_ext_value(value_json) {
    const ptr0 = passStringToWasm0(value_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.is_ext_value(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] !== 0;
}

/**
 * The §6.1 root of an already-encoded observable state — for verifying a state body fetched by
 * address against a `Snapshot.root` before adopting it.
 * @param {Uint8Array} state_cbor
 * @returns {Uint8Array}
 */
export function observable_state_root(state_cbor) {
    const ptr0 = passArray8ToWasm0(state_cbor, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.observable_state_root(ptr0, len0);
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * Assemble the wire `COSE_Sign1` from an op and a detached signature over
 * [`op_signing_input`]'s `sig_structure`.
 *
 * The assembled envelope is **verified before it is returned**: a signature produced under the
 * wrong key, over the wrong preimage, or by a custodian that silently failed cannot leave this
 * function as a well-formed op. A binding that emitted unverifiable envelopes would just push the
 * failure onto some other replica's ingest path, hours later and with no context.
 * @param {Uint8Array} op_bytes
 * @param {Uint8Array} signature
 * @returns {Uint8Array}
 */
export function op_attach_signature(op_bytes, signature) {
    const ptr0 = passArray8ToWasm0(op_bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(signature, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.op_attach_signature(ptr0, len0, ptr1, len1);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v3;
}

/**
 * The §4.1 `op-id` content address of an encoded op (`0x1e ‖ BLAKE3-256(DS-tag ‖ 0x00 ‖ body)`).
 * @param {Uint8Array} op_bytes
 * @returns {Uint8Array}
 */
export function op_id(op_bytes) {
    const ptr0 = passArray8ToWasm0(op_bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.op_id(ptr0, len0);
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * The eight §4.2 op kinds by name, so a JS caller never hard-codes a magic number.
 * @returns {string}
 */
export function op_kinds() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.op_kinds();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

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
 * @param {Uint8Array} op_bytes
 * @returns {string}
 */
export function op_signing_input(op_bytes) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passArray8ToWasm0(op_bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.op_signing_input(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Recursive range-Merkle diff between what this replica holds and what a peer holds:
 * `{missing_here, missing_there, ranges_compared}` (op-ids as hex).
 *
 * Matching `(fp, count)` prunes a whole range with **nothing exchanged**, which is the entire
 * point: reconciliation cost tracks the size of the difference, not the size of the history.
 * @param {string} here_json
 * @param {string} there_json
 * @param {string} lo_json
 * @param {string} hi_json
 * @returns {string}
 */
export function reconcile(here_json, there_json, lo_json, hi_json) {
    let deferred6_0;
    let deferred6_1;
    try {
        const ptr0 = passStringToWasm0(here_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(there_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(lo_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(hi_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len3 = WASM_VECTOR_LEN;
        const ret = wasm.reconcile(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
        var ptr5 = ret[0];
        var len5 = ret[1];
        if (ret[3]) {
            ptr5 = 0; len5 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred6_0 = ptr5;
        deferred6_1 = len5;
        return getStringFromWasm0(ptr5, len5);
    } finally {
        wasm.__wbindgen_free(deferred6_0, deferred6_1, 1);
    }
}

/**
 * Filter ops down to a caller's subscribed namespaces (§7) — the responder-side sparse-sync
 * scope. Takes ops as JSON and returns their canonical bytes as hex, so nothing is re-encoded on
 * the way out.
 * @param {string} ops_json
 * @param {string} subscribed_json
 * @returns {string}
 */
export function scope_to_subscription(ops_json, subscribed_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(ops_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(subscribed_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.scope_to_subscription(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Assemble the signed snapshot wire bytes from its JSON and a detached signature. As with ops,
 * the signature is **verified before the bytes are returned**.
 * @param {string} snapshot_json_no_sig
 * @param {Uint8Array} signature
 * @returns {Uint8Array}
 */
export function snapshot_assemble(snapshot_json_no_sig, signature) {
    const ptr0 = passStringToWasm0(snapshot_json_no_sig, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(signature, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.snapshot_assemble(ptr0, len0, ptr1, len1);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v3;
}

/**
 * Decode a [`SnapshotBody`](dmtap_sync::SnapshotBody) into its members: a JSON array of hex
 * `COSE_Sign1(SyncOp)` envelopes, in wire order.
 *
 * A host adopts a body by feeding each member to [`SyncEngine::ingest_signed`] — the **ordinary op
 * path**, which is the whole of §6.1.2: same signature check, same `ext-value` validation, same
 * CRDT apply, same `op-id` dedup. There is deliberately **no** "load state" entry point on this
 * binding, and §6.1.2 is explicit that an implementation exposing none is not thereby incomplete.
 * @param {Uint8Array} body_bytes
 * @returns {string}
 */
export function snapshot_body_decode(body_bytes) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passArray8ToWasm0(body_bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.snapshot_body_decode(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Encode a body from a JSON array of hex `COSE_Sign1` envelopes — the responder side of
 * `GET /sync/state/<root>`.
 *
 * Members are embedded as CBOR **items**, never `bstr`-wrapped (§5.2's op-framing rule, which
 * §5.2.1 says governs the ops inside a body too). A `bstr`-wrapped member is the C-06
 * non-conformant framing and is refused on decode rather than unwrapped.
 * @param {string} members_hex_json
 * @returns {Uint8Array}
 */
export function snapshot_body_encode(members_hex_json) {
    const ptr0 = passStringToWasm0(members_hex_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.snapshot_body_encode(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * **The fold, without the recompute** (§6.1.2): ingest every member through the ordinary §4 op
 * path and return the resulting `det_cbor(ObservableState)`.
 *
 * This is what a **responder** uses — it is building the body, so it has no root to check against
 * yet; the root is *defined* as the hash of what this returns. A **caller** must use
 * [`snapshot_body_verify_root`] instead: folding without checking the result against
 * `Snapshot.root` is exactly the unverified adoption §5.2.1 step 3 forbids.
 * @param {Uint8Array} body_bytes
 * @param {string} ns
 * @param {number} receiver_now_ms
 * @returns {Uint8Array}
 */
export function snapshot_body_fold(body_bytes, ns, receiver_now_ms) {
    const ptr0 = passArray8ToWasm0(body_bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(ns, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.snapshot_body_fold(ptr0, len0, ptr1, len1, receiver_now_ms);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v3;
}

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
 * @param {Uint8Array} body_bytes
 * @param {Uint8Array} root
 * @param {string} ns
 * @param {number} receiver_now_ms
 * @returns {Uint8Array}
 */
export function snapshot_body_verify_root(body_bytes, root, ns, receiver_now_ms) {
    const ptr0 = passArray8ToWasm0(body_bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(root, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(ns, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.snapshot_body_verify_root(ptr0, len0, ptr1, len1, ptr2, len2, receiver_now_ms);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v4 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v4;
}

/**
 * Decode a signed snapshot to JSON **without** trusting it. Call [`snapshot_verify`] before use.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function snapshot_decode(bytes) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.snapshot_decode(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * The detached signing preimage for a snapshot: `{preimage}` (hex), DS-tagged
 * `DMTAP-SYNC-v0/snapshot`. Same rule as ops — sign it externally, then [`snapshot_assemble`].
 *
 * Takes the snapshot as JSON without `sig` (see [`snapshot_decode`] for the shape).
 * @param {string} snapshot_json_no_sig
 * @returns {string}
 */
export function snapshot_signing_input(snapshot_json_no_sig) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(snapshot_json_no_sig, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.snapshot_signing_input(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Verify a snapshot's own signature under its declared `signer`. Fails closed (`0x0A02`).
 *
 * This proves *who minted the checkpoint* — it does **not** prove the state is correct. A
 * fast-joining replica additionally hash-verifies the state body against `root` and decides
 * whether it trusts `signer` at all; §6.1's trust policy is the deployment's call, not this
 * crate's.
 * @param {Uint8Array} bytes
 */
export function snapshot_verify(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.snapshot_verify(ptr0, len0);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

/**
 * The §6.2 stability cut: the minimum over **live** replicas' watermarks, below which history can
 * be truncated. Returns `null` when any live replica's watermark is unknown — an unknown
 * watermark must never be read as "caught up", so the fail-closed answer is "no cut yet".
 *
 * Each element is either an HLC object or `null` for "watermark unknown". Excluding a stale
 * replica is the **caller's** liveness decision; including one drags the cut down forever.
 * @param {string} watermarks_json
 * @returns {string}
 */
export function stability_cut(watermarks_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(watermarks_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.stability_cut(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Fingerprint only the entries within `[lo, hi)`: `{lo, hi, fp, count}`.
 * @param {string} entries_json
 * @param {string} lo_json
 * @param {string} hi_json
 * @returns {string}
 */
export function summarize(entries_json, lo_json, hi_json) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(entries_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(lo_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(hi_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.summarize(ptr0, len0, ptr1, len1, ptr2, len2);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}

/**
 * Run the state-free structural/causality/skew validators (§4) against an encoded op. Throws the
 * structured refusal on failure; this is the same check [`SyncEngine::ingest_signed`] performs.
 * @param {Uint8Array} op_bytes
 * @param {number} receiver_now_ms
 */
export function validate_op(op_bytes, receiver_now_ms) {
    const ptr0 = passArray8ToWasm0(op_bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.validate_op(ptr0, len0, receiver_now_ms);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

/**
 * Verify a `COSE_Sign1` op envelope and return the canonical op bytes it carries.
 *
 * Fails closed (`0x0A02`) on a tampered payload, a substituted `kid`, a non-empty unprotected
 * header, a detached payload, or a signature minted under any other DS-tag.
 * @param {Uint8Array} cose_bytes
 * @returns {Uint8Array}
 */
export function verify_signed_op(cose_bytes) {
    const ptr0 = passArray8ToWasm0(cose_bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.verify_signed_op(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * The substrate version this binding speaks, and the crate it wraps.
 * @returns {string}
 */
export function version() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.version();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}
export function __wbg_Error_ef53bc310eb298a0(arg0, arg1) {
    const ret = Error(getStringFromWasm0(arg0, arg1));
    return ret;
}
export function __wbg___wbindgen_throw_1506f2235d1bdba0(arg0, arg1) {
    throw new Error(getStringFromWasm0(arg0, arg1));
}
export function __wbindgen_init_externref_table() {
    const table = wasm.__wbindgen_externrefs;
    const offset = table.grow(4);
    table.set(0, undefined);
    table.set(offset + 0, undefined);
    table.set(offset + 1, null);
    table.set(offset + 2, true);
    table.set(offset + 3, false);
}
const HlcClockFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_hlcclock_free(ptr, 1));
const SyncEngineFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_syncengine_free(ptr, 1));

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;


let wasm;
export function __wbg_set_wasm(val) {
    wasm = val;
}
