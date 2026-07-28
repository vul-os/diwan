# Vendored `dmtap-sync-wasm`

This directory is a **vendored copy** of the DMTAP Sync substrate's WASM binding
(`crates/dmtap-sync-wasm` in the `envoir` repo). It is committed here so a fresh
`git clone && npm install && npm run build` succeeds **with no sibling checkout
of `envoir` and no Rust toolchain**.

Diwan consumes it via `"dmtap-sync-wasm": "file:third_party/dmtap-sync-wasm"` in
the root `package.json`.

## Why this exists

The Vulos suite grew several independent sync engines. `dmtap-sync` is the one
shared implementation of the substrate sync spec (`substrate/SYNC.md`, which
lives in the `kotva` repo — deliberately *not* linked relatively from here,
because nothing in this repo may assume a sibling checkout), and this binding is
the *same compiled core* a Rust server runs, not a second implementation of the
spec that happens to agree most of the time.

Upstream's own README reports **24/24 frozen conformance vectors driven
byte-identically through both the native Rust and the WASM/JS surfaces**. That is
upstream's claim about upstream, restated here for context — Diwan does **not**
re-run those vectors, because it does not vendor them. What Diwan's suite does
check is listed under "Tests that guard this copy" below.

Diwan's Sheets grid is the first Vulos surface to run on the shared engine. It
has **not retired** the hand-rolled one: `src/lib/crdt/grid.js` is still present
and is still the **default**. `src/lib/crdt/substrateGrid.js` is a drop-in
alternative selected by the off-by-default `VITE_SUBSTRATE_SYNC` build flag, and
`SheetsEditor` falls back to `grid.js` when the substrate fails to load. Both
engines therefore have to keep working; see `docs/CONFIGURATION.md` for why the
choice is a build flag rather than a cutover (the two engines each converge but
do not share a total order).

## What is vendored

* `vendor/dmtap_sync_bg.wasm` — the compiled core, **byte-for-byte** upstream.
* `vendor/dmtap_sync_bg.js` — the wasm-bindgen JS wrappers, byte-for-byte.
* `vendor/dmtap_sync.d.ts` — the generated types (from the Rust doc comments).
* `vendor/PROVENANCE.json` — the digests that tie the three files above to their
  source. See below.
* `src/index.js` — **the only file written here.** See below.
* `LICENSE` (MIT, from `envoir/LICENSE-MIT`).

Upstream's `dmtap_sync.js` entry point is **not** vendored. It is the eight
lines of wasm-pack `--target bundler` wiring that do
`import * as wasm from './dmtap_sync_bg.wasm'` — an ESM-imports-WASM statement
that needs a Vite plugin in the browser and does not work at all under
Vitest/node. `src/index.js` replaces exactly those eight lines with an
environment-agnostic `WebAssembly.instantiate` (the module declares one import
module, `'./dmtap_sync_bg.js'`), so the browser build and the test run load the
identical `.wasm`. No algebra is reimplemented; if it were, the whole point of
adopting a shared engine would be lost.

## Provenance — how this copy is tied to its source

Upstream's `pkg/` is git-ignored build output, so there is no upstream commit to
pin. The digests in `vendor/PROVENANCE.json` **are** the identity of this copy:

| Artifact | SHA-256 | Raw | Gzipped |
|---|---|---:|---:|
| `vendor/dmtap_sync_bg.wasm` | `0c50eff9…805317` | 400,930 B | 156,451 B |
| `vendor/dmtap_sync_bg.js`   | `3d8e1910…b7074d` |  64,990 B |  12,819 B |
| `vendor/dmtap_sync.d.ts`    | `871f5409…0ed561` |  24,764 B |   8,787 B |

`src/lib/crdt/__tests__/vendorProvenance.test.js` recomputes every digest and
size on each `npm test` and **fails** when a vendored byte does not match. It
cannot skip: it only hashes files that are already in the repo, so there is no
toolchain to detect and no service to reach. It also fails when `vendor/` holds a
file `PROVENANCE.json` does not cover, and asserts the covered-file count so a
shrunken manifest cannot pass by checking less.

