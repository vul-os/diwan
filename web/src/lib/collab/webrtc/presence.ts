/**
 * presence.ts — Diwan Presence layer (OFFICE-24).
 *
 * Broadcasts {accountId, displayName, color, online} over a dedicated
 * "presence" channel on the OFFICE-20 FabricClient (separate from CRDT ops).
 *
 * Usage:
 *   const pm = new PresenceManager({ fabric, localIdentity })
 *   pm.addEventListener('roster', ({ detail: peers }) => …)
 *   pm.join()
 *   pm.leave()
 *
 * Identity resolution order:
 *   1. opts.localIdentity (caller-supplied, from Vulos account/vumail)
 *   2. localStorage "presence_identity" (persisted guest identity)
 *   3. Generated guest identity (random name + color, persisted)
 */

const PRESENCE_CHANNEL = 'presence'
const HEARTBEAT_MS = 10_000        // send heartbeat every 10 s
const TIMEOUT_MS = 25_000          // drop peer after 25 s of silence

// Valid status values for OFFICE-62
export const STATUS_ONLINE = 'online'
export const STATUS_AWAY   = 'away'
export const STATUS_DND    = 'dnd'
export const STATUS_IN_CALL = 'in-a-call'  // set by OFFICE-63 calling layer

export type PresenceStatus =
  | typeof STATUS_ONLINE
  | typeof STATUS_AWAY
  | typeof STATUS_DND
  | typeof STATUS_IN_CALL

/** Caller-supplied local identity (Vulos account/vumail), or omitted for a guest. */
export interface LocalIdentityInput {
  accountId?: string
  displayName?: string
  isGuest?: boolean
}

/** The persisted/generated shape read back from localStorage or freshly minted. */
interface StoredIdentity {
  accountId: string
  displayName: string
  isGuest: boolean
}

/** This client's own presence record. */
interface LocalPresence {
  accountId: string
  displayName: string
  color: string
  online: boolean
  status: PresenceStatus
  statusText: string
  isGuest: boolean
  ts: number
}

/** A remote peer's presence record, as kept in the roster. */
export interface RosterPeer {
  accountId: string
  displayName: string
  color: string
  online: boolean
  status: PresenceStatus
  statusText: string
  isGuest: boolean
  ts: number
  peerId: string
}

/** The local record with `isSelf: true`, as returned by `fullRoster`. */
export type FullRosterPeer = (LocalPresence & { isSelf: true }) | RosterPeer

/** Wire shape of a presence frame's payload (untrusted — parsed from a peer message). */
interface PresenceFramePayload {
  type?: 'join' | 'leave'
  accountId?: string
  displayName?: string
  color?: string
  status?: PresenceStatus
  statusText?: string
  isGuest?: boolean
}

/** Structural subset of FabricClient's event surface this module depends on. */
export interface PresenceFabric {
  addEventListener(
    type: 'message',
    listener: (ev: CustomEvent<{ from: string, data: string | ArrayBuffer | Uint8Array }>) => void,
  ): void
  addEventListener(
    type: 'state',
    listener: (ev: CustomEvent<{ peerId: string, state: string }>) => void,
  ): void
  removeEventListener(
    type: 'message',
    listener: (ev: CustomEvent<{ from: string, data: string | ArrayBuffer | Uint8Array }>) => void,
  ): void
  removeEventListener(
    type: 'state',
    listener: (ev: CustomEvent<{ peerId: string, state: string }>) => void,
  ): void
  send(data: string): void
}

/** Deterministic color from a string (stable across sessions). */
function colorFromString(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i)
    hash |= 0
  }
  const hue = Math.abs(hash) % 360
  return `hsl(${hue}, 65%, 50%)`
}

const GUEST_ADJECTIVES = ['Swift', 'Bright', 'Calm', 'Bold', 'Kind']
const GUEST_ANIMALS = ['Lemur', 'Falcon', 'Otter', 'Fox', 'Lynx']

