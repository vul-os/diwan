/**
 * helpers.ts — browser-side instrumentation shared by both P2P suites.
 *
 * Extracted so the built-in-surface suite and the external-relay suite make the
 * SAME observations about the SAME things. Two copies of "which candidate pair
 * won" would eventually disagree, and the disagreement would be invisible.
 */

import { expect, type Page } from '@playwright/test'

// addInitScript's callback runs in the page, not this module — but it's
// authored here, so the browser globals it reaches for need declaring.
declare global {
  interface Window {
    __pcs?: RTCPeerConnection[]
  }
}

export interface CandidatePair {
  state: RTCPeerConnectionState
  localType: string
  remoteType: string
}

export interface RecordedRequest {
  method: string
  url: string
  postData: string | null
}

/**
 * Instrument a page BEFORE any script runs so we can (a) see every
 * RTCPeerConnection it creates and (b) ask, at the end, whether the connection
 * that carried the edits was a DIRECT host-to-host pair or a relayed one.
 */
export async function instrumentWebRTC(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__pcs = []
    const Native = window.RTCPeerConnection
    if (!Native) return
    window.RTCPeerConnection = class extends Native {
      constructor(...args: ConstructorParameters<typeof Native>) {
        super(...args)
        window.__pcs?.push(this)
      }
    }
    window.RTCPeerConnection.prototype = Native.prototype
  })
}

/**
 * Ask the page's live peer connections which ICE candidate pair actually
 * succeeded. Returns one entry per connected peer connection:
 *   { state, localType, remoteType }
 * localType 'host' on both ends == a genuinely direct browser-to-browser
 * channel; 'relay' == a TURN-relayed circuit.
 */
// lib.dom's RTCStats base type only models { id, timestamp, type } — the
// vendor/spec-optional candidate-pair and candidate fields below are real
// (WebRTC stats API) but not part of TypeScript's ambient DOM types, so this
// records the exact shape this function actually reads off each report entry.
interface CandidatePairStatsShape {
  id: string
  type: string
  selected?: boolean
  state?: string
  nominated?: boolean
  localCandidateId?: string
  remoteCandidateId?: string
}
interface CandidateStatsShape {
  id: string
  type: string
  candidateType?: string
}

export function selectedCandidatePairs(page: Page): Promise<CandidatePair[]> {
  return page.evaluate(async () => {
    const out: { state: RTCPeerConnectionState; localType: string; remoteType: string }[] = []
    for (const pc of window.__pcs || []) {
      if (pc.connectionState !== 'connected') continue
      try {
        const stats = await pc.getStats()
        let pair: CandidatePairStatsShape | null = null
        const cands = new Map<string, CandidateStatsShape>()
        stats.forEach((r: CandidatePairStatsShape & CandidateStatsShape) => {
          if (r.type === 'local-candidate' || r.type === 'remote-candidate') cands.set(r.id, r)
          if (r.type === 'candidate-pair') {
            if (r.selected || r.state === 'succeeded' || r.nominated) {
              if (!pair || r.selected) pair = r
            }
          }
        })
        if (!pair) continue
        const chosen: CandidatePairStatsShape = pair
        out.push({
          state: pc.connectionState,
          localType: (chosen.localCandidateId && cands.get(chosen.localCandidateId)?.candidateType) || 'unknown',
          remoteType: (chosen.remoteCandidateId && cands.get(chosen.remoteCandidateId)?.candidateType) || 'unknown',
        })
      } catch { /* stats unavailable on this connection */ }
    }
    return out
  })
}

/** Mirror a page's console into the test output — collab failures are almost
 * always visible there ("[p2p] …", "[collab] …") and a silent page makes a
 * convergence timeout impossible to diagnose. */
export function mirrorConsole(page: Page, tag: string): void {
  page.on('console', (msg) => {
    const t = msg.text()
    // P2P_E2E_VERBOSE=1 mirrors everything; by default only collab-relevant lines.
    if (process.env.P2P_E2E_VERBOSE || /\[p2p\]|\[collab\]|rendezvous|fabric|peer/i.test(t)) {
      console.log(`[${tag}] ${msg.type()}: ${t}`)
    }
  })
  page.on('pageerror', (err) => console.log(`[${tag}] pageerror: ${err.message}`))
}

/** Record every request a page makes, so we can assert on the transport after. */
export function recordRequests(page: Page): RecordedRequest[] {
  const seen: RecordedRequest[] = []
  page.on('request', (req) => seen.push({ method: req.method(), url: req.url(), postData: req.postData() }))
  page.on('websocket', (ws) => seen.push({ method: 'WS', url: ws.url(), postData: null }))
  return seen
}

/** Wait for the editor of a Diwan docs page to be interactive. */
export async function openDoc(page: Page, url: string): Promise<void> {
  await page.goto(url)
  await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 60_000 })
}

/** Mint a read-write invite link from the share UI. */
export async function mintInviteLink(page: Page): Promise<string> {
  await page.getByRole('button', { name: /Share — with people/i }).click()
  await page.getByRole('button', { name: /Share via link \(P2P\)/i }).click()
  await expect(page.getByText('Editor link')).toBeVisible({ timeout: 30_000 })
  const rw: string | undefined = await page.locator('input[readonly]').evaluateAll(
    (els) => (els as HTMLInputElement[]).map((e) => e.value).filter((v) => /#vp2p=/.test(v))[0],
  )
  expect(rw, 'the share modal must produce a #vp2p= invite link').toMatch(/#vp2p=/)
  // Close the modal so it does not sit over the editor while we type.
  await page.keyboard.press('Escape')
  return rw as string
}
