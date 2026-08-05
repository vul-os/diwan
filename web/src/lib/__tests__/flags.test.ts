/**
 * flags.test.js — the DEFAULTS of the deploy-time flags, pinned.
 *
 * A default is a decision about what every real user gets, and it is the kind of
 * decision that drifts silently: someone flips a boolean while chasing a bug and
 * nothing fails. Two of these defaults are load-bearing claims about the product:
 *
 *   • substrateSyncEnabled() — Sheets runs on the SHARED KOTVA Sync engine.
 *     Shipping that engine behind an off-by-default flag meant it was present but
 *     was not the path anyone took, which reads as adoption without being it.
 *   • docsCollabEnabled() — live co-editing is available unless an operator turns
 *     it off.
 *
 * The parser is tested alongside them, because "off"/"0"/"false" are how an
 * operator exercises the escape hatch and a flag that ignored them would be a
 * setting that silently does nothing.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { docsCollabEnabled, updateLogEnabled, substrateSyncEnabled } from '../flags.js'

/**
 * The flags read `import.meta.env` first and `process.env` second. Under Vitest
 * `import.meta.env` exists but carries no VITE_* value for these names, so
 * process.env is what the accessor falls through to — which is what lets a test
 * set one.
 */
function withEnv<T>(name: string, value: string | undefined, fn: () => T): T {
  const had = Object.prototype.hasOwnProperty.call(process.env, name)
  const prev = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  try {
    return fn()
  } finally {
    if (had) process.env[name] = prev
    else delete process.env[name]
  }
}

afterEach(() => { vi.unstubAllEnvs() })

describe('flag defaults', () => {
  it('runs Sheets on the SHARED substrate engine by default', () => {
    // If this ever reads false again, Diwan's Sheets converge because a private
    // re-implementation is self-consistent rather than because two replicas run
    // the same vector-pinned algebra. That is the whole point of adopting it.
    expect(substrateSyncEnabled()).toBe(true)
  })

  it('leaves live co-editing on by default', () => {
    expect(docsCollabEnabled()).toBe(true)
  })

  it('leaves the CRDT-native update log off by default', () => {
    // Additive durability that a deployment opts into together with the server
    // flag; on by default it would make requests every deployment did not ask for.
    expect(updateLogEnabled()).toBe(false)
  })
})

describe('flag parsing', () => {
  it('honours every documented spelling of "off" for the substrate flag', () => {
    for (const raw of ['off', '0', 'false', 'no', 'OFF', ' Off ']) {
      withEnv('VITE_SUBSTRATE_SYNC', raw, () => {
        expect(substrateSyncEnabled(), `VITE_SUBSTRATE_SYNC=${JSON.stringify(raw)}`).toBe(false)
      })
    }
  })

  it('honours every documented spelling of "on"', () => {
    for (const raw of ['on', '1', 'true', 'yes', 'TRUE']) {
      withEnv('VITE_DOCS_COLLAB', raw, () => {
        expect(docsCollabEnabled(), `VITE_DOCS_COLLAB=${JSON.stringify(raw)}`).toBe(true)
      })
      withEnv('VITE_UPDATE_LOG', raw, () => {
        expect(updateLogEnabled(), `VITE_UPDATE_LOG=${JSON.stringify(raw)}`).toBe(true)
      })
    }
  })

  it('falls back to the default for an empty or unrecognised value', () => {
    // A typo must not silently flip a deployment-wide merge-engine choice.
    for (const raw of ['', '   ', 'maybe', 'ON!', '2']) {
      withEnv('VITE_SUBSTRATE_SYNC', raw, () => {
        expect(substrateSyncEnabled(), `VITE_SUBSTRATE_SYNC=${JSON.stringify(raw)}`).toBe(true)
      })
      withEnv('VITE_UPDATE_LOG', raw, () => {
        expect(updateLogEnabled(), `VITE_UPDATE_LOG=${JSON.stringify(raw)}`).toBe(false)
      })
    }
  })
})
