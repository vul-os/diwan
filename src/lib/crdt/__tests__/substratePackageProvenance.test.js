/**
 * @vul-os/kotva-sync — provenance gate.
 *
 * Nothing in git ties a binary blob to the code that produced it. That is not a
 * hypothetical: upstream's own `bindings/go/embed.go` records the incident this
 * guard exists to prevent — a committed WASM module went stale against a fix in
 * `src/abi.rs`, and every response whose Rust-side String capacity outran its
 * length aborted the allocator on free. Invisibly. Diwan had drifted the same
 * way while it VENDORED the engine under `third_party/dmtap-sync-wasm/`
 * (395,912 B / sha256 94262463… against upstream's 400,930 B / 0c50eff9…), and
 * nothing failed.
 *
 * The engine is no longer vendored: it is the published npm package
 * `@vul-os/kotva-sync`, and the digest that pins it is npm's own. This suite
 * keeps the vendored gate's INTENT with the two halves that npm gives us:
 *
 *   1. THE TARBALL. `package-lock.json` records a sha512 Subresource-Integrity
 *      string for the exact tarball npm fetched, and npm verifies it on every
 *      install. Pinning that string here means the dependency cannot be moved to
 *      a different published artifact — a bumped version, a re-publish, a
 *      swapped registry — without this test failing and someone updating the
 *      constant on purpose.
 *
 *   2. THE INSTALLED BYTES. The lockfile hash covers the tarball, and stops
 *      mattering the moment it is unpacked: nothing re-checks `node_modules/`
 *      afterwards, so a locally patched `.wasm` (or a stale tree from an
 *      interrupted install) is exactly the failure mode the vendored gate
 *      caught. So every installed file is hashed here too, against digests
 *      recorded from the published 0.1.0 tarball.
 *
 * It also asserts the compiled module still declares exactly the one host
 * import `kotvaSync.js` supplies — the single upstream change that would
 * otherwise turn into a bare LinkError at runtime.
 *
 * IT CANNOT SKIP. There is no toolchain to detect and no service to reach: it
 * reads `package.json`, `package-lock.json` and files npm has already installed.
 * If the dependency is missing or not installed, every read below throws and the
 * suite FAILS — which is the correct outcome, because an uninstalled engine
 * means `substrateGrid.js` cannot load either.
 *
 * When you legitimately upgrade the package: re-record the constants from the
 * freshly installed tree
 *
 *     ( cd node_modules/@vul-os/kotva-sync \
 *       && for f in *; do printf '%s %s %s\n' "$f" \
 *            "$(shasum -a 256 "$f" | cut -d' ' -f1)" "$(wc -c < "$f")"; done )
 *
 * and take INTEGRITY from `package-lock.json`. Never edit a digest to make a red
 * test green without doing that — it turns the guard into a rubber stamp.
 */

import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { WASM_IMPORT_MODULE } from '../kotvaSync.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '../../../..')
const PKG_NAME = '@vul-os/kotva-sync'
const PKG_VERSION = '0.1.0'
const INSTALLED = join(REPO, 'node_modules', PKG_NAME)

/** The sha512 SRI npm recorded for the 0.1.0 tarball it fetched from the registry. */
const TARBALL_INTEGRITY =
  'sha512-UrwaG7Da+Fme4TPRTuEX3hPgHcVu4oKm+xj0AZwLMi1Icr/bx9zTLRJA32sWC+0QQc7j/mkzi9ufOuRpHfGPhQ=='

/**
 * SHA-256 and byte size of every file the published 0.1.0 tarball contains.
 * `kotva_sync_bg.wasm` is the compiled core, `kotva_sync_bg.js` the wasm-bindgen
 * wrappers, `kotva_sync.js` the bundler-target entry point this repo replaces
 * with `src/lib/crdt/kotvaSync.js` (see that file for why).
 */
const FILES = {
  'kotva_sync_bg.wasm': { sha256: 'c8128e740ed746618f0332594192de224dfd3bd0e1bbab8f116813c365f7a1fa', bytes: 401960 },
  'kotva_sync_bg.js': { sha256: 'bb91207fcc20b496adc659660b44997563af40e4a5fc71e14b6ea8bbab45268e', bytes: 65656 },
  'kotva_sync.d.ts': { sha256: '674aa993e90f8c9581fb5f168a7dc8ea46abe1496bf5a351c1f71d4155634061', bytes: 25430 },
  'kotva_sync.js': { sha256: '9177e71ee244f4d6b3f33caa5a542bbc08835becb0b7057cdd127f592172cb1a', bytes: 1089 },
  'package.json': { sha256: '3fabb858bf9d964b69a6c8a04cf6c88a1e0963194be963f06a538feeb8bf8ade', bytes: 1077 },
  'README.md': { sha256: 'c2bed3d013f70207f63931891bdc5de12dc96f0c83a54bf296379b73150f0d68', bytes: 15411 },
  'LICENSE-MIT': { sha256: 'ee23c17b75f8964f2c4e39555ebb0c38a6141265ff05f1db15942811bbf1bf6d', bytes: 1075 },
}

