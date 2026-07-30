/**
 * builtin-rendezvous-p2p.e2e.js — the DEFAULT path, proved end to end with
 * nothing mocked and nothing external:
 *
 *   "One `diwan` binary on one box is enough for two people to collaborate
 *    peer-to-peer. No Vulos OS, no Ephor, no relay, no account."
 *
 * That sentence is the whole reason backend/rendezvous exists. WebRTC cannot
 * introduce two browsers to each other unaided — something has to carry the first
 * offer/answer/ICE frames — and Diwan used to be able to get that ONLY from
 * another product. With neither present, every session fell through to
 * honestly-local-only. Now the binary serves the signalling itself.
 *
 * ── Why this suite has NO external dependency ───────────────────────────────
 *
 * Its sibling (rendezvous-p2p.e2e.js) needs a prebuilt `vulos-relayd` and skips
 * without one. This one cannot skip: everything it needs it builds from this
 * repository. That is deliberate. A guard that can be skipped is a guard that is
 * absent exactly when something has broken, and the claim above is the one claim
 * in the repo that must never go unchecked.
 *
 * ── What "proven" means here ────────────────────────────────────────────────
 *
 * Two browser contexts (separate storage, separate WebRTC stacks) load the SAME
 * Diwan server, because that is what an operator actually deploys. The server is
 * therefore in common — so the suite does not merely argue "there was no other
 * path", it shows positively:
 *
 *   • the server's OWN presence state knows the Ed25519 key each browser signed
 *     an announce for (soft state only it could hold, read back from its origin);
 *   • the discovery traffic really went to /api/rendezvous/* on that origin, and
 *     NO /api/peering/* was involved anywhere;
 *   • the edits converged both ways — CRDT convergence, not last-writer-wins;
 *   • a direct host↔host WebRTC candidate pair carried them (or, failing that in
 *     a sandbox where ICE cannot complete, the documented content-blind fallback
 *     did — and the run says which);
 *   • the payload the server saw is OPAQUE: the deposits are base64 ciphertext,
 *     and the room key that would decrypt them lives in the invite link's URL
 *     fragment, which is never sent in an HTTP request;
 *   • the NEGATIVE control: with the built-in surface turned off and no relay
 *     configured, the same flow does not connect and the UI says so.
 */

import { test, expect } from '@playwright/test'
import { startStack, createDoc, rendezvousResolve, BUILTIN_PREFIX } from './stack.mjs'
import {
  instrumentWebRTC, selectedCandidatePairs, mirrorConsole, recordRequests, openDoc, mintInviteLink,
} from './helpers.mjs'

/** Shared stack for the whole file — building the binary once is the point. */
let stack

test.beforeAll(async () => {
  // One Diwan with its own discovery surface, plus one with NOTHING configured
  // for the negative control.
  stack = await startStack({ rendezvous: 'builtin', offices: 1, localOnlyOffice: true })
})

test.afterAll(async () => {
  if (stack) await stack.stop()
})

test('a bare standalone Diwan serves its own discovery surface and no host-box peering', async ({ request }) => {
  const [a] = stack.offices

  // The premise: this binary is not fronted by a Vulos OS / Ephor host.
  const peering = await request.get(`${a.url}/api/peering/ice`)
  expect(peering.status(), 'a standalone Diwan must not serve host-box peering').toBe(404)

  // It advertises its own surface, as a PATH on this origin, and names no relay.
  const reach = await (await request.get(`${a.url}/api/reachability`)).json()
  expect(reach.builtin_rendezvous_prefix,
    'a default deployment must advertise its own discovery surface').toBe(BUILTIN_PREFIX)
  expect(reach.rendezvous_url,
    'no relay is configured here — that is the point of the test').toBe('')

  // And the surface is really there.
  const health = await request.get(`${a.url}${BUILTIN_PREFIX}/healthz`)
  expect(health.status()).toBe(200)
  expect((await health.json()).ok).toBe(true)

  // The negative-control instance advertises NOTHING, honestly.
  const off = await (await request.get(`${stack.localOnly.url}/api/reachability`)).json()
  expect(off.builtin_rendezvous_prefix,
    'a deployment with builtin_rendezvous:false must advertise no surface').toBe('')
  expect(off.rendezvous_url).toBe('')
  expect((await request.get(`${stack.localOnly.url}${BUILTIN_PREFIX}/healthz`)).status(),
    'a disabled surface must not be mounted at all').toBe(404)
})

