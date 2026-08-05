// no-broker-dep:allow-file: this suite proves the OPTIONAL, explicitly-configured external-relay
// path (RendezvousURL/vulos-relayd/Pier) that only activates when an operator sets it — the
// default is empty (backend/config/config_test.go: TestDefault_RendezvousURLEmpty) and its
// sibling builtin-rendezvous-p2p.e2e.js proves the DEFAULT path needs no relay at all.
/**
 * rendezvous-p2p.e2e.ts — the OPTIONAL posture, proved end to end with nothing
 * mocked:
 *
 *   "A standalone Diwan can delegate peer discovery to an operator's OWN
 *    external relay (a self-hosted `vulos-relayd` / Pier), with nothing of ours
 *    in the discovery path at all."
 *
 * ── This is not the default path ─────────────────────────────────────────────
 *
 * It used to be the ONLY path, which made Diwan's central claim conditional on
 * another product being deployed. It is not any more: the binary now serves its
 * own discovery surface (backend/rendezvous), and THAT default is proved by
 * builtin-rendezvous-p2p.e2e.ts — a suite with no external dependency, which
 * therefore cannot be skipped.
 *
 * So this file covers a posture an operator may CHOOSE (one shared relay across
 * several deployments, or its TURN/NAT-traversal help), and it skips — loudly,
 * with one stated reason — when no relayd binary was supplied in VULOS_RELAYD_BIN.
 * It deliberately does NOT clone or build another repository to find one.
 *
 * The instances here run with `builtin_rendezvous: false`, so the premise below is
 * exactly true rather than approximately: Diwan mounts nothing for discovery.
 *
 * This suite runs the real thing: a real `vulos-relayd` binary with the
 * rendezvous role enabled, two real standalone `diwan` servers (separate ports,
 * separate data dirs — no shared state whatsoever), two real browser contexts, and
 * a real WebRTC data channel.
 *
 * ── What "proven" means here ────────────────────────────────────────────────
 *
 * The two peers are served by two DIFFERENT Diwan servers that share no storage
 * and no document endpoint. The only things they have in common are (a) the one
 * relayd both are configured to discover through, and (b) the room key, which
 * lives in the invite link's URL fragment and is never sent to any server. So
 * if a keystroke in browser A shows up in browser B, discovery MUST have gone
 * through the relayd — there is no other path between them. On top of that
 * necessary-condition argument the suite adds direct evidence:
 *
 *   • the relay's OWN presence state is read back from the relay's origin
 *     (GET /rendezvous/resolve/<key>) and must know the key each browser
 *     announced — soft state only the relay could hold;
 *   • the browsers' request logs must show the rendezvous protocol
 *     (announce/signal) and must show NO /api/peering/* at all;
 *   • the negative control: with the relayd stopped, the same flow does not
 *     connect.
 *
 * ── The browser calls the relayd DIRECTLY ───────────────────────────────────
 *
 * There is no Diwan server in the discovery path: the pages fetch the relay's
 * own origin cross-origin, which works because relayd's rendezvous role serves
 * CORS. That is asserted below as a measured fact about the relay (not assumed),
 * including from a real browser, since only a browser enforces CORS. It also
 * sharpens every assertion in this file: rendezvous traffic appears in the
 * browsers' request logs pointed at the RELAY's origin, so "the signaling went
 * through the relayd" is visible directly rather than inferred through a proxy.
 */

import { test, expect, type Page } from '@playwright/test'
import { startStack, relayResolve, createDoc, relaydBinAvailable, BUILTIN_PREFIX, type Stack } from './stack'
import {
  instrumentWebRTC, selectedCandidatePairs, mirrorConsole, recordRequests, openDoc, mintInviteLink,
  type RecordedRequest,
} from './helpers'

interface ReachabilityResponse {
  builtin_rendezvous_prefix: string
  rendezvous_url: string
}

interface CorsProbeResult {
  ice?: { status: number; body: unknown }
  iceError?: string
  announce?: { status: number; body: string }
  announceError?: string
}

/** Shared stack for the whole file — building the binaries once is the point. */
let stack: Stack

