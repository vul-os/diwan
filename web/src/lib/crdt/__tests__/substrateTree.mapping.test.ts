/**
 * substrateTree.mapping.test.js — the Slides half of the substrate-adoption
 * investigation, recorded as EVIDENCE rather than as a claim.
 *
 * Sheets' grid was adopted onto the shared engine (see substrateGrid.js and its
 * convergence suite). Slides was the other candidate: `crdt/tree.js` is a
 * fractional-index ordered tree, and SYNC.md §4.8 specifies a movable tree.
 * This file establishes, by execution, exactly HOW MUCH of Slides the substrate
 * reproduces — so the decision not to swap the editor in this change is founded
 * on a measured boundary rather than on caution.
 *
 * VERDICT (what these tests show)
 * ------------------------------
 * The structural half maps CLEANLY and is proven here:
 *   • Diwan's slide order is a flat list under one root, addressed by the same
 *     fractional `ordKey` strings — `tree-move`'s `(parent, ordering_key)` LWW
 *     register is precisely that, with the ordKeys carried unchanged.
 *   • Reordering a slide is a second `tree-move`; greater HLC wins (§4.8/§4.4).
 *   • Deleting a slide is PERMANENT in tree.js (`n.deleted = true`, with no
 *     path that revives it), which is exactly the remove-wins death certificate
 *     of §4.5 — a better fit than Sheets' clear, which had to avoid it.
 *   • Concurrent moves converge to one identical tree regardless of delivery
 *     order.
 *
 * The CONTENT half does not map as directly, and this is the real finding:
 *   • A slide's content is object-granular (`SlideState`: per-object LWW,
 *     per-object tombstone, per-scalar LWW). Each of those IS an LWW register,
 *     so the algebra covers it — but a slide object is a NESTED JSON object,
 *     and §4.1 restricts a value to the `ext-value` subset (no nested maps). It
 *     must therefore cross as a JSON `tstr`, which works and is asserted below,
 *     at the cost of the substrate no longer seeing inside the value.
 *   • Per-object DELETION would need the same tagged-tombstone trick Sheets
 *     uses for `clearCell`, since a death certificate is per-OBJECT (a whole
 *     slide) and not per-FIELD (one shape on a slide).
 *
 * So Slides is expressible, and the remaining work is a faithful port of
 * tree.js's 849 lines — including its legacy SET_TEXT back-compat path and its
 * snapshot rehydration, which synthesises INSERT/MOVE ops to restore `ordId`.
 * That is a rewrite of a working editor's core, not the minimal, reversible
 * adoption this change is scoped to, and it is not attempted here.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { loadSync } from '../kotvaSync.js'
import { ordKeyBetween } from '../tree.js'
import type { SyncEngine, HlcClock } from '@vul-os/kotva-sync'

let sync: Awaited<ReturnType<typeof loadSync>>

beforeAll(async () => { sync = await loadSync() })

// The engine only ever round-trips this opaque HLC through JSON.stringify
// (never reads a field off it directly here), so it stays `unknown` — same
// convention as substrateGrid.ts's DecodedHlc.
type DecodedHlc = unknown

const NS = 'slides'
const ROOT = 'root'

function clockFor(seed: number): HlcClock {
  return new sync.HlcClock(new Uint8Array(32).fill(seed))
}

/** A slide reorder/insert: SYNC.md §4.8 `tree-move`, ordKey as the ordering key. */
function moveOp(clock: HlcClock, node: string, ordKey: string, parent = ROOT): Uint8Array {
  return sync.encode_op(JSON.stringify({
    kind: 8,
    ns: NS,
    target: node,
    field: ordKey,
    reference: { target: parent },
    hlc: JSON.parse(clock.tick(Date.now())) as DecodedHlc,
  }))
}

/** A permanent slide delete: §4.5 death certificate. */
function deleteOp(clock: HlcClock, node: string): Uint8Array {
  return sync.encode_op(JSON.stringify({
    kind: 4,
    ns: NS,
    target: node,
    field: 'redact',
    hlc: JSON.parse(clock.tick(Date.now())) as DecodedHlc,
  }))
}

