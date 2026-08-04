/**
 * YP2PCollabSession — the structure-aware document over the E2E-encrypted P2P
 * room (invite links).
 *
 * The crypto/capability properties themselves (sealed frames, roomId derivation,
 * ro peers holding no RW-MAC) are covered in p2pRoom.test.js. What is pinned here
 * is that the DOCUMENT rides that room correctly:
 *   • a peer's formatting/structure reaches the other peer;
 *   • two peers converge (including after an offline period);
 *   • a read-only peer cannot write into the shared document;
 *   • a hostile peer inside the room cannot inject unrenderable content.
 */

import { describe, it, expect, vi } from 'vitest'
import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Table from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import { YP2PCollabSession, type SessionFabric } from '../yP2PSession.js'
import { YCollab } from '../../../apps/docs/collabExtension.js'
import { createYContext, Y, Y_FRAGMENT, bytesToB64 } from '../ydoc.js'
import { parseInvite, deriveRoomKeys, openFrame } from '../p2pRoom.js'
import type { YContext } from '../ydoc.js'
import type { BoardYContext } from '../boardYdoc.js'

vi.setConfig({ testTimeout: 30_000 })

// ── A tiny in-process fabric: broadcasts every frame to the other peers. ────
class FakeFabric extends EventTarget {
  peers: Set<FakeFabric>
  id: string
  constructor() { super(); this.peers = new Set(); this.id = Math.random().toString(36).slice(2) }
  connect(other: FakeFabric) { this.peers.add(other); other.peers.add(this) }
  async join() {}
  leave() {}
  send(frame: string) {
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

// `_broadcast` is a private implementation detail of YP2PCollabSession; this
// suite needs to forge a raw wire frame directly (the hostile-peer test), so it
// reaches past the TS-only privacy the same way production casts a structurally
// compatible transport elsewhere in this file.
type Broadcaster = {
  _broadcast(msg: unknown, opts?: { authoritative?: boolean }): Promise<void>
}
const asBroadcaster = (s: YP2PCollabSession): Broadcaster => s as unknown as Broadcaster

const INVITE = 'https://office.test/docs/doc1'

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
      Table.configure({ resizable: true }), TableRow, TableCell, TableHeader,
      YCollab.configure({ fragment: ydoc.getXmlFragment(Y_FRAGMENT) }),
    ],
  })
  ctx.schema = editor.schema
  return { ydoc, ctx, editor, fabric }
}

// `settle` is a fixed sleep and is used ONLY for negative assertions — "give
// the thing that must not happen a chance to happen, then check it didn't".
// A fixed sleep is the wrong tool for a positive assertion: this suite mounts
// two real ProseMirror editors per test, and on a loaded machine 60 ms was not
// always enough for an update to cross the fake fabric. That made
// "a READ-ONLY peer cannot write" fail intermittently in the full run and pass
// in isolation — a flake, not a finding. Positive assertions now poll.
const settle = () => new Promise((r) => setTimeout(r, 60))

/**
 * Poll `ok()` until it returns true, then resolve. Fails with `label` in the
 * message if it never does — so a genuine regression still fails, and only the
 * timing slack is removed.
 */
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
const sameDoc = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Owner (rw) + a peer joining from one of the minted links. */
async function room({ joinWith = 'rw' }: { joinWith?: 'rw' | 'ro' } = {}): Promise<{ owner: Peer, guest: Peer }> {
  const fa = new FakeFabric()
  const fb = new FakeFabric()
  fa.connect(fb)

  const owner = makePeer(fa)
  const { session: ownerSession, rwLink, roLink } = await YP2PCollabSession.create({
    peerId: 'owner', fileId: 'doc1', baseUrl: INVITE, ctx: owner.ctx, fabric: asFabric(fa),
  })
  owner.session = ownerSession

  const guest = makePeer(fb)
  guest.session = await YP2PCollabSession.fromInvite({
    inviteLink: joinWith === 'ro' ? roLink : rwLink,
    peerId: 'guest', fileId: 'doc1', ctx: guest.ctx, fabric: asFabric(fb),
  })

  await owner.session.join()
  await guest.session.join()
  await settle()
  return { owner, guest }
}

