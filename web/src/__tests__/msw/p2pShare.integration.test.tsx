/**
 * Integration — WAVE-25 P2P "Collaborate via link" flow.
 *
 * Ties the SHARER UI (P2PShareModal) to the real invite-link machinery and the
 * real E2E-encrypted session, end to end:
 *
 *   1. P2PShareModal renders the rw + ro links minted by generateInvite().
 *   2. hasInviteInLocation() recognises an invite fragment (the join trigger).
 *   3. Parsing an rw invite link joins a room; parsing the ro link joins the
 *      SAME room read-only.
 *   4. Two in-process sessions (rw + ro) built from the modal's links converge,
 *      a ro peer's ops are REJECTED, and the wire frames are opaque (the relay
 *      can never read the plaintext).
 *
 * This is deliberately layered on top of the modal + link format so a change to
 * the link scheme or the modal contract is caught here, not just in the lower
 * yP2PSession unit tests.
 *
 * (4) used to build `P2PCollabSession` — the hand-rolled text-RGA session, which
 * was deleted along with `crdt/text.js`. It was never what Docs constructed:
 * `useP2PCollab` has built `YP2PCollabSession` since the plain-text sync path
 * was retired, so the end-to-end claim this file makes was being proved against
 * a class no user ever ran. It now drives the LIVE session, which is the only
 * version of this test that means anything.
 */

import type { FC } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import P2PShareModalUntyped from '../../apps/docs/components/P2PShareModal.jsx'
import { hasInviteInLocation } from '../../apps/docs/useP2PCollab.js'
import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { YP2PCollabSession, type SessionFabric } from '../../lib/crdt/yP2PSession.js'
import { YCollab } from '../../apps/docs/collabExtension.js'
import { createYContext, Y, Y_FRAGMENT, type YContext } from '../../lib/crdt/ydoc.js'
import { generateInvite, parseInvite, CAP_RW, CAP_RO } from '../../lib/crdt/p2pRoom.js'

// P2PShareModal.jsx lives on a sibling ts-migration lane (src/apps/docs) and is
// intentionally left untouched here (still plain JS); its inferred prop type
// makes every destructured prop required (no defaults for onRotate/roomId), so
// this file's "no links yet" case (which real callers reach before onRotate/
// roomId are known) is typed against the narrower slice this file exercises.
const P2PShareModal = P2PShareModalUntyped as unknown as FC<{
  open: boolean
  onClose: () => void
  links: { rwLink: string; roLink: string } | null
  roomId?: string
  onRotate?: () => void
}>

// ── In-process, content-blind transport (mirrors the real FabricClient API) ──
// Not declared `implements SessionFabric`: it really does emit exactly the
// 'state'/'message' shape the interface describes, but EventTarget's inherited
// addEventListener is typed generically, so callers cast at the call site
// instead — same as yP2PSession.ts's own __tests__ (yP2PSession.test.ts) do
// for their FakeFabric, and the same as production casts the real FabricClient.
class FakeBus {
  nodes: Set<FakeFabric>
  constructor() { this.nodes = new Set() }
  register(n: FakeFabric) { this.nodes.add(n) }
  unregister(n: FakeFabric) { this.nodes.delete(n) }
  broadcast(from: string, frame: string) { for (const n of this.nodes) if (n.peerId !== from && n.online) n.deliver(from, frame) }
  unicast(from: string, to: string, frame: string) { for (const n of this.nodes) if (n.peerId === to && n.online) n.deliver(from, frame) }
}
class FakeFabric extends EventTarget {
  bus: FakeBus
  peerId: string
  online: boolean
  sent: string[]
  constructor(bus: FakeBus, peerId: string) { super(); this.bus = bus; this.peerId = peerId; this.online = false; this.sent = [] }
  async join() {
    this.online = true; this.bus.register(this)
    for (const n of this.bus.nodes) if (n !== this)
      this.dispatchEvent(new CustomEvent('state', { detail: { peerId: n.peerId, state: 'connected' } }))
  }
  send(frame: string) { this.sent.push(frame); if (this.online) this.bus.broadcast(this.peerId, frame) }
  sendTo(to: string, frame: string) { if (this.online) this.bus.unicast(this.peerId, to, frame) }
  leave() { this.online = false; this.bus.unregister(this) }
  deliver(from: string, frame: string) { this.dispatchEvent(new CustomEvent('message', { detail: { from, data: frame } })) }
}
const asFabric = (f: FakeFabric): SessionFabric => f as unknown as SessionFabric
const settle = () => new Promise((r) => setTimeout(r, 20))

// Poll a predicate until it holds, instead of sleeping a fixed amount and hoping
// the async encrypt→broadcast→decrypt chain finished. A fixed `settle(20)` is a
// latent flake: convergence here goes through SubtleCrypto (seal/open) which can
// exceed 20ms when the full parallel suite saturates the CPU. Polling awaits the
// REAL condition and is robust under load while staying fast in the common case.
async function until(predicate: (opts?: { assert?: boolean }) => unknown, { timeoutMs = 2000, stepMs = 5 } = {}): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - start > timeoutMs) {
      // Final attempt: throw the underlying assertion for a useful message.
      predicate({ assert: true })
      throw new Error('until(): predicate never became true')
    }
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

