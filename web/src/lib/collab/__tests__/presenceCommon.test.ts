/**
 * presenceCommon.test.ts — WAVE-27 collaboration-presence pure helpers.
 *
 * Covers the transport-agnostic logic that drives the Sheets/Slides presence
 * roster projection, local-identity derivation, and status-pill state mapping.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  getCollabIdentity,
  identityColor,
  countLivePeers,
  deriveStatusPill,
} from '../presenceCommon.js'

describe('countLivePeers', () => {
  it('counts only connected/relay peers', () => {
    expect(countLivePeers({ a: 'connected', b: 'relay', c: 'connecting' })).toBe(2)
  })
  it('returns 0 for empty / null', () => {
    expect(countLivePeers({})).toBe(0)
    expect(countLivePeers(null)).toBe(0)
    expect(countLivePeers(undefined)).toBe(0)
  })
  it('ignores transient/failed states', () => {
    expect(countLivePeers({ a: 'new', b: 'failed', c: 'disconnected' })).toBe(0)
  })
})

describe('deriveStatusPill — status-pill state mapping', () => {
  it('readOnly overrides everything → View only (muted)', () => {
    const p = deriveStatusPill({ configured: true, joined: true, peers: { x: 'connected' }, readOnly: true })
    expect(p).toEqual({ status: 'readonly', label: 'View only', tone: 'muted' })
  })

  it('no collab backend configured → Offline (muted, never danger)', () => {
    const p = deriveStatusPill({ configured: false, joined: false, peers: {} })
    expect(p.status).toBe('offline')
    expect(p.label).toBe('Offline')
    expect(p.tone).toBe('muted')
  })

  it('configured but not yet joined, no peers → Connecting', () => {
    const p = deriveStatusPill({ configured: true, joined: false, peers: {} })
    expect(p.status).toBe('connecting')
    expect(p.label).toBe('Connecting…')
  })

  it('joined with no peers → solo but calm "Live" (success)', () => {
    const p = deriveStatusPill({ configured: true, joined: true, peers: {} })
    expect(p.status).toBe('solo')
    expect(p.label).toBe('Live')
    expect(p.tone).toBe('success')
  })

  it('one connected peer → Live (success)', () => {
    const p = deriveStatusPill({ configured: true, joined: true, peers: { a: 'connected' } })
    expect(p.status).toBe('live')
    expect(p.label).toBe('Live')
    expect(p.tone).toBe('success')
  })

  it('relay peer counts as Live', () => {
    const p = deriveStatusPill({ configured: true, joined: true, peers: { a: 'relay' } })
    expect(p.status).toBe('live')
  })

  it('joined, peer went pending (dropped) → Reconnecting (warning)', () => {
    const p = deriveStatusPill({ configured: true, joined: true, peers: { a: 'reconnecting' } })
    expect(p.status).toBe('reconnecting')
    expect(p.label).toBe('Reconnecting…')
    expect(p.tone).toBe('warning')
  })

  it('a live peer alongside a pending one still reads Live', () => {
    const p = deriveStatusPill({
      configured: true, joined: true, peers: { a: 'connected', b: 'connecting' },
    })
    expect(p.status).toBe('live')
  })

  it('engineMismatch outranks EVERYTHING and is the only danger tone', () => {
    // The mismatch case is the one where the transport is perfectly healthy —
    // joined, peers connected — and the document still cannot converge. If it
    // did not outrank 'live' the pill would read "Live" forever while nothing
    // merged, which is exactly the silence this state exists to break.
    expect(deriveStatusPill({
      configured: true, joined: true, peers: { p1: 'connected' }, engineMismatch: true,
    })).toEqual({ status: 'mismatch', label: 'Not syncing', tone: 'danger' })

    // Including over readOnly: a view-only peer in a mismatched room is still in
    // a room that will not converge.
    expect(deriveStatusPill({
      configured: true, joined: true, readOnly: true, engineMismatch: true,
    }).status).toBe('mismatch')
  })

  it('engineMismatch defaults false, so every existing caller is unchanged', () => {
    expect(deriveStatusPill({ configured: true, joined: true, peers: { p1: 'connected' } }))
      .toEqual({ status: 'live', label: 'Live', tone: 'success' })
  })

  it('empty opts defaults to offline', () => {
    expect(deriveStatusPill().status).toBe('offline')
  })
})

describe('getCollabIdentity', () => {
  const realLocal = globalThis.localStorage
  const realSession = globalThis.sessionStorage

  function mkStore(): Storage {
    const m = new Map<string, string>()
    return {
      getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
      setItem: (k: string, v: string) => { m.set(k, String(v)) },
      removeItem: (k: string) => { m.delete(k) },
      clear: () => { m.clear() },
      key: (i: number) => [...m.keys()][i] ?? null,
      get length() { return m.size },
    }
  }

  beforeEach(() => {
    globalThis.localStorage = mkStore()
    globalThis.sessionStorage = mkStore()
  })
  afterEach(() => {
    globalThis.localStorage = realLocal
    globalThis.sessionStorage = realSession
  })

  it('prefers a signed-in account identity', () => {
    localStorage.setItem('presence_identity', JSON.stringify({ accountId: 'acct-42', displayName: 'Ada' }))
    const id = getCollabIdentity('replica-1')
    expect(id.accountId).toBe('acct-42')
    expect(id.displayName).toBe('Ada')
    expect(id.isGuest).toBeUndefined()
  })

  it('falls back to a guest identity keyed off the peer id', () => {
    const id = getCollabIdentity('replica-abc')
    expect(id.accountId).toBe('guest:replica-abc')
    expect(id.isGuest).toBe(true)
    expect(id.displayName).toBe('Me')
  })

  it('tolerates a corrupt identity blob (falls back to guest)', () => {
    localStorage.setItem('presence_identity', '{not json')
    const id = getCollabIdentity('rep')
    expect(id.accountId).toBe('guest:rep')
    expect(id.isGuest).toBe(true)
  })

  it('is deterministic for the same peer id', () => {
    expect(getCollabIdentity('same')).toEqual(getCollabIdentity('same'))
  })
})

describe('identityColor', () => {
  it('returns a stable colour string for a given accountId', () => {
    const c1 = identityColor({ accountId: 'peer-x' })
    const c2 = identityColor({ accountId: 'peer-x' })
    expect(c1).toBe(c2)
    expect(typeof c1).toBe('string')
    expect(c1.length).toBeGreaterThan(0)
  })

  it('different ids generally map to different colours', () => {
    expect(identityColor({ accountId: 'aaaa' })).not.toBe(identityColor({ accountId: 'zzzz' }))
  })

  it('handles a null identity without throwing', () => {
    expect(() => identityColor(null)).not.toThrow()
  })
})