function randomGuestName(): string {
  const adj = GUEST_ADJECTIVES[Math.floor(Math.random() * GUEST_ADJECTIVES.length)]
  const ani = GUEST_ANIMALS[Math.floor(Math.random() * GUEST_ANIMALS.length)]
  return `${adj} ${ani}`
}

function loadOrCreateLocalIdentity(): StoredIdentity {
  try {
    const stored = localStorage.getItem('presence_identity')
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<StoredIdentity>
      if (parsed.accountId && parsed.displayName) {
        return { accountId: parsed.accountId, displayName: parsed.displayName, isGuest: parsed.isGuest ?? true }
      }
    }
  } catch { /* ignore */ }
  const identity: StoredIdentity = {
    accountId: `guest:${crypto.randomUUID()}`,
    displayName: randomGuestName(),
    isGuest: true,
  }
  try { localStorage.setItem('presence_identity', JSON.stringify(identity)) } catch { /* ignore */ }
  return identity
}

export class PresenceManager extends EventTarget {
  private _fabric: PresenceFabric
  private _local: LocalPresence
  private _roster: Map<string, RosterPeer>
  private _heartbeatTimer: ReturnType<typeof setInterval> | null
  private _gcTimer: ReturnType<typeof setInterval> | null
  private _stopped: boolean
  private _onFabricMessage: (ev: CustomEvent<{ from: string, data: string | ArrayBuffer | Uint8Array }>) => void
  private _onFabricState: (ev: CustomEvent<{ peerId: string, state: string }>) => void