describe('P2PShareModal (sharer UI)', () => {
  it('shows both an editor (rw) and view-only (ro) invite link', async () => {
    const rw = await generateInvite({ cap: CAP_RW, baseUrl: 'https://ex.test/docs/x' })
    const ro = await generateInvite({ cap: CAP_RO, baseUrl: 'https://ex.test/docs/x', roomKey: rw.roomKey })

    render(
      <P2PShareModal
        open
        onClose={() => {}}
        links={{ rwLink: rw.link, roLink: ro.link }}
        roomId="abc123def456"
        onRotate={() => {}}
      />,
    )
    expect(screen.getByText('Editor link')).toBeInTheDocument()
    expect(screen.getByText('View-only link')).toBeInTheDocument()
    // Both links are present in read-only inputs and carry the invite fragment.
    const inputs = screen.getAllByDisplayValue(/#vp2p=/)
    expect(inputs).toHaveLength(2)
    // The E2E-encryption promise is surfaced to the user honestly.
    expect(screen.getByText(/end-to-end encrypted/i)).toBeInTheDocument()
  })

  it('shows a "Preparing room…" state before links exist', () => {
    render(<P2PShareModal open onClose={() => {}} links={null} />)
    expect(screen.getByText(/Preparing room/i)).toBeInTheDocument()
  })
})

describe('invite-fragment detection', () => {
  const orig = window.location.hash
  afterEach(() => { window.location.hash = orig })

  it('hasInviteInLocation() is true only when a #vp2p= fragment is present', () => {
    window.location.hash = ''
    expect(hasInviteInLocation()).toBe(false)
    window.location.hash = '#vp2p=abc.def'
    expect(hasInviteInLocation()).toBe(true)
  })
})

describe('invite links parse to the correct capability + same room', () => {
  it('rw link parses cap=rw, ro link parses cap=ro, both share one roomId', async () => {
    const rw = await generateInvite({ cap: CAP_RW })
    const ro = await generateInvite({ cap: CAP_RO, roomKey: rw.roomKey })

    const prw = await parseInvite(rw.link)
    const pro = await parseInvite(ro.link)
    expect(prw.cap).toBe(CAP_RW)
    expect(pro.cap).toBe(CAP_RO)
    // Same underlying room key ⇒ same derived roomId ⇒ they meet in one room.
    expect(prw.roomId).toBe(pro.roomId)
  })
})

type Peer = { ydoc: InstanceType<typeof Y.Doc>; ctx: YContext; editor: Editor; fabric: FakeFabric }

/** A peer: a Yjs doc, a real ProseMirror schema, and its own fabric endpoint. */
function makePeer(bus: FakeBus, peerId: string): Peer {
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
  return { ydoc, ctx, editor, fabric: new FakeFabric(bus, peerId) }
}

describe('two sessions from the modal links converge; ro is rejected + sealed', () => {
  it('rw+ro peers converge, ro ops rejected, wire frames opaque', async () => {
    const bus = new FakeBus()
    // The exact links the modal would show for a freshly-created room.
    const rw = await generateInvite({ cap: CAP_RW })
    const ro = await generateInvite({ cap: CAP_RO, roomKey: rw.roomKey })

    const ed = makePeer(bus, 'EDIT')
    const vw = makePeer(bus, 'VIEW')

    const editor = await YP2PCollabSession.fromInvite({
      inviteLink: rw.link, peerId: 'EDIT', fileId: 'd1', ctx: ed.ctx, fabric: asFabric(ed.fabric),
    })
    const viewer = await YP2PCollabSession.fromInvite({
      inviteLink: ro.link, peerId: 'VIEW', fileId: 'd1', ctx: vw.ctx, fabric: asFabric(vw.fabric),
    })
    // Same room key ⇒ the two links meet in one room, which is the whole point
    // of the modal handing out a pair.
    expect(editor.roomId).toBe(viewer.roomId)

    await editor.join(); await viewer.join()

    // Editor writes → viewer converges (a ro peer READS live edits).
    ed.editor.commands.setContent('<p>secret-plan</p>')
    await until(() => vw.editor.getText().includes('secret-plan'))
    expect(vw.editor.getText()).toContain('secret-plan')
    expect(viewer.readOnly).toBe(true)

    // ro peer's write never reaches the editor: it emits no authoritative frame,
    // and could not forge the RW MAC if it tried.
    const sentBefore = vw.fabric.sent.length
    vw.editor.commands.setContent('<p>secret-plan!!!</p>')
    await settle()
    expect(vw.fabric.sent.length).toBe(sentBefore)
    expect(ed.editor.getText()).toContain('secret-plan')
    expect(ed.editor.getText()).not.toContain('!!!')

    // Crypto seal: the relay/transport only ever saw ciphertext frames — none
    // may contain the plaintext.
    expect(ed.fabric.sent.length).toBeGreaterThan(0)
    for (const frame of ed.fabric.sent) {
      expect(frame).not.toContain('secret-plan')
    }

    editor.leave(); viewer.leave()
    ed.editor.destroy(); vw.editor.destroy()
  })
})
