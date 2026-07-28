/**
 * dmtap-sync-wasm — loader for the vendored DMTAP Sync substrate binding.
 *
 * The upstream `pkg/` is a wasm-pack **bundler**-target package whose entry
 * (`dmtap_sync.js`) does `import * as wasm from './dmtap_sync_bg.wasm'`. That is
 * an ESM-imports-WASM statement, which needs a bundler plugin in Vite and does
 * not work at all under Vitest/node. Rather than add a plugin (and a second,
 * divergent path for tests), this loader instantiates the module itself.
 *
 * That is safe and lossless, because the wasm-pack glue is deliberately split:
 *   • `dmtap_sync_bg.js` — ALL the JS-side wrappers and the host functions the
 *     module imports. Target-independent. Exports `__wbg_set_wasm(exports)`.
 *   • `dmtap_sync_bg.wasm` — the compiled core. It declares exactly ONE import
 *     module, `'./dmtap_sync_bg.js'` (3 imports total).
 *   • `dmtap_sync.js` — 8 lines of target-specific wiring: instantiate, call
 *     `__wbg_set_wasm`, call `__wbindgen_start`, re-export.
 *
 * Only the last file is target-specific, and this module is a faithful,
 * environment-agnostic replacement for it. The `.wasm` and the wrappers are the
 * upstream artifacts BYTE-FOR-BYTE — there is no re-implementation here, which
 * is the whole point of adopting a shared engine.
 *
 * Usage:
 *
 *   import { loadSync } from 'dmtap-sync-wasm'
 *   const sync = await loadSync()          // idempotent; one instance per process
 *   const engine = new sync.SyncEngine()
 *
 * Every call on the returned namespace is SYNCHRONOUS (the upstream README's
 * contract); only this one-time load is async.
 */

let modulePromise = null

const WASM_FILE = 'dmtap_sync_bg.wasm'

/** True under Node and Vitest; false in a real browser. */
function isNode() {
  return typeof process !== 'undefined' && !!process.versions && !!process.versions.node
}

/**
 * Read the vendored `.wasm` as bytes.
 *
 * The two environments need genuinely different resolution, and the branch is
 * on the ENVIRONMENT rather than on the resulting URL's scheme — because the
 * URL is not the same expression in both.
 *
 * • Browser. `new URL('…', import.meta.url)` written as a static literal is the
 *   form Vite recognises: it emits `vendor/dmtap_sync_bg.wasm` as a build asset
 *   and rewrites the expression to that asset's hashed URL. The module is
 *   therefore FETCHED at runtime and never inlined into the JS bundle — the
 *   ~387 KB does not land in any chunk and is not downloaded at all unless this
 *   loader runs.
 *
 * • Node / Vitest. That same rewritten expression resolves against the dev
 *   server (an `http://localhost:…` URL), so evaluating it under Vitest would
 *   try to fetch the wasm over a socket that is not listening. Resolve off disk
 *   instead, via `createRequire` against this module's real path — which is why
 *   the Node branch must not touch the `new URL` literal at all.
 */
async function wasmBytes() {
  // Both branches locate the module RELATIVE TO THIS FILE, so both need
  // `import.meta.url`. Diwan's library build (vite.config.lib.js) also emits a
  // CommonJS artifact, in which the bundler replaces `import.meta` with `{}` —
  // there is no module URL to resolve against and no way to invent one. Say so
  // plainly instead of failing later with a confusing `undefined` base URL:
  // callers already fall back to their previous engine on a rejected load, and
  // a clear reason is the difference between a known limitation and a bug hunt.
  if (typeof import.meta === 'undefined' || !import.meta.url) {
    throw new Error(
      'dmtap-sync-wasm: no import.meta.url — the CommonJS library build cannot ' +
      'locate the .wasm. Use the ESM build to run on the substrate engine.',
    )
  }
  if (isNode()) {
    const nodeModule = 'node:module'
    const nodeFs = 'node:fs/promises'
    const { createRequire } = await import(/* @vite-ignore */ nodeModule)
    const { readFile } = await import(/* @vite-ignore */ nodeFs)
    const require = createRequire(import.meta.url)
    return readFile(require.resolve(`../vendor/${WASM_FILE}`))
  }
  const url = new URL('../vendor/dmtap_sync_bg.wasm', import.meta.url)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`dmtap-sync-wasm: fetch ${url} → ${res.status}`)
  return res.arrayBuffer()
}

async function instantiate() {
  const glue = await import('../vendor/dmtap_sync_bg.js')
  const bytes = await wasmBytes()
  const { instance } = await WebAssembly.instantiate(
    bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes),
    { './dmtap_sync_bg.js': glue },
  )
  glue.__wbg_set_wasm(instance.exports)
  instance.exports.__wbindgen_start()
  return glue
}

/**
 * Load (once) and return the sync-engine namespace.
 *
 * Concurrent callers share one in-flight promise; a failed load is NOT cached,
 * so a transient fetch error can be retried rather than poisoning the process.
 *
 * @returns {Promise<object>} the upstream module namespace (`SyncEngine`,
 *   `HlcClock`, `encode_op`, …). See `vendor/dmtap_sync.d.ts`.
 */
export function loadSync() {
  if (!modulePromise) {
    modulePromise = instantiate().catch((err) => {
      modulePromise = null
      throw err
    })
  }
  return modulePromise
}

/** True once `loadSync()` has resolved at least once (test/diagnostic use). */
export function isLoaded() {
  return modulePromise !== null
}
