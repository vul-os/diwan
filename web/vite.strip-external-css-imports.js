// SOVEREIGNTY: a self-host product must never fetch web assets from a third
// party at runtime (it leaks the user's IP and breaks air-gapped use). Some
// bundled dependencies embed external `@import`s in their CSS — most notably
// several reveal.js themes (moon, sky, simple, league, blood, beige, night,
// solarized) which `@import url(https://fonts.googleapis.com/…)` for Lato /
// Open Sans / News Cycle. This Vite plugin strips those external @imports from
// every emitted CSS asset so the theme degrades to its own web-safe fallback
// stack (already declared in the theme CSS). No Vulos-brand font is affected.
//
// Matches both source form `@import url(https://…);` and Vite's minified form
// `@import"https://…";` (no space, no url()).
const EXTERNAL_IMPORT_RE =
  /@import\s*(?:url\(\s*)?['"]?https?:\/\/[^'")\s]*(?:fonts\.googleapis\.com|fonts\.gstatic\.com|cdnjs\.cloudflare\.com)[^'")]*['"]?\s*\)?[^;]*;/gi

export function stripExternalCssImports() {
  return {
    name: 'strip-external-css-imports',
    generateBundle(_options, bundle) {
      for (const asset of Object.values(bundle)) {
        if (asset.type !== 'asset' || !asset.fileName.endsWith('.css')) continue
        const src = typeof asset.source === 'string'
          ? asset.source
          : Buffer.from(asset.source).toString('utf8')
        const stripped = src.replace(EXTERNAL_IMPORT_RE, '')
        if (stripped !== src) asset.source = stripped
      }
    },
  }
}
