/**
 * useCollabFabric.test.tsx — WAVE-27 fabric lifecycle hook.
 *
 * Verifies the presence-roster-adjacent projection: peers joining/leaving flow
 * into the `peers` map, join success flips `joined`, and a join rejection
 * degrades gracefully (no throw, configured→false) so solo editing survives.
 *
 * The real FabricClient opens WebSockets/WebRTC; we mock the module with a tiny
 * in-process EventTarget so the hook logic is exercised without the network.
 *
 * The hook also probes `/api/peering/ice` (peeringAvailability.js) BEFORE
 * constructing a FabricClient at all, so every test here stubs global fetch to
 * resolve `ok: true` (peering reachable) unless it is specifically exercising
 * the unavailable path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { _resetPeeringProbeCache } from '../peeringAvailability.js'
import { _resetReachableBaseCache } from '../reachableBase.js'

// ── Mock the first-party WebRTC fabric with a controllable fake ───────────────

// The fake's construction options — a loose subset of FabricClient's real
// ConstructorParameters (fabric.ts), documented here only as far as these
// tests read them back off `lastFabric.opts`.
interface FakeFabricOpts {
  sessionId?: string
  peerId?: string
  signalingUrl?: string
  rendezvousBaseUrl?: string
  rendezvousPrefix?: string
  [key: string]: unknown
}

let lastFabric: FakeFabric | null = null
let joinBehaviour: 'resolve' | 'reject' = 'resolve' // 'resolve' | 'reject'

class FakeFabric extends EventTarget {
  opts: FakeFabricOpts
  left = false
  constructor(opts: FakeFabricOpts) {
    super()
    this.opts = opts
    lastFabric = this
  }
  async join(): Promise<void> {
    if (joinBehaviour === 'reject') throw new Error('no peering backend')
  }
  leave() { this.left = true }
  send() {}
  sendTo() {}
  // Test helper: simulate the fabric emitting a peer state change.
  emitState(peerId: string, state: string) {
    this.dispatchEvent(new CustomEvent('state', { detail: { peerId, state } }))
  }
}

vi.mock('../webrtc/fabric.js', () => ({
  FabricClient: class {
    constructor(opts: FakeFabricOpts) { return new FakeFabric(opts) }
  },
}))

// Import AFTER the mock is registered.
const { useCollabFabric } = await import('../useCollabFabric.js')

beforeEach(() => {
  lastFabric = null
  joinBehaviour = 'resolve'
  _resetPeeringProbeCache()
  _resetReachableBaseCache()
  // Default: the peering fabric IS reachable (hosted mode) — individual tests
  // override this to exercise the standalone/unreachable path.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useCollabFabric', () => {
  it('creates + joins a fabric and marks configured/joined', async () => {
    const { result } = renderHook(() =>
      useCollabFabric({ sessionId: 'file-1', peerId: 'rep-1' }),
    )
    // Fabric created synchronously in the effect.
    await waitFor(() => expect(result.current.fabric).not.toBeNull())
    expect(result.current.configured).toBe(true)
    await waitFor(() => expect(result.current.joined).toBe(true))
    // Signaling URL derives from origin, mirroring Docs' collab session.
    expect(lastFabric?.opts.sessionId).toBe('file-1')
    expect(lastFabric?.opts.peerId).toBe('rep-1')
    expect(lastFabric?.opts.signalingUrl).toMatch(/\/api\/peering\/stream$/)
  })

  it('projects peers joining and leaving into the peers map', async () => {
    const { result } = renderHook(() =>
      useCollabFabric({ sessionId: 'f', peerId: 'me' }),
    )
    await waitFor(() => expect(result.current.fabric).not.toBeNull())

    act(() => { lastFabric?.emitState('peerA', 'connected') })
    await waitFor(() => expect(result.current.peers.peerA).toBe('connected'))

    act(() => { lastFabric?.emitState('peerB', 'relay') })
    await waitFor(() => expect(result.current.peers.peerB).toBe('relay'))

    // Peer drops: state transitions to disconnected (out).
    act(() => { lastFabric?.emitState('peerA', 'disconnected') })
    await waitFor(() => expect(result.current.peers.peerA).toBe('disconnected'))
    expect(result.current.peers.peerB).toBe('relay')
  })

  it('degrades gracefully when join rejects (single-user / no backend)', async () => {
    joinBehaviour = 'reject'
    const { result } = renderHook(() =>
      useCollabFabric({ sessionId: 'f', peerId: 'me' }),
    )
    await waitFor(() => expect(result.current.fabric).not.toBeNull())
    // join() rejected → joined stays false, configured collapses to false.
    await waitFor(() => expect(result.current.configured).toBe(false))
    expect(result.current.joined).toBe(false)
    // No throw escaped — the hook still returned a value; editor keeps working.
  })

  it('never constructs a fabric when neither host-box peering nor a rendezvous URL is available (standalone server)', async () => {
    _resetPeeringProbeCache()
    _resetReachableBaseCache()
    // Both /api/peering/ice (probeHostPeering) and /api/reachability
    // (resolveRendezvousUrl) 404 — a bare standalone server with no rendezvous
    // configured either.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }))
    const { result } = renderHook(() =>
      useCollabFabric({ sessionId: 'f', peerId: 'me' }),
    )
    // Give the probe's microtask a tick to resolve.
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(result.current.fabric).toBeNull()
    expect(result.current.configured).toBe(false)
    expect(result.current.joined).toBe(false)
    // The whole point: FabricClient is never even constructed, so there is no
    // false-positive "Live" pill possible for a session nobody can reach.
    expect(lastFabric).toBeNull()
  })

  it('THE PAYOFF — builds a rendezvous-native fabric when host-box peering is absent but a rendezvous URL is configured', async () => {
    _resetPeeringProbeCache()
    _resetReachableBaseCache()
    // /api/peering/ice 404s (standalone: no host-box peering) but
    // /api/reachability reports a configured rendezvous_url — the deployment
    // pointed Diwan at a self-hosted relayd with no Vulos OS involved at all.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/api/reachability')) {
        return {
          ok: true,
          json: async () => ({ rendezvous_url: 'https://relay.example.org' }),
        }
      }
      return { ok: false, status: 404 }
    }))

    const { result } = renderHook(() =>
      useCollabFabric({ sessionId: 'file-rv', peerId: 'rep-rv' }),
    )

    // A fabric IS constructed — this is the payoff: standalone + rendezvous
    // configured gets a REAL transport, not local-only.
    await waitFor(() => expect(result.current.fabric).not.toBeNull())
    expect(result.current.configured).toBe(true)
    await waitFor(() => expect(result.current.joined).toBe(true))
    // The fabric is pointed straight at the configured relayd's own origin —
    // relayd's rendezvous role serves CORS, so the browser calls it directly and
    // this server is not in the discovery path at all.
    expect(lastFabric?.opts.rendezvousBaseUrl).toBe('https://relay.example.org')
    expect(lastFabric?.opts.rendezvousPrefix).toBe('/rendezvous')
    expect(lastFabric?.opts.rendezvousBaseUrl).not.toBe(window.location.origin)
    expect(lastFabric?.opts.sessionId).toBe('file-rv')
    expect(lastFabric?.opts.peerId).toBe('rep-rv')
  })

  it('does not create a fabric when disabled', async () => {
    const { result } = renderHook(() =>
      useCollabFabric({ sessionId: 'f', peerId: 'me', enabled: false }),
    )
    // Give effects a tick.
    await Promise.resolve()
    expect(result.current.fabric).toBeNull()
    expect(result.current.configured).toBe(false)
    expect(lastFabric).toBeNull()
  })

  it('leaves the fabric on unmount', async () => {
    const { result, unmount } = renderHook(() =>
      useCollabFabric({ sessionId: 'f', peerId: 'me' }),
    )
    await waitFor(() => expect(result.current.fabric).not.toBeNull())
    const fab = lastFabric
    unmount()
    expect(fab?.left).toBe(true)
  })
})
