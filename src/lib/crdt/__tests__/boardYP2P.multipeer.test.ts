/**
 * Whiteboard co-editing over Office's P2P collab engine — the guarantees that
 * matter, pinned exactly as the Docs multipeer suite pins them for documents:
 *
 *   • The whiteboard rides the SAME YP2PCollabSession + FabricClient transport as
 *     Docs — there is NO central whiteboard/collab server. A relay is a dumb
 *     content-blind frame router; every peer is directly in the mesh.
 *   • THREE peers converge on the identical scene (a mesh, not a hub).
 *   • A peer that JOINS LATE catches up to the full current scene via the
 *     state-vector resync — no server bootstrap.
 *   • The scene is NEVER visible on the wire: a relay/eavesdropper who captures
 *     frames holds only ciphertext (the E2E property, for the whiteboard path).
 *   • Concurrent edits to different elements merge (the per-element Y.Map).
 *
 * The Excalidraw canvas is stood in for by an in-memory scene API driven through
 * the REAL ExcalidrawYBinding — so the whole Yjs<->scene glue runs for real; only
 * the socket and the canvas are fake.
 */

import { describe, it, expect } from 'vitest'
import { YP2PCollabSession, type SessionFabric } from '../yP2PSession.js'
import { createBoardYContext, boardDocToScene, ELEMENTS_KEY, type BoardYContext, type BoardElement } from '../boardYdoc.js'
import { ExcalidrawYBinding } from '../../../apps/whiteboard/binding.js'
import { parseInvite, deriveRoomKeys, openFrame } from '../p2pRoom.js'

// A tiny in-process mesh fabric: every connected peer receives every frame any
// member broadcasts. `wireLog` records raw wire frames — exactly what a relay /
// passive eavesdropper would see.
class FakeFabric extends EventTarget {
  peers: Set<FakeFabric>
  id: string
  wireLog?: string[]
  constructor(wireLog?: string[]) {
    super()
    this.peers = new Set()
    this.id = Math.random().toString(36).slice(2)
    this.wireLog = wireLog
  }
  connect(other: FakeFabric) { this.peers.add(other); other.peers.add(this) }
  disconnect() { for (const p of this.peers) p.peers.delete(this); this.peers.clear() }
  async join() {}
  leave() { this.disconnect() }
  send(frame: string) {
    if (this.wireLog) this.wireLog.push(frame)
    for (const p of this.peers) {
      p.dispatchEvent(new CustomEvent('message', { detail: { from: this.id, data: frame } }))
    }
  }
  sendTo(_peerId: string, frame: string) { this.send(frame) }
}

// FakeFabric really does emit exactly the SessionFabric event shape (see the
// class above) — the cast is only needed because EventTarget's inherited
// addEventListener is typed generically, same as production's cast of the real
// FabricClient in yP2PSession.ts.
const asFabric = (f: FakeFabric): SessionFabric => f as unknown as SessionFabric

const INVITE = 'https://office.test/whiteboards/wb1'
// A fixed sleep, used ONLY where nothing specific is being awaited (session
// setup, and the deliberate partition below). Positive assertions poll with
// `until`: a fixed 60 ms was not reliably enough for an update to cross the
// fake fabric on a loaded machine, which produces a flake rather than a
// finding. Same change as yP2PSession.test.js.
const settle = () => new Promise((r) => setTimeout(r, 60))

