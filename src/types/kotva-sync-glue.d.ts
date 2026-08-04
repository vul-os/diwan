// @vul-os/kotva-sync only publishes types for its public entry point
// (kotva_sync.d.ts, resolved via "types" in its package.json). kotvaSync.ts
// deliberately bypasses that entry point (see the module doc there) and
// imports the wasm-pack-generated glue file directly by subpath — a real ESM
// file with no declaration of its own. This models the one named export
// kotvaSync.ts calls directly; the rest of the namespace (the host functions
// the compiled .wasm imports) is used wholesale as an opaque
// WebAssembly.ModuleImports object, cast at that one call site rather than
// modelled here.
declare module '@vul-os/kotva-sync/kotva_sync_bg.js' {
  export function __wbg_set_wasm(exports: WebAssembly.Exports): void
}
