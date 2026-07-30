/**
 * transportSelection.test.js — the collab transport decision.
 *
 * Pure logic test: probeHostPeering / resolveRendezvous / resolveBuiltinPrefix
 * are injected fakes, so this never touches fetch, the DOM, or a real relay.
 *
 * What it pins:
 *   • the priority order — host-box peering, then an EXPLICITLY configured
 *     external relay, then this server's OWN built-in surface, then local-only;
 *   • that the built-in surface is the DEFAULT (the reason a bare `diwan` binary
 *     can do P2P at all, with no Ephor and no other product deployed);
 *   • that "not available" is always honoured as local-only and NEVER turned into
 *     a guessed endpoint — the honesty contract the whole feature rests on;
 *   • that a malformed advertised prefix is refused rather than pasted onto our
 *     origin.
 *
 * The external-relay case pins the DIRECT shape: the browser is pointed at the
 * operator-configured relay's own origin and its own `/rendezvous` prefix, with
 * no Diwan origin in the discovery path. Diwan used to route that through a
 * same-origin proxy because relayd served no CORS; it does now, and e2e-p2p/
 * asserts the whole thing against real servers and a real browser.
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
const BUILTIN_PREFIX = '/api/rendezvous'
const ORIGIN = 'https://office.example.org'

/** The shape every non-rendezvous outcome must have: no rendezvous facts at all. */
const NO_RENDEZVOUS = (transport) => ({
  transport, rendezvousBaseUrl: '', rendezvousPrefix: '', builtin: false,
})

/** Defaults for the injected seams: nothing available anywhere. */
function seams(over = {}) {
  return {
    probeHostPeering: vi.fn().mockResolvedValue(false),
    resolveRendezvous: vi.fn().mockResolvedValue(''),
    resolveBuiltinPrefix: vi.fn().mockResolvedValue(''),
    origin: ORIGIN,
    ...over,
  }
}

