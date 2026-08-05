/**
 * src/lib/crdt/kotvaSync.js — loader for the KOTVA Sync substrate binding.
 *
 * The engine is the npm package `@vul-os/kotva-sync` (published from the
 * `kotva` repo; it was `dmtap-sync-wasm` inside `envoir` before the substrate
 * was named, which is why the artifacts are now `kotva_sync_*`). Diwan used to
 * vendor a copy under `third_party/dmtap-sync-wasm/`; it does not any more —
 * npm resolves it, and `package-lock.json` records the tarball's sha512.
 *
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------
 * The package is a wasm-pack **bundler**-target build. Its entry point
 * (`kotva_sync.js`, the package `main`) is eight lines of target-specific
 * wiring whose first statement is
 *
 *     import * as wasm from "./kotva_sync_bg.wasm"
 *
 * — an ESM-imports-WASM declaration. That needs a bundler plugin in Vite and
 * does not work at all under Vitest/node. Rather than add a plugin (and with it
 * a second, divergent load path for tests), this module instantiates the
 * WebAssembly itself and does the same three things `kotva_sync.js` does.
 *
 * That is lossless, because the wasm-pack glue is deliberately split:
 *   • `kotva_sync_bg.js`   — ALL the JS-side wrappers and the host functions the
 *     module imports. Target-independent. Exports `__wbg_set_wasm(exports)`.
 *   • `kotva_sync_bg.wasm` — the compiled core. It declares exactly ONE import
 *     module, `'./kotva_sync_bg.js'`.
 *   • `kotva_sync.js`      — instantiate, `__wbg_set_wasm`, `__wbindgen_start`,
 *     re-export. Only this last file is target-specific.
 *
 * So the wrappers and the `.wasm` are the published artifacts byte-for-byte and
 * no algebra is re-implemented here — which is the entire point of adopting a
 * shared engine. `src/lib/crdt/__tests__/substratePackageProvenance.test.js`
 * pins that: it hashes the installed files and cross-checks the module's own
 * declared import against `WASM_IMPORT_MODULE` below.
 *
 * Usage:
 *
 *   import { loadSync } from './kotvaSync.js'
 *   const sync = await loadSync()          // idempotent; one instance per process
 *   const engine = new sync.SyncEngine()
 *
 * Every call on the returned namespace is SYNCHRONOUS (upstream's contract);
 * only this one-time load is async.
 */

/**
 * The single host module the `.wasm` imports. The provenance test asserts the
 * compiled module still declares exactly this name — if upstream renames its
 * glue file, `instantiate()` below would otherwise fail with a bare LinkError.
 */
export const WASM_IMPORT_MODULE = './kotva_sync_bg.js'

/** The upstream module namespace loadSync() resolves to — see kotva_sync.d.ts. */
export type KotvaSyncNamespace = typeof import('@vul-os/kotva-sync')

let modulePromise: Promise<KotvaSyncNamespace> | null = null

/** True under Node and Vitest; false in a real browser. */
function isNode(): boolean {
  return typeof process !== 'undefined' && !!process.versions && !!process.versions.node
}

/**
 * Read the engine's `.wasm` as bytes.
 *
 * The two environments need genuinely different resolution, so the branch is on
 * the ENVIRONMENT rather than on the resulting URL's scheme.
 *
 * • Browser. `import('…?url')` is Vite's documented way to get an asset URL for
 *   a file inside a dependency, and unlike `new URL('…', import.meta.url)` it
 *   accepts a bare package specifier — so it does not hard-code where npm
 *   happened to hoist the package, and Vite fails the build loudly if the
 *   dependency is missing rather than leaving a dangling URL.
 *
 *   In the APP build (vite.config.js, vite.config.office.js) Vite emits the
 *   `.wasm` as a separate hashed asset, so it is fetched at runtime and never
 *   lands in a JS chunk. In the LIBRARY build (vite.config.lib.js) Vite has no
 *   asset directory to publish into and inlines it as a base64 `data:` URI
 *   instead — verified, ~536 KB of JS. That is not new and not a cost of the
 *   `?url` form: the vendored loader's `new URL(…, import.meta.url)` was
 *   inlined by lib mode in exactly the same way (measured at 552 KB, inside the
 *   `substrateGrid` chunk rather than a chunk of its own). Either way it sits
 *   behind the dynamic `import('…/substrateGrid.js')` in SheetsEditor, so a
 *   consumer that never turns the flag on never loads it.
 *
 * • Node / Vitest. There is no dev server to fetch from, so resolve the file off
 *   disk through Node's own resolver — `createRequire` handles the bare package
 *   specifier, which a `new URL(…, import.meta.url)` expression cannot.
 */