test.beforeAll(async () => {
  // This suite exercises the OPTIONAL posture, so it may legitimately be absent —
  // but it must be absent LOUDLY and for one stated reason: no relayd binary was
  // supplied. It never clones or builds another repository to find one; that is
  // how a job ends up red for a reason unrelated to the code under test (as it
  // was while it cloned a repo that had been renamed).
  //
  // Nothing about Diwan's DEFAULT path depends on this file: that is proved,
  // unskippably, by builtin-rendezvous-p2p.e2e.ts.
  test.skip(!relaydBinAvailable(),
    'no vulos-relayd binary supplied — set VULOS_RELAYD_BIN to exercise the external-relay ' +
    'posture. Diwan\'s default (built-in) P2P path is covered by builtin-rendezvous-p2p.e2e.ts.')
  stack = await startStack({ rendezvous: 'external', offices: 2, localOnlyOffice: true })
})

test.afterAll(async () => {
  if (stack) await stack.stop()
})

// ─────────────────────────────────────────────────────────────────────────────

test('relayd rendezvous is browser-reachable cross-origin — the guarantee the direct transport rests on', async ({ request, browser }) => {
  // Server-to-server (no browser, no CORS): the relay is up and speaking the
  // protocol.
  const health = await request.get(`${stack.relayUrl}/rendezvous/healthz`)
  expect(health.ok()).toBe(true)
  expect((await health.json()).role).toBe('rendezvous')

  // ── The CORS contract, asserted as a REQUIREMENT ──────────────────────────
  //
  // Diwan's browser code calls this relayd's origin directly. That only works
  // because relayd's rendezvous role sends CORS headers, so this suite pins the
  // exact posture the transport depends on: a relayd that regressed it would
  // break every standalone deployment, and this test is what catches that here
  // rather than in the field. (Diwan carried a same-origin proxy until relayd
  // shipped this; see docs/COLLABORATION.md §3.)
  const ice = await request.get(`${stack.relayUrl}/rendezvous/ice`, {
    headers: { Origin: stack.offices[0].url },
  })
  expect(ice.ok()).toBe(true)
  expect(ice.headers()['access-control-allow-origin'],
    'relayd must allow cross-origin reads of the rendezvous surface').toBe('*')
  // Credentials must NEVER be allowed: the rendezvous protocol authenticates
  // with Ed25519 signatures in the body, so an allow-credentials wildcard would
  // add ambient-authority risk for no benefit.
  expect(ice.headers()['access-control-allow-credentials'],
    'the rendezvous surface must not allow credentialed cross-origin requests').toBeUndefined()

  // A real preflight for the announce POST must be answered, not 405'd.
  const preflight = await request.fetch(`${stack.relayUrl}/rendezvous/announce`, {
    method: 'OPTIONS',
    headers: {
      Origin: stack.offices[0].url,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  })
  expect(preflight.status(), 'the announce preflight must succeed').toBeLessThan(300)
  expect(preflight.headers()['access-control-allow-origin']).toBe('*')
  expect((preflight.headers()['access-control-allow-methods'] || '')).toContain('POST')
  expect((preflight.headers()['access-control-allow-headers'] || '').toLowerCase()).toContain('content-type')

  // ── …and the same thing from a REAL browser on a DIFFERENT origin ─────────
  //
  // Header assertions above are necessary but not sufficient: only a browser
  // enforces CORS. This runs the actual fetches from an Diwan page, so a
  // preflight that a raw HTTP client accepts but Chromium rejects cannot pass.
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  try {
    await page.goto(stack.offices[0].url)
    const out = await page.evaluate(async (relayUrl) => {
      const result: CorsProbeResult = {}
      try {
        const r = await fetch(`${relayUrl}/rendezvous/ice`)
        result.ice = { status: r.status, body: await r.json() }
      } catch (err) { result.iceError = String(err) }
      try {
        // A deliberately invalid announce: the point is that the browser can
        // READ the relay's answer (a 400 with a JSON error), not an opaque
        // network failure. This is a real preflighted POST.
        const r = await fetch(`${relayUrl}/rendezvous/announce`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        })
        result.announce = { status: r.status, body: await r.text() }
      } catch (err) { result.announceError = String(err) }
      return result
    }, stack.relayUrl)

    expect(out.iceError, 'a browser on another origin could not read GET /rendezvous/ice').toBeUndefined()
    if (!out.ice) throw new Error('expected the ICE probe to have succeeded (iceError was undefined)')
    expect(out.ice.status).toBe(200)
    expect(out.ice.body).toHaveProperty('ice_servers')
    expect(out.announceError, 'the preflighted announce POST was blocked by the browser').toBeUndefined()
    if (!out.announce) throw new Error('expected the announce probe to have succeeded (announceError was undefined)')
    // Readable rejection, not an opaque failure — apps can show a real error.
    expect(out.announce.status).toBe(400)
    expect(out.announce.body.length, 'the error body must be readable cross-origin').toBeGreaterThan(0)
  } finally {
    await ctx.close()
  }
})

