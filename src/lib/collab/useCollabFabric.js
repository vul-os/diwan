// no-broker-dep:allow-file: names Pier once, describing unchanged default behaviour when a
// Vulos OS/Pier host is in front of Diwan — an optional case in the priority chain
// transportSelection.js implements, not a default or an import.
/**
 * src/lib/collab/useCollabFabric.js — shared FabricClient lifecycle hook
 * (WAVE-27).
 *
 * Docs gets live presence because its collab session owns and joins a
 * FabricClient, then exposes it (`.fabric`) to useLiveCursors + usePresence.
 * Sheets (GridSession) and Slides (TreeSession) already accept a
 * `fabricClient`, but the editors passed `null`, so they had CRDT logic but no
 * transport — hence `fabric: null` into useLiveCursors and an empty roster.
 *
 * This hook centralises that lifecycle so Sheets and Slides light up presence
 * the same way Docs does, WITHOUT reinventing transport:
 *
 *   1. Create a FabricClient (same defaults as Docs' session — origin-derived
 *      signaling URL, /api/peering/ice, same-origin relay).
 *   2. join() it; track joined/peer-state so the status pill can reflect Live /
 *      Reconnecting / Offline.
 *   3. Hand the SAME fabric to the caller so it can (a) wire it into the CRDT
 *      session for op sync and (b) feed useLiveCursors + usePresence.
 *
 * Fails graceful: if join() rejects (no transport reachable, offline,
 * single-user), the editor keeps working locally — we simply surface an
 * `offline` status and an empty roster. No throws escape the hook.
 *
 * ADDITIVE & sync-safe: this hook does NOT change how ops are diffed/applied.
 * It only provisions the transport the existing CRDT session was already
 * designed to consume. When no transport is reachable, behaviour is identical
 * to the previous `fabricClient: null` path (local-only).
 *
 * HONESTY GUARD — three-way reality (see docs/COLLABORATION.md §3):
 *
 *   1. HOST-BOX PEERING — this server mounts `/api/peering/*` (Vulos OS /
 *      Pier in front of Diwan). Unchanged default behaviour.
 *   2. ANY RELAYD RENDEZVOUS — no host-box peering, but this deployment has a
 *      configured rendezvous URL (config.yaml `collab.rendezvous_url` /
 *      VULOS_RENDEZVOUS_URL). The browser talks DIRECTLY to that relayd's
 *      open rendezvous surface — no Vulos OS, no host box required at all.
 *      This is what makes a STANDALONE Diwan capable of real P2P collab.
 *   3. LOCAL-ONLY — neither is available.
 *
 * A standalone Office binary never mounts `/api/peering/*` (see main.go), but
 * FabricClient.join() resolves anyway — it fire-and-forgets the signaling
 * WebSocket connect and its ICE fetch silently falls back on a 404. Without a
 * check, `configured`/`joined` would flip true regardless, and the
 * Sheets/Slides status pill (deriveStatusPill in presenceCommon.js) would
 * settle on a false-positive "Live" for a session nobody can ever join. So we
 * resolve transportSelection.js's three-way choice BEFORE constructing a
 * FabricClient at all: on `local-only` we never construct one and `configured`
 * stays `false` — an honest, calm "Offline" — for the life of the mount. On
 * `rendezvous` we construct a genuinely-reachable transport with NO host box
 * in the loop, so `configured`/`joined` are just as true as in host-peering
 * mode — there is no second-class "fake connected" state here.
 */

import { useEffect, useRef, useState } from 'react'
import { FabricClient } from './webrtc/fabric.js'
import {
  selectCollabTransport,
  TRANSPORT_LOCAL_ONLY,
} from './transportSelection.js'

/**
 * @param {object} opts
 * @param {string}  opts.sessionId  - file id (fabric session key)
 * @param {string}  opts.peerId     - stable per-tab id (CRDT replicaId)
 * @param {boolean} [opts.enabled=true] - set false to stay fully local (no fabric)
 * @returns {{
 *   fabric: import('./webrtc/fabric.js').FabricClient | null,
 *   peers: Record<string, string>,
 *   joined: boolean,
 *   configured: boolean,
 * }}
 */
export function useCollabFabric({ sessionId, peerId, enabled = true }) {
  const [fabric, setFabric] = useState(null)
  const [peers, setPeers] = useState({})       // peerId → state
  const [joined, setJoined] = useState(false)
  const [configured, setConfigured] = useState(false)
  const fabricRef = useRef(null)

  useEffect(() => {
    if (!enabled || !sessionId || !peerId) return
    if (typeof window === 'undefined') return

    let cancelled = false
    let client = null
    let onState = null

    const wsBase = window.location.origin.replace(/^http/, 'ws') + '/api/peering/stream'

    ;(async () => {
      // Resolve the three-way transport choice BEFORE constructing anything —
      // see the HONESTY GUARD note above. On `local-only` we never touch
      // FabricClient at all: configured/joined stay false, giving an honest,
      // calm "Offline" pill instead of a false "Live".
      const { transport, rendezvousBaseUrl, rendezvousPrefix } = await selectCollabTransport()
      if (cancelled) return
      if (transport === TRANSPORT_LOCAL_ONLY) {
        console.info('[collab] no reachable transport for this session ' +
          '(no host-box peering, no rendezvous URL configured, or offline) — ' +
          'presence/live-sync unavailable; editor stays local-only')
        return
      }

      try {
        client = new FabricClient({
          sessionId,
          peerId,
          signalingUrl: wsBase,
          iceUrl: '/api/peering/ice',
          relayBaseUrl: '',
          authToken: null,
          // Set only in `rendezvous` mode — the FabricClient itself treats a
          // non-empty rendezvousBaseUrl as "run the whole signaling lifecycle
          // against this relayd instead of /api/peering/*", derives its own
          // ICE from the relay, and ignores signalingUrl/iceUrl above.
          rendezvousBaseUrl,
          ...(rendezvousPrefix ? { rendezvousPrefix } : {}),
        })
      } catch (err) {
        // FabricClient construction should not throw, but never let it break the
        // editor — degrade to local-only.
        console.warn('[collab] fabric init failed (local-only mode):', err?.message)
        return
      }
      if (cancelled) { try { client.leave() } catch { /* ignore */ }; return }

      fabricRef.current = client
      setFabric(client)
      setConfigured(true)

      onState = (ev) => {
        if (cancelled) return
        const { peerId: pid, state } = ev.detail || {}
        if (!pid) return
        setPeers((prev) => ({ ...prev, [pid]: state }))
      }
      client.addEventListener('state', onState)

      client.join()
        .then(() => { if (!cancelled) setJoined(true) })
        .catch((err) => {
          // No peering backend / offline / single-user — this is expected and
          // non-fatal. Presence stays empty; the editor is unaffected.
          console.warn('[collab] fabric join failed (single-user mode):', err?.message)
          if (!cancelled) { setJoined(false); setConfigured(false) }
        })
    })()

    return () => {
      cancelled = true
      if (client) {
        if (onState) client.removeEventListener('state', onState)
        try { client.leave() } catch { /* ignore */ }
      }
      fabricRef.current = null
      setFabric(null)
      setPeers({})
      setJoined(false)
      setConfigured(false)
    }
  }, [sessionId, peerId, enabled])

  return { fabric, peers, joined, configured }
}
