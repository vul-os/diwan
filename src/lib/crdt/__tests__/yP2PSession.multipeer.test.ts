/**
 * YP2PCollabSession — multi-peer + late-joiner + wire-opacity.
 *
 * These pin the properties that make Office's collaboration genuinely
 * peer-to-peer and serverless — beyond the two-peer basics in
 * yP2PSession.test.js:
 *
 *   • THREE peers in one room all converge on the identical document (a mesh,
 *     not a hub — there is no central document server relaying between them).
 *   • A peer that JOINS LATE (after edits already happened) catches up to the
 *     full current document via the state-vector resync — no server bootstrap.
 *   • The document text is NEVER visible on the wire: a relay or uninvited peer
 *     that captures a frame holds only ciphertext and cannot recover the content
 *     even with the roomId. (The E2E property, asserted for the DOCUMENT path.)
 *   • Concurrent edits from different peers converge to a byte-identical doc.
 */

import { describe, it, expect, vi } from 'vitest'
import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { YP2PCollabSession, type SessionFabric } from '../yP2PSession.js'
import { YCollab } from '../../../apps/docs/collabExtension.js'
import { createYContext, Y, Y_FRAGMENT } from '../ydoc.js'
import { parseInvite, deriveRoomKeys, openFrame } from '../p2pRoom.js'
import type { YContext } from '../ydoc.js'

vi.setConfig({ testTimeout: 30_000 })

// A tiny in-process mesh fabric: every peer connected to it receives every
// frame any member broadcasts. `tap` records raw wire frames for the opacity
// assertion (this is exactly what a relay / passive eavesdropper would see).
//
// Not declared `implements SessionFabric`: it really does emit exactly the
// 'state'/'message' shape the interface describes (see yP2PSession.ts's own
// comment on the same point for FabricClient), but EventTarget's inherited
// addEventListener is typed generically, so callers cast at the call site
// instead — same as production does for the real FabricClient.
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
  disconnect() {
    for (const p of this.peers) p.peers.delete(this)
    this.peers.clear()
  }
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

const INVITE = 'https://office.test/docs/doc1'
// A fixed sleep, used ONLY where nothing specific is being awaited (session
// setup). Positive assertions poll with `until` instead: this suite mounts
// three real ProseMirror editors, and a fixed 60 ms was not reliably enough for
// an update to cross the fake fabric on a loaded machine — which produces a
// flake, not a finding. See the same change in yP2PSession.test.js.
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

/** Structural equality of two editor JSON docs. */
const sameDoc = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y)

// FakeFabric really does emit exactly the SessionFabric event shape (see the
// class comment above) — the cast is only needed because EventTarget's
// inherited addEventListener is typed generically, same as production's cast
// of the real FabricClient in yP2PSession.ts.
const asFabric = (f: FakeFabric): SessionFabric => f as unknown as SessionFabric

type Peer = {
  ydoc: InstanceType<typeof Y.Doc>
  ctx: YContext
  editor: Editor
  fabric: FakeFabric
  session?: YP2PCollabSession
}

function makePeer(fabric: FakeFabric): Peer {
  const ydoc = new Y.Doc()
  // schema is unknown until the editor below is constructed; assigned onto ctx
  // immediately after, before anything reads it — same as the runtime always did.
  const ctx: YContext = createYContext(null as unknown as YContext['schema'], ydoc)
  const element = document.createElement('div')
  document.body.appendChild(element)
  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({ history: false }),
      YCollab.configure({ fragment: ydoc.getXmlFragment(Y_FRAGMENT) }),
    ],
  })
  ctx.schema = editor.schema
  return { ydoc, ctx, editor, fabric }
}

function plainText(editor: Editor): string {
  return editor.getJSON().content!
    .map((n) => (n.content || []).map((t) => t.text || '').join(''))
    .join('\n')
}

describe('YP2PCollabSession — three peers converge (mesh, no central server)', () => {
  it('an edit from any peer reaches every other peer, and all converge', async () => {
    const fa = new FakeFabric()
    const fb = new FakeFabric()
    const fc = new FakeFabric()
    // Full mesh — each peer is directly connected to the others.
    fa.connect(fb); fb.connect(fc); fa.connect(fc)

    const a = makePeer(fa)
    const { session: aSession, rwLink } = await YP2PCollabSession.create({
      peerId: 'a', fileId: 'doc1', baseUrl: INVITE, ctx: a.ctx, fabric: asFabric(fa),
    })
    a.session = aSession

    const b = makePeer(fb)
    b.session = await YP2PCollabSession.fromInvite({
      inviteLink: rwLink, peerId: 'b', fileId: 'doc1', ctx: b.ctx, fabric: asFabric(fb),
    })
    const c = makePeer(fc)
    c.session = await YP2PCollabSession.fromInvite({
      inviteLink: rwLink, peerId: 'c', fileId: 'doc1', ctx: c.ctx, fabric: asFabric(fc),
    })

    await a.session.join(); await b.session.join(); await c.session.join()
    await settle()

    // Each peer contributes a distinct paragraph.
    a.editor.commands.setContent('<p>from-A</p>')
    await until(
      () => plainText(b.editor).includes('from-A') && plainText(c.editor).includes('from-A'),
      "A's edit to reach B and C",
    )
    b.editor.commands.insertContentAt(b.editor.state.doc.content.size - 1, ' from-B')
    await until(
      () => plainText(a.editor).includes('from-B') && plainText(c.editor).includes('from-B'),
      "B's edit to reach A and C",
    )
    c.editor.commands.insertContentAt(c.editor.state.doc.content.size - 1, ' from-C')
    await until(
      () => sameDoc(b.editor.getJSON(), a.editor.getJSON())
        && sameDoc(c.editor.getJSON(), a.editor.getJSON())
        && plainText(a.editor).includes('from-C'),
      'all three peers to converge on a document holding every edit',
    )

    // All three documents are byte-identical, and hold every peer's edit.
    expect(b.editor.getJSON()).toEqual(a.editor.getJSON())
    expect(c.editor.getJSON()).toEqual(a.editor.getJSON())
    const text = plainText(a.editor)
    expect(text).toContain('from-A')
    expect(text).toContain('from-B')
    expect(text).toContain('from-C')
  })
})