async function wasmBytes(): Promise<ArrayBuffer | Buffer> {
  // Diwan's library build (vite.config.lib.js) also emits a CommonJS artifact,
  // in which the bundler replaces `import.meta` with `{}` — there is no module
  // URL to resolve against and no way to invent one. Say so plainly instead of
  // failing later with a confusing `undefined` base URL: callers already fall
  // back to their previous engine on a rejected load, and a clear reason is the
  // difference between a known limitation and a bug hunt.
  if (typeof import.meta === 'undefined' || !import.meta.url) {
    throw new Error(
      'kotva-sync: no import.meta.url — the CommonJS library build cannot locate ' +
      'the .wasm. Use the ESM build to run on the substrate engine.',
    )
  }
  if (isNode()) {
    const nodeModule = 'node:module'
    const nodeFs = 'node:fs/promises'
    const { createRequire } = await import(/* @vite-ignore */ nodeModule)
    const { readFile } = await import(/* @vite-ignore */ nodeFs)
    const require = createRequire(import.meta.url)
    return readFile(require.resolve('@vul-os/kotva-sync/kotva_sync_bg.wasm'))
  }
  const { default: url } = await import('@vul-os/kotva-sync/kotva_sync_bg.wasm?url')
  const res = await fetch(url)
  if (!res.ok) throw new Error(`kotva-sync: fetch ${url} → ${res.status}`)
  return res.arrayBuffer()
}

async function instantiate(): Promise<KotvaSyncNamespace> {
  const glue = await import('@vul-os/kotva-sync/kotva_sync_bg.js')
  const bytes = await wasmBytes()
  const { instance } = await WebAssembly.instantiate(
    bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes),
    // The rest of this namespace (every host function the compiled .wasm
    // imports besides __wbg_set_wasm) is intentionally untyped — see
    // src/types/kotva-sync-glue.d.ts.
    { [WASM_IMPORT_MODULE]: glue as unknown as WebAssembly.ModuleImports },
  )
  glue.__wbg_set_wasm(instance.exports)
  // wasm-bindgen's start function — always present on this glue's compiled
  // core, just not modelled in WebAssembly.Exports' general union type.
  ;(instance.exports.__wbindgen_start as () => void)()
  // The glue module IS the upstream public namespace once wired to the
  // instantiated wasm (see the module doc above) — kotva_sync.js does nothing
  // more than this same wiring before re-exporting it.
  return glue as unknown as KotvaSyncNamespace
}

/**
 * Load (once) and return the sync-engine namespace.
 *
 * Concurrent callers share one in-flight promise; a failed load is NOT cached,
 * so a transient fetch error can be retried rather than poisoning the process.
 *
 * @returns the upstream module namespace (`SyncEngine`, `HlcClock`,
 *   `encode_op`, …). See `@vul-os/kotva-sync/kotva_sync.d.ts`.
 */
export function loadSync(): Promise<KotvaSyncNamespace> {
  if (!modulePromise) {
    modulePromise = instantiate().catch((err) => {
      modulePromise = null
      throw err
    })
  }
  return modulePromise
}

/** True once `loadSync()` has resolved at least once (test/diagnostic use). */
export function isLoaded(): boolean {
  return modulePromise !== null
}