describe('YP2PCollabSession — the document over an E2E-encrypted room', () => {
  it('carries formatting and structure to the other peer', async () => {
    const { owner, guest } = await room()

    owner.editor.commands.setContent(
      '<h2>Heading</h2><p><strong>bold</strong> text</p>' +
      '<table><tbody><tr><td><p>cell</p></td></tr></tbody></table>',
    )
    await until(
      () => sameDoc(guest.editor.getJSON(), owner.editor.getJSON())
        && guest.editor.getJSON().content?.[0]?.type === 'heading',
      'the guest to receive the owner\'s heading/table document',
    )

    const doc = guest.editor.getJSON()
    expect(doc.content![0].type).toBe('heading')
    expect(doc.content![1].content![0].marks?.some((m) => m.type === 'bold')).toBe(true)
    expect(doc.content!.find((n) => n.type === 'table')).toBeTruthy()
    expect(doc).toEqual(owner.editor.getJSON())
  })

  it('converges after both peers edit while disconnected (union, no lost work)', async () => {
    const { owner, guest } = await room()
    owner.editor.commands.setContent('<p>alpha</p><p>omega</p>')
    await until(
      () => sameDoc(guest.editor.getJSON(), owner.editor.getJSON())
        && guest.editor.getText().includes('alpha'),
      'both peers to share the pre-disconnect document',
    )

    // Cut the wire and let both sides edit. `owner.fabric`/`guest.fabric` are the
    // FakeFabric instances themselves (session.fabric is typed to the narrower
    // SessionFabric interface, which does not expose `.peers`).
    const savedOwnerPeers = new Set(owner.fabric.peers)
    owner.fabric.peers.clear()
    guest.fabric.peers.clear()

    owner.editor.commands.insertContentAt(6, ' ONE')
    guest.editor.commands.insertContentAt(
      guest.editor.state.doc.content.size - 1, ' TWO',
    )
    await settle()
    expect(owner.editor.getJSON()).not.toEqual(guest.editor.getJSON())

    // Reconnect + resync: the state-vector exchange fetches exactly what each
    // side is missing. Neither peer's offline work may be dropped.
    for (const p of savedOwnerPeers) { owner.fabric.peers.add(p); p.peers.add(owner.fabric) }
    await owner.session!.resync()
    await guest.session!.resync()
    await until(
      () => sameDoc(owner.editor.getJSON(), guest.editor.getJSON()),
      'the two peers to converge after reconnecting and resyncing',
    )

    expect(owner.editor.getJSON()).toEqual(guest.editor.getJSON())
    const text = owner.editor.getJSON().content!.map(
      (p) => (p.content || []).map((t) => t.text).join(''),
    )
    expect(text[0]).toContain('ONE')
    expect(text[1]).toContain('TWO')
  })

  it('a READ-ONLY peer cannot write into the shared document', async () => {
    const { owner, guest } = await room({ joinWith: 'ro' })
    expect(guest.session!.readOnly).toBe(true)

    owner.editor.commands.setContent('<p>owner text</p>')
    await until(
      () => guest.editor.getText().includes('owner text'),
      'the read-only peer to receive the owner\'s text',
    )
    // The ro peer RECEIVES the document (it can read live edits) …
    expect(guest.editor.getJSON()).toEqual(owner.editor.getJSON())

    // … but its own edits never reach the rw peer: it holds no RW-MAC key, so its
    // frames are not authoritative and the rw peer refuses them.
    guest.editor.commands.insertContentAt(1, 'VANDAL ')
    await settle()

    const ownerText = owner.editor.getJSON().content![0].content!.map((n) => n.text).join('')
    expect(ownerText).toBe('owner text')
    expect(ownerText).not.toContain('VANDAL')
  })

  it('a hostile peer in the room cannot inject an unrenderable document', async () => {
    const { owner, guest } = await room()
    owner.editor.commands.setContent('<p>safe</p>')
    await until(
      () => guest.editor.getText().includes('safe'),
      'the guest to receive the baseline document before it attacks',
    )
    const before = owner.editor.getJSON()

    // The guest is rw (it holds the key — an invite link can be forwarded to
    // anyone), and crafts a Y update carrying a node type the schema has no idea
    // about. y-prosemirror would throw building the view; the ingress clamp must
    // drop it first.
    const evil = new Y.Doc()
    const frag = evil.getXmlFragment(Y_FRAGMENT)
    const el = new Y.XmlElement('evilNode')
    el.insert(0, [new Y.XmlText('boom')])
    frag.insert(0, [el])
    await asBroadcaster(guest.session!)._broadcast(
      { type: 'yu', u: bytesToB64(Y.encodeStateAsUpdate(evil)) },
      { authoritative: true },
    )
    await until(
      () => owner.session!.rejectedUpdates > 0,
      'the ingress clamp to reject the malformed update',
    )

    expect(owner.session!.rejectedUpdates).toBeGreaterThan(0)
    expect(owner.editor.getJSON()).toEqual(before)
    // The editor survived and still works.
    owner.editor.commands.insertContentAt(1, 'ok ')
    expect(owner.editor.getJSON().content![0].content![0].text).toContain('ok')
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('resync on peer reachability (regression: the real-transport gap)', () => {
  // WHY THIS EXISTS. join() fires its state-vector request immediately, but with
  // a REAL transport no peer is connected yet — a WebRTC data channel takes
  // seconds of ICE, and FabricClient silently drops anything addressed to a peer
  // that is still 'connecting'. The join-time request therefore reached nobody
  // and nothing re-sent it, so two peers that opened a room and sat idle never
  // converged and a late joiner never received the document at all. The e2e-p2p
  // suite caught it; a fake fabric never could, because it is "connected" the
  // instant it is constructed. What is pinned here is the fix: becoming
  // reachable triggers a state-vector request ADDRESSED TO THAT PEER.
  class SilentFabric extends EventTarget {
    sent: string[]
    unicast: Array<{ peerId: string, frame: string }>
    constructor() { super(); this.sent = []; this.unicast = [] }
    async join() {}
    leave() {}
    send(frame: string) { this.sent.push(frame) }
    sendTo(peerId: string, frame: string) { this.unicast.push({ peerId, frame }) }
    /** Simulate the fabric reporting a peer transition. */
    reportState(peerId: string, state: string) {
      this.dispatchEvent(new CustomEvent('state', { detail: { peerId, state } }))
    }
  }
  const asSilentFabric = (f: SilentFabric): SessionFabric => f as unknown as SessionFabric

  const mkSession = async (fabric: SilentFabric): Promise<YP2PCollabSession> => {
    const ydoc = new Y.Doc()
    const base = createYContext(null as unknown as YContext['schema'], ydoc)
    // A context needs a fail-closed validator for untrusted peer updates; this
    // suite is about the resync trigger, not ingress, so accept-all is fine.
    const ctx: BoardYContext = { ydoc: base.ydoc, shadow: base.shadow, applyUpdate: () => ({ applied: true }) }
    const { session } = await YP2PCollabSession.create({
      peerId: 'owner', fileId: 'doc1', baseUrl: INVITE, ctx, fabric: asSilentFabric(fabric),
    })
    return session
  }

  it('sends a state-vector request to a peer that becomes directly connected', async () => {
    const fabric = new SilentFabric()
    await mkSession(fabric)
    fabric.reportState('peer-1', 'connected')
    await until(
      () => fabric.unicast.some((u) => u.peerId === 'peer-1'),
      'a state-vector request addressed to the newly connected peer',
    )
    expect(fabric.unicast.map((u) => u.peerId)).toContain('peer-1')
  })

  it('also does so for a peer reachable only over the relay circuit', async () => {
    const fabric = new SilentFabric()
    await mkSession(fabric)
    fabric.reportState('peer-2', 'relay')
    await until(
      () => fabric.unicast.some((u) => u.peerId === 'peer-2'),
      'a state-vector request addressed to the relay-reachable peer',
    )
    expect(fabric.unicast.map((u) => u.peerId)).toContain('peer-2')
  })

  it('does not chase a peer that is merely connecting or gone', async () => {
    const fabric = new SilentFabric()
    await mkSession(fabric)
    fabric.reportState('peer-3', 'connecting')
    fabric.reportState('peer-4', 'disconnected')
    await settle()
    expect(fabric.unicast).toHaveLength(0)
  })
})