/** Poll `ok()` until true; fail with `label` in the message if it never is. */
async function until(ok: () => unknown, label: string, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout
  for (;;) {
    let ready = false
    try { ready = !!ok() } catch { ready = false }
    if (ready) return
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeout}ms waiting for: ${label}`)
    }
    await new Promise((r) => setTimeout(r, 5))
  }
}

/**
 * Structural equality of two element maps, INSENSITIVE to key order — two peers
 * that have converged can still have inserted the ids into their Y.Map in
 * different orders, so a plain JSON.stringify comparison would never settle.
 */
const stable = (v: unknown): string => JSON.stringify(v, (_k, val) =>
  (val && typeof val === 'object' && !Array.isArray(val)
    ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, (val as Record<string, unknown>)[k]]))
    : val))
const sameEls = (x: unknown, y: unknown) => stable(x) === stable(y)

type Peer = {
  ctx: BoardYContext
  binding: ExcalidrawYBinding
  fabric: FakeFabric
  sceneIds: () => string[]
  scene: () => BoardElement[]
  session?: YP2PCollabSession
}

/** A peer: a real Y.Doc + board ctx + binding + an in-memory scene API. */
function makePeer(fabric: FakeFabric): Peer {
  let scene: BoardElement[] = []
  const files: Record<string, { id: string, [key: string]: unknown }> = {}
  const api = {
    updateScene(s: { elements?: BoardElement[] }) { if (s.elements) scene = [...s.elements] },
    getSceneElementsIncludingDeleted() { return scene },
    addFiles(fs: Array<{ id: string, [key: string]: unknown }>) { for (const f of fs) files[f.id] = f },
    getFiles() { return files },
  }
  const ctx = createBoardYContext()
  const binding = new ExcalidrawYBinding(ctx.ydoc, api)
  return { ctx, binding, fabric, sceneIds: () => scene.map((e) => e.id), scene: () => scene }
}

function el(id: string, extra: Record<string, unknown> = {}): BoardElement {
  return { id, version: 1, type: 'rectangle', ...extra }
}

/** Live element map of a peer's doc, for convergence equality. */
function docElements(ctx: BoardYContext): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  ctx.ydoc.getMap(ELEMENTS_KEY).forEach((v, k) => { out[k] = v })
  return out
}

describe('Whiteboard P2P — three peers converge (mesh, no central server)', () => {
  it('an edit from any peer reaches every other peer, and all converge', async () => {
    const fa = new FakeFabric(); const fb = new FakeFabric(); const fc = new FakeFabric()
    fa.connect(fb); fb.connect(fc); fa.connect(fc)

    const a = makePeer(fa)
    const { session: aSession, rwLink } = await YP2PCollabSession.create({
      peerId: 'a', fileId: 'wb1', baseUrl: INVITE, ctx: a.ctx, fabric: asFabric(fa),
    })
    a.session = aSession
    const b = makePeer(fb)
    b.session = await YP2PCollabSession.fromInvite({ inviteLink: rwLink, peerId: 'b', fileId: 'wb1', ctx: b.ctx, fabric: asFabric(fb) })
    const c = makePeer(fc)
    c.session = await YP2PCollabSession.fromInvite({ inviteLink: rwLink, peerId: 'c', fileId: 'wb1', ctx: c.ctx, fabric: asFabric(fc) })

    await a.session.join(); await b.session.join(); await c.session.join()
    await settle()

    // Each peer draws a distinct shape (a local edit through the real binding).
    a.binding.handleChange([el('shape-A', { index: 'a0' })], {}, {})
    await until(
      () => 'shape-A' in docElements(b.ctx) && 'shape-A' in docElements(c.ctx),
      "A's shape to reach B and C",
    )
    b.binding.handleChange([el('shape-A', { index: 'a0' }), el('shape-B', { index: 'a1' })], {}, {})
    await until(
      () => 'shape-B' in docElements(a.ctx) && 'shape-B' in docElements(c.ctx),
      "B's shape to reach A and C",
    )
    c.binding.handleChange([el('shape-A', { index: 'a0' }), el('shape-B', { index: 'a1' }), el('shape-C', { index: 'a2' })], {}, {})
    await until(
      () => sameEls(docElements(b.ctx), docElements(a.ctx))
        && sameEls(docElements(c.ctx), docElements(a.ctx))
        && 'shape-C' in docElements(a.ctx),
      'all three peers to converge on a board holding every shape',
    )

    // All three docs are identical and hold every peer's element.
    expect(docElements(b.ctx)).toEqual(docElements(a.ctx))
    expect(docElements(c.ctx)).toEqual(docElements(a.ctx))
    expect(Object.keys(docElements(a.ctx)).sort()).toEqual(['shape-A', 'shape-B', 'shape-C'])
    // …and every peer's EDITOR shows the elements it received REMOTELY (a peer's
    // OWN local edit is already live in its real Excalidraw and is not re-rendered
    // back into its scene by the binding — so peers A and B, which received C's
    // shape as a remote change, show the full merged scene).
    expect(a.sceneIds().sort()).toEqual(['shape-A', 'shape-B', 'shape-C'])
    expect(b.sceneIds().sort()).toEqual(['shape-A', 'shape-B', 'shape-C'])
  })
})

describe('Whiteboard P2P — late joiner catches up with no server', () => {
  it('a peer joining AFTER edits pulls the full scene via state-vector resync', async () => {
    const fa = new FakeFabric(); const fb = new FakeFabric()
    fa.connect(fb)

    const a = makePeer(fa)
    const { session: aSession, rwLink } = await YP2PCollabSession.create({
      peerId: 'a', fileId: 'wb1', baseUrl: INVITE, ctx: a.ctx, fabric: asFabric(fa),
    })
    a.session = aSession
    await a.session.join()

    // The owner draws a whole board BEFORE anyone else is in the room.
    a.binding.handleChange([el('r1', { index: 'a0' }), el('r2', { index: 'a1' })], {}, {})
    await settle()

    // A second peer joins late from an EMPTY doc and must recover the whole scene
    // purely from its peer — there is no server to bootstrap from.
    const b = makePeer(fb)
    b.session = await YP2PCollabSession.fromInvite({ inviteLink: rwLink, peerId: 'b', fileId: 'wb1', ctx: b.ctx, fabric: asFabric(fb) })
    expect(Object.keys(docElements(b.ctx))).toEqual([])

    await b.session.join()   // join() issues a state-vector resync request
    await until(
      () => sameEls(docElements(b.ctx), docElements(a.ctx)) && b.sceneIds().length === 2,
      'the late joiner to recover the full scene from its peer',
    )

    expect(docElements(b.ctx)).toEqual(docElements(a.ctx))
    expect(b.sceneIds().sort()).toEqual(['r1', 'r2'])
  })
})

describe('Whiteboard P2P — the wire is content-blind (E2E)', () => {
  it('a relay/eavesdropper who captures frames cannot recover the scene', async () => {
    const wire: string[] = []
    const fa = new FakeFabric(wire); const fb = new FakeFabric(wire)
    fa.connect(fb)

    const a = makePeer(fa)
    const { session: aSession, rwLink } = await YP2PCollabSession.create({
      peerId: 'a', fileId: 'wb1', baseUrl: INVITE, ctx: a.ctx, fabric: asFabric(fa),
    })
    a.session = aSession
    const b = makePeer(fb)
    b.session = await YP2PCollabSession.fromInvite({ inviteLink: rwLink, peerId: 'b', fileId: 'wb1', ctx: b.ctx, fabric: asFabric(fb) })
    await a.session.join(); await b.session.join()
    await settle()

    const SECRET = 'TOPSECRET-DIAGRAM-2026'
    a.binding.handleChange([el('note', { type: 'text', text: SECRET })], {}, {})
    await until(
      () => boardDocToScene(b.ctx.ydoc).elements.find((e) => e.id === 'note')?.text === SECRET,
      'the second peer to converge on the plaintext scene',
    )

    // The peers DID converge on the plaintext scene…
    expect(boardDocToScene(b.ctx.ydoc).elements.find((e) => e.id === 'note')?.text).toBe(SECRET)
    // …but the secret never appears anywhere on the wire (frames are sealed).
    expect(wire.length).toBeGreaterThan(0)
    for (const frame of wire) expect(String(frame)).not.toContain(SECRET)

    // Even an attacker who knows the (public, derived) roomId cannot open a frame
    // without the roomKey — the key lives only in the invite fragment.
    const wrongKey = await deriveRoomKeys(new Uint8Array(32).fill(7))
    const attackerRoom = { encKey: wrongKey.encKey, macKeyRw: null, roomId: wrongKey.roomId }
    let opened = false
    for (const frame of wire) {
      try { await openFrame(attackerRoom, frame); opened = true } catch { /* AEAD fail — expected */ }
    }
    expect(opened).toBe(false)

    const { roomId } = await parseInvite(rwLink)
    expect(roomId).toBeTruthy()
    expect(rwLink).toContain('#vp2p=')   // the key rides the fragment, never the path
  })
})

describe('Whiteboard P2P — concurrent edits to different elements merge', () => {
  it('two peers drawing different shapes offline both keep both shapes', async () => {
    const fa = new FakeFabric(); const fb = new FakeFabric()
    // Deliberately NOT connected while they draw (a partition).
    const a = makePeer(fa)
    const { session: aSession, rwLink } = await YP2PCollabSession.create({
      peerId: 'a', fileId: 'wb1', baseUrl: INVITE, ctx: a.ctx, fabric: asFabric(fa),
    })
    a.session = aSession
    const b = makePeer(fb)
    b.session = await YP2PCollabSession.fromInvite({ inviteLink: rwLink, peerId: 'b', fileId: 'wb1', ctx: b.ctx, fabric: asFabric(fb) })
    await a.session.join(); await b.session.join()

    a.binding.handleChange([el('a-rect', { index: 'a0' })], {}, {})
    b.binding.handleChange([el('b-oval', { index: 'a1', type: 'ellipse' })], {}, {})
    await settle()

    // Heal the partition — both sessions resync and the per-id Y.Map unions.
    fa.connect(fb)
    await a.session.resync(); await b.session.resync()
    await until(
      () => sameEls(docElements(a.ctx), docElements(b.ctx))
        && Object.keys(docElements(a.ctx)).length === 2,
      'the healed partition to union both peers\' shapes',
    )

    expect(docElements(a.ctx)).toEqual(docElements(b.ctx))
    expect(Object.keys(docElements(a.ctx)).sort()).toEqual(['a-rect', 'b-oval'])
  })
})