describe('YP2PCollabSession — late joiner catches up with no server', () => {
  it('a peer joining AFTER edits pulls the full document via state-vector resync', async () => {
    const fa = new FakeFabric()
    const fb = new FakeFabric()
    fa.connect(fb)

    const a = makePeer(fa)
    const { session: aSession, rwLink } = await YP2PCollabSession.create({
      peerId: 'a', fileId: 'doc1', baseUrl: INVITE, ctx: a.ctx, fabric: asFabric(fa),
    })
    a.session = aSession
    await a.session.join()

    // The owner writes a whole document BEFORE anyone else is in the room.
    a.editor.commands.setContent('<h2>Agenda</h2><p>item one</p><p>item two</p>')
    await settle()

    // Now a second peer joins late. It starts from an EMPTY doc and must recover
    // the entire current state purely from its peer — there is no server to
    // bootstrap from.
    const b = makePeer(fb)
    b.session = await YP2PCollabSession.fromInvite({
      inviteLink: rwLink, peerId: 'b', fileId: 'doc1', ctx: b.ctx, fabric: asFabric(fb),
    })
    expect(plainText(b.editor)).toBe('')

    await b.session.join()   // join() issues a state-vector resync request
    await until(
      () => sameDoc(b.editor.getJSON(), a.editor.getJSON()) && plainText(b.editor).includes('Agenda'),
      'the late joiner to recover the full document from its peer',
    )

    expect(b.editor.getJSON()).toEqual(a.editor.getJSON())
    expect(plainText(b.editor)).toContain('Agenda')
    expect(plainText(b.editor)).toContain('item two')
  })
})

describe('YP2PCollabSession — the wire is content-blind (E2E)', () => {
  it('a relay/eavesdropper who captures frames cannot recover the document text', async () => {
    const wire: string[] = []     // everything that crossed the "relay"
    const fa = new FakeFabric(wire)
    const fb = new FakeFabric(wire)
    fa.connect(fb)

    const a = makePeer(fa)
    const { session: aSession, rwLink } = await YP2PCollabSession.create({
      peerId: 'a', fileId: 'doc1', baseUrl: INVITE, ctx: a.ctx, fabric: asFabric(fa),
    })
    a.session = aSession
    const b = makePeer(fb)
    b.session = await YP2PCollabSession.fromInvite({
      inviteLink: rwLink, peerId: 'b', fileId: 'doc1', ctx: b.ctx, fabric: asFabric(fb),
    })
    await a.session.join(); await b.session.join()
    await settle()

    const SECRET = 'TOPSECRET-MERGER-2026'
    a.editor.commands.setContent(`<p>${SECRET}</p>`)
    await until(
      () => plainText(b.editor).includes(SECRET),
      'the second peer to converge on the plaintext',
    )

    // The peers DID converge on the plaintext…
    expect(plainText(b.editor)).toContain(SECRET)
    // …but the secret never appears anywhere on the wire (frames are sealed).
    expect(wire.length).toBeGreaterThan(0)
    for (const frame of wire) {
      expect(String(frame)).not.toContain(SECRET)
    }

    // Even an attacker who knows the (public, derived) roomId cannot open a
    // frame without the roomKey — the roomKey lives only in the invite fragment,
    // which never crosses the wire. Deriving a DIFFERENT key and trying to open a
    // captured frame fails closed.
    const wrongKey = await deriveRoomKeys(new Uint8Array(32).fill(7))
    const attackerRoom = { encKey: wrongKey.encKey, macKeyRw: null, roomId: wrongKey.roomId }
    let opened = false
    for (const frame of wire) {
      try { await openFrame(attackerRoom, frame); opened = true } catch { /* AEAD fail — expected */ }
    }
    expect(opened).toBe(false)

    // Sanity: the roomKey is NOT recoverable from the roomId — parseInvite needs
    // the fragment, and the roomId alone (what a relay sees) admits nothing.
    const { roomId } = await parseInvite(rwLink)
    expect(roomId).toBeTruthy()
    expect(rwLink).toContain('#vp2p=')   // the key rides the fragment, never the path
  })
})