The guard exists because of a real incident, documented upstream in
`bindings/go/embed.go`: a committed WASM module went stale against a fix in
`src/abi.rs`, and every response whose Rust-side String capacity outran its
length aborted the allocator on free — invisibly, because nothing in git ties a
binary blob to the code that produced it. **This copy had drifted the same way**:
it carried a 395,912-byte module (`sha256 94262463…`) against upstream's
400,930-byte one (`sha256 0c50eff9…`), missing the four `snapshot_body_*`
exports upstream had since added, and nothing failed.

## Known limitation: the CommonJS library build

`vite.config.lib.js` emits a CJS artifact alongside the ESM one, and a bundler
replaces `import.meta` with `{}` in CJS output. This loader locates the `.wasm`
relative to its own module URL, so there is nothing to resolve against and the
load rejects with an explicit message.

That is a **contained** limitation, not a broken build: the only consumer is
`SheetsEditor`, which already falls back to the `crdt/grid.js` engine when the
substrate fails to load. So a CJS library consumer with `VITE_SUBSTRATE_SYNC=on`
gets the hand-rolled engine and a working spreadsheet. The ESM library build,
the app build and Vitest all get the substrate.

Fixing it properly means embedding the module as a base64 string (which costs
every consumer ~530 KB of JS whether they use it or not) or shipping a
`--target nodejs` copy for CJS. Neither is worth it before a CJS consumer
actually needs the substrate path.

## Sync from upstream

```sh
# Adjust the path if your envoir checkout lives elsewhere.
UPSTREAM=../envoir/crates/dmtap-sync-wasm

"$UPSTREAM/build.sh" bundler                 # needs rust + wasm-pack
cp "$UPSTREAM"/pkg/dmtap_sync_bg.js   third_party/dmtap-sync-wasm/vendor/
cp "$UPSTREAM"/pkg/dmtap_sync_bg.wasm third_party/dmtap-sync-wasm/vendor/
cp "$UPSTREAM"/pkg/dmtap_sync.d.ts    third_party/dmtap-sync-wasm/vendor/
cp ../envoir/LICENSE-MIT              third_party/dmtap-sync-wasm/LICENSE

# Re-record the digests FROM THE FILES YOU JUST COPIED, then update
# PROVENANCE.json and the table above.
( cd third_party/dmtap-sync-wasm/vendor \
  && for f in dmtap_sync_bg.js dmtap_sync_bg.wasm dmtap_sync.d.ts; do
       printf '%s  sha256=%s  bytes=%s\n' "$f" \
         "$(shasum -a 256 "$f" | cut -d' ' -f1)" "$(wc -c < "$f" | tr -d ' ')"
     done )
```

Never edit `PROVENANCE.json` to make a failing provenance test pass — that turns
the guard into a rubber stamp. Regenerate it from files you have just copied, or
not at all.

Then re-run `npm test`.

## Tests that guard this copy

| Suite | What it would catch |
|---|---|
| `src/lib/crdt/__tests__/vendorProvenance.test.js` | a vendored byte drifting from its recorded digest; an unrecorded file in `vendor/`; the `.wasm` declaring an import module the loader does not supply |
| `src/lib/crdt/__tests__/substrateGrid.convergence.test.js` | the loader failing to instantiate; the engine's LWW algebra no longer resolving as `SYNC.md` §4.4 specifies; two replicas failing to converge |
| `src/lib/crdt/__tests__/substrateTree.mapping.test.js` | the movable-tree mapping used to reason about Slides drifting |

A refreshed `.wasm` that breaks any of these fails the suite rather than reaching
a document.

**If upstream adds an export**, nothing needs changing in `src/index.js`: it
re-exports the namespace wholesale rather than enumerating names. The digests do
need re-recording, and the provenance test says so.

**If upstream changes its import-module name** (i.e. renames `dmtap_sync_bg.js`),
`src/index.js`'s `WebAssembly.instantiate` import object and
`PROVENANCE.json`'s `wasm_import_module` must both be updated to match. The
provenance test asserts the two agree with the module's own declared import, so
it cannot fail silently.