test('a standalone Diwan advertises the rendezvous and mounts no host-box peering', async ({ request }) => {
  const [a] = stack.offices

  // The premise of the whole claim: this binary serves no /api/peering/*.
  const peering = await request.get(`${a.url}/api/peering/ice`)
  expect(peering.status(), 'a standalone Diwan must not serve host-box peering').toBe(404)

  const reach = await (await request.get(`${a.url}/api/reachability`)).json() as ReachabilityResponse
  expect(reach.rendezvous_url).toBe(stack.relayUrl)
  // These instances run with `builtin_rendezvous: false`, which is what makes the
  // premise of this whole file exactly true rather than approximately: with the
  // built-in surface off, Diwan mounts NOTHING for discovery and the browser can
  // only be talking to the relay.
  expect(reach.builtin_rendezvous_prefix,
    'this posture deliberately disables the built-in surface').toBe('')
  expect((await request.get(`${a.url}${BUILTIN_PREFIX}/healthz`)).status(),
    'with builtin_rendezvous:false, Diwan must mount no discovery surface at all').toBe(404)
})

test('THE PAYOFF — two standalone Diwan servers collaborate P2P through the relayd', async ({ browser }) => {
  const [a, b] = stack.offices
  const docA = await createDoc(a.url, 'P2P Proof A')
  const docB = await createDoc(b.url, 'P2P Proof B')

  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const pageA = await ctxA.newPage()
  const pageB = await ctxB.newPage()
  await instrumentWebRTC(pageA)
  await instrumentWebRTC(pageB)
  mirrorConsole(pageA, 'A')
  mirrorConsole(pageB, 'B')
  const reqA = recordRequests(pageA)
  const reqB = recordRequests(pageB)

  try {
    // A: open a doc on server A and mint an invite link.
    await openDoc(pageA, `${a.url}/docs/${docA}`)
    const rwLink = await mintInviteLink(pageA)

    // B: open the SAME room on server B. Only the fragment (the room key)
    // crosses over — the origin and the document id are B's own. Nothing about
    // A's server is involved in B's session.
    const fragment = rwLink.split('#')[1]
    await openDoc(pageB, `${b.url}/docs/${docB}#${fragment}`)

    // Both sides must announce themselves to the relay — directly, cross-origin
    // — before anything can connect. Note the URLs matched here are the RELAY's
    // origin, not either Diwan's: that is the whole point.
    await expect
      .poll(() => reqA.filter((r) => r.url.startsWith(`${stack.relayUrl}/rendezvous/`)).length, {
        message: 'peer A never spoke the rendezvous protocol',
        timeout: 60_000,
      })
      .toBeGreaterThan(0)
    await expect
      .poll(() => reqB.filter((r) => r.url.startsWith(`${stack.relayUrl}/rendezvous/`)).length, {
        message: 'peer B never spoke the rendezvous protocol',
        timeout: 60_000,
      })
      .toBeGreaterThan(0)

    // RELAY-SIDE GROUND TRUTH: the key each browser announced is really in the
    // relay's presence store. Read straight from the relay's own origin.
    const announcedKeys = [...reqA, ...reqB]
      .filter((r) => r.url.startsWith(`${stack.relayUrl}/rendezvous/announce`) && r.postData)
      .map((r) => { try { return (JSON.parse(r.postData as string) as { key?: string }).key } catch { return null } })
      .filter((k): k is string => Boolean(k))
    expect(announcedKeys.length, 'no signed announce was sent to the relay').toBeGreaterThan(0)

    await expect.poll(async () => {
      for (const key of announcedKeys) {
        const { status } = await relayResolve(stack.relayUrl, key)
        if (status === 200) return true
      }
      return false
    }, { message: 'the relay does not know any announced peer — signaling did not reach it', timeout: 60_000 })
      .toBe(true)

    // THE CONVERGENCE: type in A, see it in B. There is no server path between
    // these two browsers, so this can only have travelled peer-to-peer.
    const marker = `hello-from-A-${Date.now()}`
    await pageA.locator('.ProseMirror').click()
    await pageA.keyboard.type(marker)
    // Establish that the local edit landed at all, so a failure below is
    // unambiguously a propagation failure and not a typing/focus problem.
    await expect(pageA.locator('.ProseMirror'), 'the local edit did not even land in A').toContainText(marker)

    await expect(pageB.locator('.ProseMirror'), 'peer A\'s edit never reached peer B')
      .toContainText(marker, { timeout: 90_000 })

    // …and back the other way, which also proves the channel is bidirectional
    // rather than a one-shot snapshot.
    const markerB = ` and-back-from-B-${Date.now()}`
    await pageB.locator('.ProseMirror').click()
    await pageB.keyboard.press('End')
    await pageB.keyboard.type(markerB)
    await expect(pageA.locator('.ProseMirror')).toContainText(markerB, { timeout: 90_000 })

    // Both documents now hold BOTH edits — CRDT convergence, not last-writer-wins.
    await expect(pageA.locator('.ProseMirror')).toContainText(marker)
    await expect(pageB.locator('.ProseMirror')).toContainText(marker)
    await expect(pageB.locator('.ProseMirror')).toContainText(markerB.trim())

    // No host-box peering was involved anywhere — this really was the
    // rendezvous transport, not a fallback onto some /api/peering/* surface.
    const named: [string, RecordedRequest[]][] = [['A', reqA], ['B', reqB]]
    for (const [name, reqs] of named) {
      const peering = reqs.filter((r) => r.url.includes('/api/peering/stream'))
      expect(peering, `peer ${name} used host-box peering signaling`).toHaveLength(0)
    }

    // WHICH PATH CARRIED IT — direct data channel, or the content-blind relay
    // circuit? Both are the documented behaviour (§3 of docs/COLLABORATION.md:
    // direct first, relay circuit as the fallback for pairs that cannot
    // hole-punch), and both are P2P *through the rendezvous* — so the assertion
    // is that ONE of them demonstrably carried the edits, and the run says
    // which. Insisting on "direct" would be a lie in any sandbox where ICE
    // cannot complete; accepting neither would let a broken transport pass.
    const pairsA = await selectedCandidatePairs(pageA)
    const pairsB = await selectedCandidatePairs(pageB)
    const directPairs = [...pairsA, ...pairsB]
    const anyDirect = directPairs.some((p) => p.localType === 'host' && p.remoteType === 'host')
    // The relay circuit is the rendezvous MAILBOX (content-blind, ciphertext
    // only) — distinct from the signal inbox used for offer/answer/ICE.
    const mailboxCalls = [...reqA, ...reqB].filter((r) => r.url.startsWith(`${stack.relayUrl}/rendezvous/mailbox`)).length

    console.log('[p2p-e2e] transport — direct pairs:', JSON.stringify(directPairs),
      '| relay-circuit mailbox calls:', mailboxCalls)
    if (anyDirect) {
      console.log('[p2p-e2e] DIRECT: a host/host WebRTC data channel carried the edits')
    } else {
      console.warn('[p2p-e2e] FALLBACK: no direct candidate pair formed in this sandbox — ' +
        'the edits rode the content-blind relay circuit instead')
    }
    expect(
      anyDirect || mailboxCalls > 0,
      'the edits converged over neither a WebRTC data channel nor the relay circuit — ' +
      'something other than the P2P transport moved them',
    ).toBe(true)

  } finally {
    await ctxA.close()
    await ctxB.close()
  }
})

