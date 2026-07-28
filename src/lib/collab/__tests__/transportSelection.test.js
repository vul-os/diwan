/**
 * transportSelection.test.js — the three-way collab transport decision.
 *
 * Pure logic test: probeHostPeering/resolveRendezvous are injected fakes, so this
 * never touches fetch, the DOM, or the real relay-client SDK. Covers the priority
 * order (host-box peering wins over rendezvous, which wins over local-only) and
 * that a throwing probe degrades to "unavailable" rather than escaping the
 * selector.
 *
 * The rendezvous case pins the DIRECT shape: the browser is pointed at the
 * operator-configured relayd's own origin and relayd's own `/rendezvous` prefix,
 * with no Diwan origin anywhere in the discovery path. Diwan used to route this
 * through a same-origin proxy because relayd served no CORS; it does now, and
 * e2e-p2p/ asserts that against a real relayd and a real browser.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  selectCollabTransport,
  RENDEZVOUS_PREFIX,
  TRANSPORT_HOST_PEERING,
  TRANSPORT_RENDEZVOUS,
  TRANSPORT_LOCAL_ONLY,
} from '../transportSelection.js'

const RDV_URL = 'https://relay.example.org'
/** The shape every non-rendezvous outcome must have: no rendezvous facts at all. */
const NO_RENDEZVOUS = (transport) => ({
  transport, rendezvousBaseUrl: '', rendezvousPrefix: '',
})

describe('selectCollabTransport', () => {
  it('prefers host-box peering when it is reachable, regardless of rendezvous config', async () => {
    const probeHostPeering = vi.fn().mockResolvedValue(true)
    const resolveRendezvous = vi.fn().mockResolvedValue(RDV_URL)

    const choice = await selectCollabTransport({ probeHostPeering, resolveRendezvous })

    expect(choice).toEqual(NO_RENDEZVOUS(TRANSPORT_HOST_PEERING))
    // Short-circuits: never even asks about rendezvous when the host wins.
    expect(resolveRendezvous).not.toHaveBeenCalled()
  })

  it('falls back to rendezvous when host-box peering is unreachable but a rendezvous URL is configured', async () => {
    const probeHostPeering = vi.fn().mockResolvedValue(false)
    const resolveRendezvous = vi.fn().mockResolvedValue(RDV_URL)

    const choice = await selectCollabTransport({ probeHostPeering, resolveRendezvous })

    expect(choice).toEqual({
      transport: TRANSPORT_RENDEZVOUS,
      // The relay's OWN origin: the browser calls it cross-origin and this
      // server sees none of the discovery traffic.
      rendezvousBaseUrl: RDV_URL,
      rendezvousPrefix: RENDEZVOUS_PREFIX,
    })
    // Regression guard for the removed proxy: never our own origin.
    expect(choice.rendezvousBaseUrl).not.toBe(window.location.origin)
  })

  it('normalises a trailing slash on the configured rendezvous URL', async () => {
    // config.yaml is hand-written, so `https://relay.example.org/` is likely;
    // joining it to a `/rendezvous` prefix unnormalised yields a `//` path that
    // the relay would 404.
    const probeHostPeering = vi.fn().mockResolvedValue(false)
    const resolveRendezvous = vi.fn().mockResolvedValue(`${RDV_URL}//`)

    const choice = await selectCollabTransport({ probeHostPeering, resolveRendezvous })

    expect(choice.rendezvousBaseUrl).toBe(RDV_URL)
  })

  it('falls back to local-only when neither host-box peering nor a rendezvous URL is available', async () => {
    const probeHostPeering = vi.fn().mockResolvedValue(false)
    const resolveRendezvous = vi.fn().mockResolvedValue('')

    const choice = await selectCollabTransport({ probeHostPeering, resolveRendezvous })

    expect(choice).toEqual(NO_RENDEZVOUS(TRANSPORT_LOCAL_ONLY))
  })

  it('treats a throwing host-peering probe as unavailable rather than rejecting', async () => {
    const probeHostPeering = vi.fn().mockRejectedValue(new Error('network error'))
    const resolveRendezvous = vi.fn().mockResolvedValue(RDV_URL)

    const choice = await selectCollabTransport({ probeHostPeering, resolveRendezvous })

    expect(choice.transport).toBe(TRANSPORT_RENDEZVOUS)
  })

  it('treats a throwing rendezvous resolver as unconfigured rather than rejecting', async () => {
    const probeHostPeering = vi.fn().mockResolvedValue(false)
    const resolveRendezvous = vi.fn().mockRejectedValue(new Error('network error'))

    const choice = await selectCollabTransport({ probeHostPeering, resolveRendezvous })

    expect(choice).toEqual(NO_RENDEZVOUS(TRANSPORT_LOCAL_ONLY))
  })

  it('treats a non-string resolver result as unconfigured', async () => {
    // Honesty contract: anything that is not a usable URL must degrade to
    // local-only, never to a half-built base the fabric would fetch against.
    const probeHostPeering = vi.fn().mockResolvedValue(false)
    const resolveRendezvous = vi.fn().mockResolvedValue({ url: RDV_URL })

    const choice = await selectCollabTransport({ probeHostPeering, resolveRendezvous })

    expect(choice).toEqual(NO_RENDEZVOUS(TRANSPORT_LOCAL_ONLY))
  })

  it('uses the real probePeeringAvailable/resolveRendezvousUrl by default', async () => {
    // No fetch stub at all: probePeeringAvailable requires `fetch` to exist —
    // jsdom provides one, but with nothing stubbed the request rejects/errors,
    // which both real probes already treat as "unavailable". This just pins
    // that the exported defaults are wired (no crash without injected fakes).
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const choice = await selectCollabTransport()
    expect(choice.transport).toBe(TRANSPORT_LOCAL_ONLY)
    vi.unstubAllGlobals()
  })
})