describe('selectCollabTransport', () => {
  it('prefers host-box peering when it is reachable, regardless of any rendezvous config', async () => {
    const s = seams({
      probeHostPeering: vi.fn().mockResolvedValue(true),
      resolveRendezvous: vi.fn().mockResolvedValue(RDV_URL),
      resolveBuiltinPrefix: vi.fn().mockResolvedValue(BUILTIN_PREFIX),
    })

    const choice = await selectCollabTransport(s)

    expect(choice).toEqual(NO_RENDEZVOUS(TRANSPORT_HOST_PEERING))
    // Short-circuits: never even asks about either rendezvous option.
    expect(s.resolveRendezvous).not.toHaveBeenCalled()
    expect(s.resolveBuiltinPrefix).not.toHaveBeenCalled()
  })

  it('prefers an EXPLICITLY configured external relay over the built-in surface', async () => {
    // Naming a relay in config.yaml is a deliberate operator choice (a shared
    // relay across deployments, or its TURN help), so it outranks the default.
    const s = seams({
      resolveRendezvous: vi.fn().mockResolvedValue(RDV_URL),
      resolveBuiltinPrefix: vi.fn().mockResolvedValue(BUILTIN_PREFIX),
    })

    const choice = await selectCollabTransport(s)

    expect(choice).toEqual({
      transport: TRANSPORT_RENDEZVOUS,
      // The relay's OWN origin: the browser calls it cross-origin and this
      // server sees none of the discovery traffic.
      rendezvousBaseUrl: RDV_URL,
      rendezvousPrefix: RENDEZVOUS_PREFIX,
      builtin: false,
    })
    // Regression guard for the removed proxy: never our own origin.
    expect(choice.rendezvousBaseUrl).not.toBe(ORIGIN)
  })

  it('normalises a trailing slash on the configured rendezvous URL', async () => {
    // config.yaml is hand-written, so `https://relay.example.org/` is likely;
    // joining it to a `/rendezvous` prefix unnormalised yields a `//` path that
    // the relay would 404.
    const choice = await selectCollabTransport(seams({
      resolveRendezvous: vi.fn().mockResolvedValue(`${RDV_URL}//`),
    }))

    expect(choice.rendezvousBaseUrl).toBe(RDV_URL)
  })

  it('uses this server’s OWN built-in surface when no host box and no relay are configured', async () => {
    // THE DEFAULT PATH, and the point of the whole feature: a bare `diwan`
    // binary with nothing else deployed still gets real peer-to-peer
    // collaboration, because it serves the signalling itself.
    const choice = await selectCollabTransport(seams({
      resolveBuiltinPrefix: vi.fn().mockResolvedValue(BUILTIN_PREFIX),
    }))

    expect(choice).toEqual({
      transport: TRANSPORT_RENDEZVOUS,
      rendezvousBaseUrl: ORIGIN,
      rendezvousPrefix: BUILTIN_PREFIX,
      builtin: true,
    })
  })

  it('normalises a trailing slash on the advertised built-in prefix', async () => {
    const choice = await selectCollabTransport(seams({
      resolveBuiltinPrefix: vi.fn().mockResolvedValue(`${BUILTIN_PREFIX}/`),
    }))
    expect(choice.rendezvousPrefix).toBe(BUILTIN_PREFIX)
  })

  it('falls back to local-only when nothing at all is available', async () => {
    // The operator turned the built-in surface off and named no relay. Honest
    // local-only, never a guessed endpoint.
    const choice = await selectCollabTransport(seams())
    expect(choice).toEqual(NO_RENDEZVOUS(TRANSPORT_LOCAL_ONLY))
  })

  it('refuses a built-in prefix that is not an absolute same-origin path', async () => {
    // A server that answered something odd must degrade to local-only rather than
    // have us paste it onto our origin or, worse, treat it as another host. Each
    // of these would otherwise send discovery somewhere unintended.
    for (const bad of [
      'api/rendezvous',              // relative — would resolve against the page path
      '//evil.example.org/rdv',      // scheme-relative — a DIFFERENT origin
      'https://evil.example.org/rdv', // absolute URL — a different origin
      '',                            // explicitly disabled
    ]) {
      const choice = await selectCollabTransport(seams({
        resolveBuiltinPrefix: vi.fn().mockResolvedValue(bad),
      }))
      expect(choice, `prefix ${JSON.stringify(bad)}`).toEqual(NO_RENDEZVOUS(TRANSPORT_LOCAL_ONLY))
    }
  })

  it('refuses the built-in surface when the page has no origin to join it to', async () => {
    const choice = await selectCollabTransport(seams({
      resolveBuiltinPrefix: vi.fn().mockResolvedValue(BUILTIN_PREFIX),
      origin: '',
    }))
    expect(choice).toEqual(NO_RENDEZVOUS(TRANSPORT_LOCAL_ONLY))
  })

  it('treats a throwing host-peering probe as unavailable rather than rejecting', async () => {
    const choice = await selectCollabTransport(seams({
      probeHostPeering: vi.fn().mockRejectedValue(new Error('network error')),
      resolveRendezvous: vi.fn().mockResolvedValue(RDV_URL),
    }))

    expect(choice.transport).toBe(TRANSPORT_RENDEZVOUS)
    expect(choice.builtin).toBe(false)
  })

  it('treats a throwing rendezvous resolver as unconfigured and still tries the built-in surface', async () => {
    const choice = await selectCollabTransport(seams({
      resolveRendezvous: vi.fn().mockRejectedValue(new Error('network error')),
      resolveBuiltinPrefix: vi.fn().mockResolvedValue(BUILTIN_PREFIX),
    }))

    expect(choice.builtin).toBe(true)
    expect(choice.transport).toBe(TRANSPORT_RENDEZVOUS)
  })

  it('treats a throwing built-in resolver as unavailable rather than rejecting', async () => {
    const choice = await selectCollabTransport(seams({
      resolveBuiltinPrefix: vi.fn().mockRejectedValue(new Error('network error')),
    }))
    expect(choice).toEqual(NO_RENDEZVOUS(TRANSPORT_LOCAL_ONLY))
  })

  it('treats a non-string resolver result as unconfigured', async () => {
    // Honesty contract: anything that is not a usable URL/path must degrade,
    // never become a half-built base the fabric would fetch against.
    const choice = await selectCollabTransport(seams({
      resolveRendezvous: vi.fn().mockResolvedValue({ url: RDV_URL }),
      resolveBuiltinPrefix: vi.fn().mockResolvedValue({ prefix: BUILTIN_PREFIX }),
    }))

    expect(choice).toEqual(NO_RENDEZVOUS(TRANSPORT_LOCAL_ONLY))
  })

  it('uses the real probes by default', async () => {
    // No fetch stub at all: the real probes require `fetch` — jsdom provides one,
    // but with nothing stubbed the request rejects, which every real probe
    // already treats as "unavailable". This pins that the exported defaults are
    // wired (no crash without injected fakes) and that a server we cannot reach
    // yields local-only rather than an invented endpoint.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const choice = await selectCollabTransport()
    expect(choice.transport).toBe(TRANSPORT_LOCAL_ONLY)
    vi.unstubAllGlobals()
  })
})