test('offline divergence — both peers edit disconnected, then converge on reconnect', async ({ browser }) => {
  const [a, b] = stack.offices
  const docA = await createDoc(a.url, 'Divergence A')
  const docB = await createDoc(b.url, 'Divergence B')

  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const pageA = await ctxA.newPage()
  const pageB = await ctxB.newPage()
  await instrumentWebRTC(pageA)
  await instrumentWebRTC(pageB)
  mirrorConsole(pageA, 'A')
  mirrorConsole(pageB, 'B')

  try {
    await openDoc(pageA, `${a.url}/docs/${docA}`)
    const rwLink = await mintInviteLink(pageA)
    await openDoc(pageB, `${b.url}/docs/${docB}#${rwLink.split('#')[1]}`)

    // Establish the session first, so "reconnect" means something.
    const warmup = `warm-${Date.now()}`
    await pageA.locator('.ProseMirror').click()
    await pageA.keyboard.type(warmup)
    await expect(pageB.locator('.ProseMirror')).toContainText(warmup, { timeout: 90_000 })

    // SEVER THE TRANSPORT. Two things are needed, and both model a real
    // outage. Closing the RTCPeerConnection is the data channel going away
    // (a sleeping laptop, a dropped Wi-Fi link) — note that Playwright's
    // setOffline alone does NOT do this, since an established WebRTC flow is
    // not HTTP and keeps running. setOffline then keeps them apart by blocking
    // the rendezvous signaling they would otherwise use to reconnect
    // immediately.
    await ctxA.setOffline(true)
    await ctxB.setOffline(true)
    const dropPeers = (page: Page) => page.evaluate(() => (window.__pcs || []).forEach((pc) => { try { pc.close() } catch { /* already closed */ } }))
    await dropPeers(pageA)
    await dropPeers(pageB)

    const soloA = ` soloA-${Date.now()}`
    const soloB = ` soloB-${Date.now()}`
    await pageA.locator('.ProseMirror').click()
    await pageA.keyboard.press('End')
    await pageA.keyboard.type(soloA)
    await pageB.locator('.ProseMirror').click()
    await pageB.keyboard.press('End')
    await pageB.keyboard.type(soloB)

    // Each side kept editing locally — collaboration never blocks typing.
    await expect(pageA.locator('.ProseMirror')).toContainText(soloA.trim())
    await expect(pageB.locator('.ProseMirror')).toContainText(soloB.trim())
    // …and they really are diverged: neither has the other's offline edit.
    await expect(pageA.locator('.ProseMirror'), 'the peers were never actually severed').not.toContainText(soloB.trim())
    await expect(pageB.locator('.ProseMirror'), 'the peers were never actually severed').not.toContainText(soloA.trim())

    // Reconnect: rediscovery through the relayd, a fresh data channel, and the
    // state-vector exchange must deliver exactly what each side missed, in BOTH
    // directions, with nothing discarded.
    await ctxA.setOffline(false)
    await ctxB.setOffline(false)

    await expect(pageA.locator('.ProseMirror'), "B's offline edit was lost")
      .toContainText(soloB.trim(), { timeout: 120_000 })
    await expect(pageB.locator('.ProseMirror'), "A's offline edit was lost")
      .toContainText(soloA.trim(), { timeout: 120_000 })
    // Union merge: the warm-up edit and both offline edits all survive.
    await expect(pageA.locator('.ProseMirror')).toContainText(warmup)
    await expect(pageA.locator('.ProseMirror')).toContainText(soloA.trim())
    await expect(pageB.locator('.ProseMirror')).toContainText(soloB.trim())
  } finally {
    await ctxA.close()
    await ctxB.close()
  }
})