  /**
   * @param opts.fabric  a live FabricClient (webrtc/fabric.ts)
   * @param opts.localIdentity  pass the Vulos account identity if
   *   authenticated; omit for guest.
   */
  constructor({ fabric, localIdentity = null }: { fabric: PresenceFabric, localIdentity?: LocalIdentityInput | null }) {
    super()
    this._fabric = fabric

    const baseIdentity = (localIdentity?.accountId && localIdentity?.displayName)
      ? { accountId: localIdentity.accountId, displayName: localIdentity.displayName, isGuest: localIdentity.isGuest ?? false }
      : loadOrCreateLocalIdentity()
    this._local = {
      accountId: baseIdentity.accountId,
      displayName: baseIdentity.displayName,
      color: colorFromString(baseIdentity.accountId),
      online: true,
      status: STATUS_ONLINE,    // OFFICE-62: online | away | dnd | in-a-call
      statusText: '',           // OFFICE-62: free-text custom status
      isGuest: baseIdentity.isGuest ?? false,
      ts: Date.now(),
    }

    this._roster = new Map()
    this._heartbeatTimer = null
    this._gcTimer = null
    this._stopped = false

    // Listen for presence frames on the fabric message channel.
    this._onFabricMessage = this._handleMessage.bind(this)
    this._fabric.addEventListener('message', this._onFabricMessage)

    // Also re-broadcast on new peer connections so late joiners see us immediately.
    this._onFabricState = this._handleState.bind(this)
    this._fabric.addEventListener('state', this._onFabricState)
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /** Start presence: broadcast join + begin heartbeat. */
  join(): void {
    this._broadcast()
    this._heartbeatTimer = setInterval(() => this._broadcast(), HEARTBEAT_MS)
    this._gcTimer = setInterval(() => this._gc(), HEARTBEAT_MS)
  }

  /**
   * OFFICE-62: Update local status and broadcast immediately.
   * @param status  one of STATUS_ONLINE | STATUS_AWAY | STATUS_DND | STATUS_IN_CALL
   * @param text    optional free-text custom status
   */
  setStatus(status: PresenceStatus, text = ''): void {
    this._local.status = status || STATUS_ONLINE
    this._local.statusText = text || ''
    this._broadcast()
  }

  /** Stop presence: broadcast leave, clear timers. */
  leave(): void {
    this._stopped = true
    if (this._heartbeatTimer !== null) clearInterval(this._heartbeatTimer)
    if (this._gcTimer !== null) clearInterval(this._gcTimer)
    this._broadcastLeave()
    this._fabric.removeEventListener('message', this._onFabricMessage)
    this._fabric.removeEventListener('state', this._onFabricState)
  }

  /** Current roster snapshot (excludes self). Array of peer identity objects. */
  get roster(): RosterPeer[] {
    return [...this._roster.values()]
  }

  /** Full roster including the local user. */
  get fullRoster(): FullRosterPeer[] {
    return [{ ...this._local, isSelf: true }, ...this.roster]
  }

  // ─── Internal ───────────────────────────────────────────────────────────────

  private _broadcast(): void {
    if (this._stopped) return
    this._local.ts = Date.now()
    this._sendPresenceFrame({ ...this._local, type: 'join' })
  }

  private _broadcastLeave(): void {
    this._sendPresenceFrame({ ...this._local, type: 'leave' })
  }

  private _sendPresenceFrame(payload: LocalPresence & { type: 'join' | 'leave' }): void {
    const frame = JSON.stringify({ channel: PRESENCE_CHANNEL, payload })
    this._fabric.send(frame)
  }

  private _handleMessage(ev: CustomEvent<{ from: string, data: string | ArrayBuffer | Uint8Array }>): void {
    const { from, data } = ev.detail
    let text: string
    try {
      text = typeof data === 'string' ? data : new TextDecoder().decode(data)
    } catch { return }
    let frame: { channel?: string, payload?: PresenceFramePayload }
    try { frame = JSON.parse(text) } catch { return }
    if (frame.channel !== PRESENCE_CHANNEL) return
    const p = frame.payload
    if (!p || !p.accountId || p.accountId === this._local.accountId) return

    if (p.type === 'leave') {
      this._roster.delete(p.accountId)
    } else {
      this._roster.set(p.accountId, {
        accountId: p.accountId,
        displayName: p.displayName || 'Unknown',
        color: p.color || colorFromString(p.accountId),
        online: true,
        status: p.status || STATUS_ONLINE,          // OFFICE-62
        statusText: p.statusText || '',              // OFFICE-62
        isGuest: p.isGuest ?? false,
        ts: Date.now(),
        peerId: from,
      })
    }
    this._emitRoster()
  }

  private _handleState(ev: CustomEvent<{ peerId: string, state: string }>): void {
    // Re-announce ourselves whenever a new peer connects.
    const { state } = ev.detail
    if (state === 'connected' || state === 'relay') {
      this._broadcast()
    }
  }

  /** Remove peers that haven't sent a heartbeat within TIMEOUT_MS. */
  private _gc(): void {
    const now = Date.now()
    let changed = false
    for (const [id, peer] of this._roster) {
      if (now - peer.ts > TIMEOUT_MS) {
        this._roster.delete(id)
        changed = true
      }
    }
    if (changed) this._emitRoster()
  }

  private _emitRoster(): void {
    this.dispatchEvent(new CustomEvent('roster', { detail: this.fullRoster }))
  }
}

// ─── React hook ─────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react'

/**
 * usePresence — React hook that manages a PresenceManager lifecycle.
 *
 * Returns the full roster (including self with isSelf=true) while the fabric
 * is live; returns [] when fabric is null (editor opened without collab).
 * OFFICE-62: also returns manager so callers can call manager.setStatus(status, text).
 */
export function usePresence(
  { fabric, localIdentity = null }: { fabric: PresenceFabric | null | undefined, localIdentity?: LocalIdentityInput | null },
): { roster: FullRosterPeer[], manager: PresenceManager | null } {
  const [roster, setRoster] = useState<FullRosterPeer[]>([])
  const pmRef = useRef<PresenceManager | null>(null)

  useEffect(() => {
    if (!fabric) {
      setRoster([])
      return
    }

    const pm = new PresenceManager({ fabric, localIdentity })
    pmRef.current = pm

    const onRoster = (ev: Event) => setRoster((ev as CustomEvent<FullRosterPeer[]>).detail)
    pm.addEventListener('roster', onRoster)
    pm.join()

    return () => {
      pm.removeEventListener('roster', onRoster)
      pm.leave()
      pmRef.current = null
    }
  }, [fabric]) // eslint-disable-line react-hooks/exhaustive-deps

  return { roster, manager: pmRef.current }
}
