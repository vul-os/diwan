/**
 * liveCursorsBroadcast.test.tsx — WAVE-27 cursor/selection broadcast + throttle.
 *
 * Sheets and Slides broadcast cell/slide selection through the first-party
 * `useLiveCursors` hook (the same one Docs uses). This exercises that hook with
 * a fake fabric to prove:
 *   - the leading edge fires immediately (send on first call),
 *   - rapid follow-up calls are throttled (coalesced) to ~80ms,
 *   - sheet cursors serialise as "r,c" and slide cursors carry slideId,
 *   - remote peers' cursors project into the remoteCursors map (peers in/out).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useLiveCursors } from '../webrtc/useLiveCursors.js'
import type { FabricLike, LocalIdentity, CursorPayload } from '../webrtc/useLiveCursors.js'

// FakeFabric is a DOM EventTarget — structurally the same shape as FabricLike,
// but TS's class-implements check doesn't reconcile EventTarget's generic
// addEventListener overload with FabricLike's narrowed 'message'-only one. Cast
// at the call site (mirrors the `asBroadcaster`-style casts used for the CRDT
// session's own transport fakes) rather than fighting the DOM lib types.
class FakeFabric extends EventTarget {
  sent: string[] = []
  send(frame: string) { this.sent.push(frame) }
  emitMessage(payload: unknown) {
    this.dispatchEvent(new CustomEvent('message', { detail: { data: JSON.stringify(payload) } }))
  }
}
const asFabric = (f: FakeFabric): FabricLike => f as unknown as FabricLike

const ME: LocalIdentity = { accountId: 'me', displayName: 'Me' }

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

// The wire shape useLiveCursors.js's own comment documents: { channel, payload }.
type CursorFrame = { channel: string; payload: CursorPayload }

function parseSent(fabric: FakeFabric): CursorFrame[] {
  return fabric.sent.map((f) => JSON.parse(f) as CursorFrame)
}

describe('useLiveCursors — sheet cursor broadcast', () => {
  it('sends immediately on the first call, then throttles bursts', () => {
    const fabric = new FakeFabric()
    const { result } = renderHook(() =>
      useLiveCursors({ fabric: asFabric(fabric), localIdentity: ME, color: '#123456' }),
    )

    // Leading edge: first broadcast goes out synchronously.
    act(() => { result.current.broadcastSheetCursor(2, 5) })
    expect(fabric.sent.length).toBe(1)

    // Two more within the throttle window are coalesced into ONE trailing send.
    act(() => { result.current.broadcastSheetCursor(3, 5) })
    act(() => { result.current.broadcastSheetCursor(4, 5) })
    expect(fabric.sent.length).toBe(1) // still just the leading send

    act(() => { vi.advanceTimersByTime(80) })
    expect(fabric.sent.length).toBe(2) // one coalesced trailing send

    const frames = parseSent(fabric)
    expect(frames[0].channel).toBe('cursors')
    expect(frames[0].payload.type).toBe('sheet')
    expect(frames[0].payload.from).toBe('2,5')
    // Trailing send carries the LAST position in the burst.
    expect(frames[1].payload.from).toBe('4,5')
  })
})

describe('useLiveCursors — slide cursor broadcast', () => {
  it('carries the slideId and type=slide', () => {
    const fabric = new FakeFabric()
    const { result } = renderHook(() =>
      useLiveCursors({ fabric: asFabric(fabric), localIdentity: ME, color: '#abc' }),
    )
    act(() => { result.current.broadcastSlideCursor('slide-7') })
    const [frame] = parseSent(fabric)
    expect(frame.payload.type).toBe('slide')
    expect(frame.payload.slideId).toBe('slide-7')
  })
})

describe('useLiveCursors — remote roster projection', () => {
  it('adds a remote peer cursor and ignores our own echo', () => {
    const fabric = new FakeFabric()
    const { result } = renderHook(() =>
      useLiveCursors({ fabric: asFabric(fabric), localIdentity: ME, color: '#000' }),
    )

    act(() => {
      fabric.emitMessage({
        channel: 'cursors',
        payload: { accountId: 'peerA', displayName: 'A', type: 'sheet', from: '1,1', to: '1,1' },
      })
    })
    expect(result.current.remoteCursors.get('peerA')?.from).toBe('1,1')

    // Our own accountId echoes are dropped (no self-cursor).
    act(() => {
      fabric.emitMessage({
        channel: 'cursors',
        payload: { accountId: 'me', type: 'sheet', from: '9,9' },
      })
    })
    expect(result.current.remoteCursors.has('me')).toBe(false)
  })

  it('ignores frames on other channels', () => {
    const fabric = new FakeFabric()
    const { result } = renderHook(() =>
      useLiveCursors({ fabric: asFabric(fabric), localIdentity: ME, color: '#000' }),
    )
    act(() => {
      fabric.emitMessage({ channel: 'grid_op', payload: { accountId: 'x' } })
    })
    expect(result.current.remoteCursors.size).toBe(0)
  })
})