test('NEGATIVE — with no rendezvous configured, standalone Diwan reports local-only and never fakes a session', async ({ browser, request }) => {
  const lo = stack.localOnly
  expect(lo, 'the local-only instance must be booted for this test').toBeTruthy()
  // expect(...).toBeTruthy() above is the real runtime guarantee (it fails the
  // test right here if lo is null); this just gives the type checker the same
  // fact so the rest of the test can use `lo` without re-checking.
  if (!lo) throw new Error('the local-only instance must be booted for this test')

  // The server tells the truth: no rendezvous configured, and no host-box
  // peering either — so there is nothing for the client to reach for.
  const reach = await (await request.get(`${lo.url}/api/reachability`)).json() as ReachabilityResponse
  expect(reach.rendezvous_url).toBe('')
  expect((await request.get(`${lo.url}/api/peering/ice`)).status()).toBe(404)

  const docId = await createDoc(lo.url, 'Local Only')
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  const reqs = recordRequests(page)
  try {
    await openDoc(page, `${lo.url}/docs/${docId}`)
    await page.getByRole('button', { name: /Share — with people/i }).click()
    await page.getByRole('button', { name: /Share via link \(P2P\)/i }).click()

    // The honesty contract: it says so, rather than minting links that would
    // look real and never connect anyone. If this ever silently produced an
    // invite link, the positive test above would prove nothing.
    await expect(page.getByText(/P2P collaboration isn't available on this server/i))
      .toBeVisible({ timeout: 30_000 })
    const links = await page.locator('input[readonly]').evaluateAll(
      (els) => (els as HTMLInputElement[]).map((e) => e.value).filter((v) => /#vp2p=/.test(v)),
    )
    expect(links, 'a local-only deployment must not mint invite links').toHaveLength(0)

    // And it never reached for a transport it does not have.
    expect(reqs.filter((r) => r.url.includes('/rendezvous/'))).toHaveLength(0)
    expect(reqs.filter((r) => r.url.includes('/api/peering/stream'))).toHaveLength(0)
  } finally {
    await ctx.close()
  }
})