async function readJson(p) {
  return JSON.parse(await readFile(p, 'utf8'))
}

describe('@vul-os/kotva-sync provenance', () => {
  it('is an exactly-pinned registry dependency, not a vendored file: path', async () => {
    const pkg = await readJson(join(REPO, 'package.json'))
    const spec = pkg.dependencies?.[PKG_NAME]

    expect(spec, `${PKG_NAME} must be a runtime dependency of the app`).toBe(PKG_VERSION)

    // The engine used to ship as `"dmtap-sync-wasm": "file:third_party/…"`, a
    // copy that silently went stale. A `file:`/`link:` spec bypasses npm's
    // integrity record entirely, so nothing below could pin it — fail loudly if
    // one comes back for this or any other dependency.
    const linked = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })
      .filter(([, v]) => typeof v === 'string' && (v.startsWith('file:') || v.startsWith('link:')))
    expect(linked, 'no dependency may be a local file:/link: path — npm records no integrity for those').toEqual([])
  })

  it('the lockfile pins the exact published tarball by sha512', async () => {
    const lock = await readJson(join(REPO, 'package-lock.json'))
    const entry = lock.packages?.[`node_modules/${PKG_NAME}`]

    expect(entry, `package-lock.json must contain node_modules/${PKG_NAME}`).toBeTruthy()
    expect(entry.version).toBe(PKG_VERSION)
    expect(entry.resolved).toBe(
      `https://registry.npmjs.org/${PKG_NAME}/-/kotva-sync-${PKG_VERSION}.tgz`,
    )
    expect(
      entry.integrity,
      'the lockfile no longer pins the reviewed tarball — if this is a deliberate upgrade, ' +
      're-record TARBALL_INTEGRITY and every digest in FILES from the new install',
    ).toBe(TARBALL_INTEGRITY)

    // No `file:`/`link:` entry may survive in the lockfile either: a stale one
    // would keep a deleted vendored tree resolvable on a fresh `npm ci`.
    const links = Object.keys(lock.packages ?? {}).filter((k) => lock.packages[k].link === true)
    expect(links, 'lockfile still contains linked local packages').toEqual([])
  })

  it('records a digest for exactly the files npm installed', async () => {
    const recorded = Object.keys(FILES).sort()
    // Dot-files are tooling droppings (.package-lock.json marker files, editor
    // and OS cruft), never package content — they are not what this pins.
    const present = (await readdir(INSTALLED)).filter((n) => !n.startsWith('.')).sort()

    // Both directions. A missing entry means an unrecorded file shipped; a stale
    // entry means the manifest describes a file that is no longer installed.
    expect(present, `node_modules/${PKG_NAME} contents must match the recorded manifest exactly`)
      .toEqual(recorded)

    // Coverage count, pinned. If upstream starts shipping an eighth file and
    // someone records it without checking, the assertion above catches it — and
    // if someone "fixes" a failure by deleting entries, this catches THAT.
    expect(recorded.length, 'expected 7 files in the published tarball').toBe(7)
    expect(recorded).toContain('kotva_sync_bg.wasm')
    expect(recorded).toContain('kotva_sync_bg.js')
    expect(recorded).toContain('kotva_sync.d.ts')
  })

  it('every installed file matches its recorded SHA-256 and size', async () => {
    const entries = Object.entries(FILES)
    expect(entries.length).toBeGreaterThan(0)

    let checked = 0
    for (const [name, want] of entries) {
      const bytes = await readFile(join(INSTALLED, name))
      const got = createHash('sha256').update(bytes).digest('hex')
      expect(
        got,
        `${name} does not match the digest recorded from the published ${PKG_VERSION} tarball — ` +
        `node_modules has been modified after install, or the lockfile resolved a different ` +
        `artifact. Reinstall; do not edit the digest.`,
      ).toBe(want.sha256)
      expect(bytes.length, `${name} size`).toBe(want.bytes)
      checked += 1
    }
    // A loop that iterated zero times would pass silently. Assert it did not.
    expect(checked, 'provenance loop must actually hash every recorded file').toBe(entries.length)
  })

  it('the .wasm still declares exactly the one import module the loader supplies', async () => {
    const bytes = await readFile(join(INSTALLED, 'kotva_sync_bg.wasm'))
    const mod = await WebAssembly.compile(bytes)
    const imports = WebAssembly.Module.imports(mod)

    expect(imports.length, 'the module should import from at least one host module').toBeGreaterThan(0)
    const modules = [...new Set(imports.map((i) => i.module))]
    // kotvaSync.js builds a single-key import object from WASM_IMPORT_MODULE. If
    // upstream renames its glue file, instantiate() would throw a LinkError at
    // runtime — surface it here instead, where the message says what to change.
    expect(
      modules,
      'src/lib/crdt/kotvaSync.js builds its WebAssembly.instantiate import object from exactly this name',
    ).toEqual([WASM_IMPORT_MODULE])

    // And the name the package's own entry point uses, so the two cannot drift.
    const entry = await readFile(join(INSTALLED, 'kotva_sync.js'), 'utf8')
    expect(entry).toContain(`"${WASM_IMPORT_MODULE}"`)
  })
})
