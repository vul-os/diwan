/**
 * third_party/dmtap-sync-wasm — provenance gate.
 *
 * Nothing in git ties a binary blob to the code that produced it. That is not a
 * hypothetical: upstream's own `bindings/go/embed.go` records the incident this
 * guard exists to prevent — a committed WASM module went stale against a fix in
 * `src/abi.rs`, and every response whose Rust-side String capacity outran its
 * length aborted the allocator on free. Invisibly. Diwan had drifted the same
 * way (395,912 B / sha256 94262463… against upstream's 400,930 B / 0c50eff9…),
 * and nothing failed.
 *
 * So the vendored bytes are tied to a recorded digest instead. This suite:
 *   • recomputes the SHA-256 and size of every file listed in
 *     vendor/PROVENANCE.json and FAILS on any mismatch;
 *   • FAILS if a file exists in vendor/ that PROVENANCE.json does not cover, so
 *     an unrecorded blob cannot be added alongside the recorded ones;
 *   • asserts the coverage COUNT, so a shrinking manifest cannot make the suite
 *     pass by checking less;
 *   • asserts the module's declared import module still matches what
 *     src/index.js hands to WebAssembly.instantiate — the one upstream change
 *     that would silently break the loader.
 *
 * It cannot skip. There is no toolchain to detect and no service to reach: it
 * hashes files that are in the repo. If you are re-vendoring, follow the recipe
 * in VENDOR.md and regenerate the digests from the copied files — never edit a
 * digest to make this go green.
 */

import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const VENDOR_DIR = join(HERE, '../../../../third_party/dmtap-sync-wasm/vendor')
const MANIFEST = join(VENDOR_DIR, 'PROVENANCE.json')

/** Files in vendor/ that are the manifest itself, not vendored artifacts. */
const NON_ARTIFACTS = new Set(['PROVENANCE.json'])

async function loadManifest() {
  return JSON.parse(await readFile(MANIFEST, 'utf8'))
}

describe('third_party/dmtap-sync-wasm provenance', () => {
  it('records a digest for exactly the files that are vendored', async () => {
    const manifest = await loadManifest()
    const recorded = Object.keys(manifest.files).sort()
    const present = (await readdir(VENDOR_DIR))
      .filter((n) => !NON_ARTIFACTS.has(n))
      .sort()

    // Both directions. A missing entry means an unrecorded blob shipped; a
    // stale entry means the manifest describes a file that is no longer here.
    expect(present, 'vendor/ contents must match PROVENANCE.json exactly').toEqual(recorded)

    // Coverage count, pinned. If upstream starts emitting a fourth artifact and
    // someone vendors it without recording it, the check above catches it — and
    // if someone "fixes" that by deleting entries, this catches THAT.
    expect(recorded.length, 'expected 3 vendored artifacts (glue JS, wasm, types)').toBe(3)
    expect(recorded).toContain('dmtap_sync_bg.wasm')
    expect(recorded).toContain('dmtap_sync_bg.js')
    expect(recorded).toContain('dmtap_sync.d.ts')
  })

  it('every vendored file matches its recorded SHA-256 and size', async () => {
    const manifest = await loadManifest()
    const entries = Object.entries(manifest.files)
    expect(entries.length).toBeGreaterThan(0)

    let checked = 0
    for (const [name, want] of entries) {
      const bytes = await readFile(join(VENDOR_DIR, name))
      const got = createHash('sha256').update(bytes).digest('hex')
      expect(
        got,
        `${name} does not match its recorded digest — the vendored copy has drifted from ` +
        `envoir/crates/dmtap-sync-wasm. Re-vendor per VENDOR.md; do not edit PROVENANCE.json.`,
      ).toBe(want.sha256)
      expect(bytes.length, `${name} size`).toBe(want.bytes)
      checked += 1
    }
    // A loop that iterated zero times would pass silently. Assert it did not.
    expect(checked, 'provenance loop must actually hash every recorded file').toBe(entries.length)
  })

  it('the .wasm still declares exactly the one import module the loader supplies', async () => {
    const manifest = await loadManifest()
    const bytes = await readFile(join(VENDOR_DIR, 'dmtap_sync_bg.wasm'))
    const mod = await WebAssembly.compile(bytes)
    const imports = WebAssembly.Module.imports(mod)

    expect(imports.length, 'the module should import from at least one host module').toBeGreaterThan(0)
    const modules = [...new Set(imports.map((i) => i.module))]
    // src/index.js passes a single-key import object. If upstream renames its
    // glue file, instantiate() would throw a LinkError at runtime — surface it
    // here instead, where the message says what to change.
    expect(
      modules,
      'src/index.js builds its WebAssembly.instantiate import object from exactly this name',
    ).toEqual([manifest.wasm_import_module])
  })

  it('the loader source names the same import module as the manifest', async () => {
    const manifest = await loadManifest()
    const loader = await readFile(join(VENDOR_DIR, '../src/index.js'), 'utf8')
    expect(
      loader.includes(`'${manifest.wasm_import_module}'`),
      'src/index.js must reference the manifest\'s wasm_import_module verbatim',
    ).toBe(true)
  })
})
