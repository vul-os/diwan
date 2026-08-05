/**
 * CRDT-native persistence, phase 1 — convergence guarantee.
 *
 * The defining property of the append-only update log (vs the old single-blob
 * PUT + 409 CAS): two clients that diverge OFFLINE, each append their own edits,
 * and on reload the document converges to a byte-identical state with NOTHING
 * discarded. These tests drive the exact in-memory contract the Go LocalStore
 * implements (createMemoryUpdateLog), through the real UpdateLogSync client.
 */

import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { UpdateLogSync, createMemoryUpdateLog, type UpdateLogTransport, type UpdateLogTransportError } from '../updateLog.js'

// Reload = a fresh Y.Doc that hydrates from the shared log.
async function reload(log: UpdateLogTransport): Promise<Y.Doc> {
  const ydoc = new Y.Doc()
  const sync = new UpdateLogSync({ ydoc, transport: log })
  await sync.hydrate()
  return ydoc
}

// VERIFIED TOOL DISAGREEMENT: yjs's Y.Text really does override toString() to
// return its plain-text content (confirmed in dist/yjs.cjs) — the effect
// SharedType text editing depends on — but the hand-written YText.d.ts (built
// from JSDoc, not the source class) never declares that override, so its
// apparent type inherits Object's. no-base-to-string can't see the runtime
// override; centralised here instead of disabling per call site.
// eslint-disable-next-line @typescript-eslint/no-base-to-string
const ytext = (doc: Y.Doc, name: string): string => doc.getText(name).toString()

describe('UpdateLogSync convergence', () => {
  it('two clients diverge offline → both append → reload converges byte-identical', async () => {
    const log = createMemoryUpdateLog()

    // Both clients start from the same (empty) log, then edit OFFLINE — neither
    // sees the other's edits before appending.
    const docA = new Y.Doc()
    const syncA = new UpdateLogSync({ ydoc: docA, transport: log })
    await syncA.hydrate()
    syncA.start()

    const docB = new Y.Doc()
    const syncB = new UpdateLogSync({ ydoc: docB, transport: log })
    await syncB.hydrate()
    syncB.start()

    // Divergent offline edits to the same shared type.
    docA.getText('t').insert(0, 'AAA')
    docB.getText('t').insert(0, 'BBB')
    docA.getMap('m').set('a', 1)
    docB.getMap('m').set('b', 2)

    // Each flushes its own edits to the shared log.
    await syncA.flush()
    await syncB.flush()
    await syncA.stop()
    await syncB.stop()

    // Two frames landed (one per client), no data lost.
    expect(log._debug().frames.length).toBe(2)

    // Reload two fresh clients from the log: both converge.
    const a2 = await reload(log)
    const b2 = await reload(log)

    // Byte-identical converged state.
    const encA = Y.encodeStateAsUpdate(a2)
    const encB = Y.encodeStateAsUpdate(b2)
    expect(Array.from(encA)).toEqual(Array.from(encB))

    // And nothing was discarded — both edits survive on both reloads.
    for (const doc of [a2, b2]) {
      const text = ytext(doc, 't')
      expect(text).toContain('AAA')
      expect(text).toContain('BBB')
      expect(doc.getMap('m').get('a')).toBe(1)
      expect(doc.getMap('m').get('b')).toBe(2)
    }
  })

  it('converges byte-identical after snapshot compaction', async () => {
    const log = createMemoryUpdateLog()

    const docA = new Y.Doc()
    const syncA = new UpdateLogSync({ ydoc: docA, transport: log })
    await syncA.hydrate()
    syncA.start()
    docA.getText('t').insert(0, 'hello ')
    await syncA.flush()
    docA.getText('t').insert(6, 'world')
    await syncA.flush()

    // Compact: the whole state becomes a snapshot; earlier frames are pruned.
    await syncA.snapshot()
    await syncA.stop()

    const dbg = log._debug()
    const snap = dbg.snapshot
    expect(snap).not.toBeNull()
    if (!snap) throw new Error('expected snapshot to be set')
    // Every frame at or below the snapshot floor was pruned.
    const floor = snap.floor ?? 0
    expect(dbg.frames.every((f) => f.seq > floor)).toBe(true)

    // A brand-new client reconstructs the document from snapshot + tail.
    const fresh = await reload(log)
    expect(ytext(fresh, 't')).toBe('hello world')
    expect(Array.from(Y.encodeStateAsUpdate(fresh)))
      .toEqual(Array.from(Y.encodeStateAsUpdate(docA)))
  })

  it('a client that edits AFTER a peer snapshot still converges (frame above floor preserved)', async () => {
    const log = createMemoryUpdateLog()

    // Client A seeds + snapshots.
    const docA = new Y.Doc()
    const syncA = new UpdateLogSync({ ydoc: docA, transport: log })
    await syncA.hydrate()
    syncA.start()
    docA.getText('t').insert(0, 'base')
    await syncA.flush()
    await syncA.snapshot()

    // Client B loads the snapshot, then edits and appends a frame ABOVE the floor.
    const docB = new Y.Doc()
    const syncB = new UpdateLogSync({ ydoc: docB, transport: log })
    await syncB.hydrate()
    syncB.start()
    docB.getText('t').insert(docB.getText('t').length, '+more')
    await syncB.flush()
    await syncA.stop()
    await syncB.stop()

    const fresh = await reload(log)
    expect(ytext(fresh, 't')).toBe('base+more')
  })

  it('hydrate disables cleanly when the server has no update log (404)', async () => {
    const failing: UpdateLogTransport = {
      // No await: both throw synchronously; UpdateLogSync's own await'd calls
      // to load/append are already inside a try/catch, so a sync throw lands
      // in the same place a rejected Promise would.
      load: () => { const e: UpdateLogTransportError = Object.assign(new Error('not found'), { status: 404 }); throw e },
      append: () => { throw new Error('should not be called') },
    }
    const ydoc = new Y.Doc()
    const sync = new UpdateLogSync({ ydoc, transport: failing })
    const ok = await sync.hydrate()
    expect(ok).toBe(false)
    expect(sync.enabled).toBe(false)
    // start() is a no-op when disabled; a local edit triggers no append.
    sync.start()
    ydoc.getText('t').insert(0, 'x')
    await sync.flush() // must not throw
  })
})