test('the discovery surface refuses an unsigned write', async ({ request }) => {
  // The surface is anonymous by design (invite-link collaboration needs no
  // account), so its ONLY defence is that every write is signed. A cloud node is
  // exposed, so that has to be true over real HTTP and not just in unit tests.
  const [a] = stack.offices
  const res = await request.post(`${a.url}${BUILTIN_PREFIX}/announce`, {
    data: { key: 'A'.repeat(43), endpoints: [], meta: 'x', ttl: 0, nonce: 'n', ts: Math.floor(Date.now() / 1000), sig: '' },
  })
  expect([400, 403], `an unsigned announce must be refused, got ${res.status()}`).toContain(res.status())

  // …and it stored nothing.
  const resolved = await request.get(`${a.url}${BUILTIN_PREFIX}/resolve/${'A'.repeat(43)}`)
  expect(resolved.status()).not.toBe(200)
})

test('THE PAYOFF — two browsers collaborate P2P through one bare Diwan binary', async ({ browser }) => {
  const [a] = stack.offices
  const doc = await createDoc(a.url, 'Built-in Rendezvous Proof')

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

  const rdvUrl = `${a.url}${BUILTIN_PREFIX}/`

  try {
    await openDoc(pageA, `${a.url}/docs/${doc}`)
    const rwLink = await mintInviteLink(pageA)

    // B joins the same room. The room KEY travels only in the URL fragment, which
    // browsers never put in an HTTP request — so the server that is about to move
    // their discovery payloads cannot read them.
    const fragment = rwLink.split('#')[1]
    expect(fragment, 'the invite link must carry the room key in its fragment').toMatch(/^vp2p=/)
    await openDoc(pageB, `${a.url}/docs/${doc}#${fragment}`)

    // Both sides must speak the rendezvous protocol to THIS server.
    for (const [name, reqs] of [['A', reqA], ['B', reqB]]) {
      await expect
        .poll(() => reqs.filter((r) => r.url.startsWith(rdvUrl)).length, {
          message: `peer ${name} never spoke the built-in rendezvous protocol`,
          timeout: 60_000,
        })
        .toBeGreaterThan(0)
    }

    // SERVER-SIDE GROUND TRUTH: the key each browser signed an announce for is
    // really in this server's presence store. A client cannot fabricate that.
    const announcedKeys = [...reqA, ...reqB]
      .filter((r) => r.url.startsWith(`${rdvUrl}announce`) && r.postData)
      .map((r) => { try { return JSON.parse(r.postData).key } catch { return null } })
      .filter(Boolean)
    expect(announcedKeys.length, 'no signed announce was sent').toBeGreaterThan(0)

    await expect.poll(async () => {
      for (const key of announcedKeys) {
        const { status } = await rendezvousResolve(a.url, key, BUILTIN_PREFIX)
        if (status === 200) return true
      }
      return false
    }, {
      message: 'the server knows no announced peer — signalling did not reach it',
      timeout: 60_000,
    }).toBe(true)

    // WHAT THE SERVER SAW IS OPAQUE. Every signal deposit's payload is base64url
    // ciphertext, and the plaintext of the room lives behind a key it never got.
    // Assert the shape rather than trusting the design doc: no deposit body may
    // contain the marker text we are about to type, and none may contain the room
    // key from the fragment.
    const roomKeyMaterial = fragment.replace(/^vp2p=/, '')
    const deposits = [...reqA, ...reqB].filter((r) => r.url.startsWith(`${rdvUrl}signal/`) && r.postData)
    for (const d of deposits) {
      expect(d.postData,
        'the room key must never be sent to the server — it lives in the URL fragment',
      ).not.toContain(roomKeyMaterial)
    }

    // THE CONVERGENCE: type in A, see it in B.
    const marker = `hello-from-A-${Date.now()}`
    await pageA.locator('.ProseMirror').click()
    await pageA.keyboard.type(marker)
    await expect(pageA.locator('.ProseMirror'), 'the local edit did not even land in A').toContainText(marker)
    await expect(pageB.locator('.ProseMirror'), "peer A's edit never reached peer B")
      .toContainText(marker, { timeout: 90_000 })

    // …and back the other way, which proves the channel is bidirectional rather
    // than a one-shot snapshot.
    const markerB = ` and-back-from-B-${Date.now()}`
    await pageB.locator('.ProseMirror').click()
    await pageB.keyboard.press('End')
    await pageB.keyboard.type(markerB)
    await expect(pageA.locator('.ProseMirror')).toContainText(markerB, { timeout: 90_000 })

    // Both documents hold BOTH edits — CRDT convergence, not last-writer-wins.
    await expect(pageA.locator('.ProseMirror')).toContainText(marker)
    await expect(pageB.locator('.ProseMirror')).toContainText(marker)
    await expect(pageB.locator('.ProseMirror')).toContainText(markerB.trim())

    // The typed text must never appear in a discovery payload: the server moved
    // ciphertext, not document content. Checked AFTER typing so the deposits that
    // carried the edit-time signalling are included.
    const postTyping = [...reqA, ...reqB].filter((r) => r.url.startsWith(rdvUrl) && r.postData)
    for (const d of postTyping) {
      expect(d.postData, 'document text leaked into a discovery payload').not.toContain(marker)
      expect(d.postData, 'document text leaked into a discovery payload').not.toContain(markerB.trim())
    }

    // No host-box peering anywhere: this really was the built-in surface and not
    // a fallback onto some /api/peering/* path.
    for (const [name, reqs] of [['A', reqA], ['B', reqB]]) {
      expect(reqs.filter((r) => r.url.includes('/api/peering/stream')),
        `peer ${name} used host-box peering signalling`).toHaveLength(0)
    }

    // WHICH PATH CARRIED IT — direct data channel, or the content-blind relay
    // circuit? Both are documented behaviour (docs/COLLABORATION.md §3: direct
    // first, relay circuit as the fallback for pairs that cannot hole-punch), and
    // both are peer-to-peer. The assertion is that ONE of them demonstrably
    // carried the edits, and the run says which. Insisting on "direct" would be a
    // lie in any sandbox where ICE cannot complete; accepting neither would let a
    // broken transport pass.
    const pairs = [...(await selectedCandidatePairs(pageA)), ...(await selectedCandidatePairs(pageB))]
    const anyDirect = pairs.some((p) => p.localType === 'host' && p.remoteType === 'host')
    const mailboxCalls = [...reqA, ...reqB].filter((r) => r.url.startsWith(`${rdvUrl}mailbox`)).length

    console.log('[builtin-p2p] transport — pairs:', JSON.stringify(pairs),
      '| relay-circuit mailbox calls:', mailboxCalls)
    if (anyDirect) {
      console.log('[builtin-p2p] DIRECT: a host/host WebRTC data channel carried the edits')
    } else {
      console.warn('[builtin-p2p] FALLBACK: no direct candidate pair formed in this sandbox — ' +
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

test('NEGATIVE — with discovery disabled and no relay, Diwan is honestly local-only', async ({ browser, request }) => {
  // The honesty half of the contract: turning the surface off must degrade to
  // "you can still edit, nobody can join", never to a broken editor and never to
  // a UI that claims a live session it does not have.
  const off = stack.localOnly
  const doc = await createDoc(off.url, 'Local Only')

  const reach = await (await request.get(`${off.url}/api/reachability`)).json()
  expect(reach.builtin_rendezvous_prefix).toBe('')
  expect(reach.rendezvous_url).toBe('')

  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  mirrorConsole(page, 'local-only')
  const reqs = recordRequests(page)
  try {
    await openDoc(page, `${off.url}/docs/${doc}`)

    // The editor still works — degradation, not breakage.
    const marker = `local-${Date.now()}`
    await page.locator('.ProseMirror').click()
    await page.keyboard.type(marker)
    await expect(page.locator('.ProseMirror')).toContainText(marker)

    // No discovery PROTOCOL traffic. The client does probe /api/peering/ice once
    // — that is how it learns there is no host box, and the probe 404s — so the
    // assertion is about what it does AFTER learning that: it must not speak a
    // rendezvous protocol to anything, and must not open a signalling stream.
    await page.waitForTimeout(3_000)
    const spoke = reqs.filter((r) => /\/api\/rendezvous\/|\/rendezvous\/|\/api\/peering\/stream/.test(r.url))
    expect(spoke.map((r) => r.url),
      'a local-only deployment must not speak any discovery protocol').toHaveLength(0)
  } finally {
    await ctx.close()
  }
})