/** Slide content: an LWW register per (slide, object|scalar). */
function contentOp(clock: HlcClock, node: string, field: string, jsonValue: unknown): Uint8Array {
  return sync.encode_op(JSON.stringify({
    kind: 3,
    ns: NS,
    target: `slide:${node}`,
    field,
    value: { tstr: JSON.stringify(jsonValue) },
    hlc: JSON.parse(clock.tick(Date.now())) as DecodedHlc,
  }))
}

function ingest(engine: SyncEngine, ops: Uint8Array[]): void {
  for (const op of ops) engine.ingest_ambient_authenticated(op, Date.now())
}

/** A tree edge, as returned by SyncEngine#tree(): [node, parent, ordKey]. */
type TreeEdge = [string, string, string]

/** The visible slide order: live children of root, sorted by (ordKey, node). */
function orderedSlides(engine: SyncEngine): string[] {
  const tree = JSON.parse(engine.tree()) as { edges?: TreeEdge[] }
  return (tree.edges || [])
    .filter(([node, parent]) => parent === ROOT && !(JSON.parse(engine.death_state(node)) as { deleted: boolean }).deleted)
    .sort((a, b) => (a[2] !== b[2] ? (a[2] < b[2] ? -1 : 1) : (a[0] < b[0] ? -1 : 1)))
    .map(([node]) => node)
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** lww_cell()'s JSON shape: the LWW register wrapper around a content op's tstr. */
type LwwCell = { value: { tstr: string } }

/** Read back a contentOp() value: unwrap lww_cell()'s tstr, then the JSON it carries. */
function lwwCellValue<T>(engine: SyncEngine, target: string, field: string): T {
  const cell = JSON.parse(engine.lww_cell(target, field)) as LwwCell
  return JSON.parse(cell.value.tstr) as T
}

describe('Slides structure maps onto SYNC.md §4.8 tree-move', () => {
  it("carries Diwan's fractional ordKeys unchanged and yields the same order", () => {
    const e = new sync.SyncEngine()
    const c = clockFor(1)

    // The SAME ordKeyBetween tree.js uses — the substrate does not need its own
    // ordering scheme, it stores whatever ordering key the product supplies.
    const k1 = ordKeyBetween('', '')
    const k3 = ordKeyBetween(k1, '')
    const k2 = ordKeyBetween(k1, k3)

    ingest(e, [moveOp(c, 's3', k3), moveOp(c, 's1', k1), moveOp(c, 's2', k2)])
    expect(orderedSlides(e)).toEqual(['s1', 's2', 's3'])
  })

  it('reordering a slide is a second move; the greater HLC wins', () => {
    const e = new sync.SyncEngine()
    const c = clockFor(1)
    const a = ordKeyBetween('', '')
    const b = ordKeyBetween(a, '')

    ingest(e, [moveOp(c, 's1', a), moveOp(c, 's2', b)])
    expect(orderedSlides(e)).toEqual(['s1', 's2'])

    ingest(e, [moveOp(c, 's1', ordKeyBetween(b, ''))]) // drag s1 past s2
    expect(orderedSlides(e)).toEqual(['s2', 's1'])
  })

  it('a deleted slide stays deleted — tree.js never revives one either', () => {
    // tree.js's TREE_OP_DELETE sets `n.deleted = true` and no op clears it, so
    // the remove-wins death certificate is the RIGHT primitive here. (This is
    // the opposite of Sheets' clearCell, where remove-wins would have been a
    // regression — see substrateGrid.js.)
    const e = new sync.SyncEngine()
    const c = clockFor(1)
    const k = ordKeyBetween('', '')

    ingest(e, [moveOp(c, 's1', k), moveOp(c, 's2', ordKeyBetween(k, ''))])
    ingest(e, [deleteOp(c, 's1')])
    expect(orderedSlides(e)).toEqual(['s2'])

    // A later ordinary move does NOT bring it back (§4.5 domination).
    ingest(e, [moveOp(c, 's1', ordKeyBetween('', k))])
    expect(orderedSlides(e)).toEqual(['s2'])
  })

  it('two replicas converge to an identical tree under any delivery order', () => {
    const A = new sync.SyncEngine()
    const B = new sync.SyncEngine()
    const ca = clockFor(1)
    const cb = clockFor(2)

    const k = ordKeyBetween('', '')
    const aOps = [moveOp(ca, 'a1', k), moveOp(ca, 'a2', ordKeyBetween(k, ''))]
    const bOps = [moveOp(cb, 'b1', ordKeyBetween('', k)), deleteOp(cb, 'b2')]

    ingest(A, aOps); ingest(A, bOps)
    ingest(B, [...bOps].reverse()); ingest(B, [...aOps].reverse())

    expect(orderedSlides(A)).toEqual(orderedSlides(B))
    expect(hex(A.state_root())).toBe(hex(B.state_root()))
  })
})

describe('Slides content: expressible, but only as opaque JSON values', () => {
  it('object-granular edits to the SAME slide both survive', () => {
    // This is the property tree.js's SlideState exists to provide, and the
    // substrate reproduces it with one LWW register per (slide, object).
    const e = new sync.SyncEngine()
    const ca = clockFor(1)
    const cb = clockFor(2)

    ingest(e, [
      contentOp(ca, 's1', 'obj:shape-a', { id: 'shape-a', x: 10 }),
      contentOp(cb, 's1', 'obj:shape-b', { id: 'shape-b', x: 90 }),
      contentOp(ca, 's1', 's:title', 'Quarterly review'),
    ])

    const a = lwwCellValue<{ x: number }>(e, 'slide:s1', 'obj:shape-a')
    const b = lwwCellValue<{ x: number }>(e, 'slide:s1', 'obj:shape-b')
    expect(a.x).toBe(10)
    expect(b.x).toBe(90) // neither clobbered the other
    expect(lwwCellValue<string>(e, 'slide:s1', 's:title')).toBe('Quarterly review')
  })

  it('THE CONSTRAINT: a nested slide object cannot be a substrate value', () => {
    // §4.1 restricts a value to the `ext-value` subset: text, bytes, ints,
    // bools and homogeneous arrays thereof. A slide object — `{id, x, y, …}` —
    // is blocked TWICE over, and both refusals are asserted here because they
    // are different failures with different implications for a Slides port.
    //
    // 1. There is no tag for a STRING-KEYED map. The value boundary cannot
    //    express a JSON object at all, so the shape a product would reach for
    //    first does not merely fail validation — it fails to encode.
    expect(() => sync.is_ext_value(JSON.stringify({ obj: { id: 'shape-a' } })))
      .toThrow(/unknown value tag/)

    // 2. The one map the boundary DOES encode — integer-keyed, CBOR's own map
    //    form — is explicitly excluded from ext-value, so it cannot smuggle
    //    structure in either. This one validates cleanly and answers `false`,
    //    which is the fail-closed answer rather than a crash.
    expect(sync.is_ext_value(JSON.stringify({ map: [[1, { tstr: 'shape-a' }]] }))).toBe(false)

    // Hence: serialise. A JSON string IS an ext-value, so slide content rides
    // as an opaque `tstr` and the substrate merges it as a unit — per-object
    // granularity is preserved (that lives in the FIELD, asserted above), but
    // the engine cannot see inside a shape.
    expect(sync.is_ext_value(JSON.stringify({ tstr: '{"id":"shape-a","x":10}' }))).toBe(true)

    // Homogeneous arrays of ext-values are fine, for the record — a port could
    // carry e.g. an animation step list natively rather than as JSON.
    expect(sync.is_ext_value(JSON.stringify({ arr: [{ tstr: 'fade' }, { tstr: 'wipe' }] }))).toBe(true)
  })
})
