// Vite plugin: publish the third-party notices with the bundle.
//
// The licence texts of everything we bundle are generated into
// THIRD-PARTY-NOTICES.txt (npm) and THIRD-PARTY-NOTICES-GO.txt (Go modules) by
// scripts/gen-third-party-notices.mjs. A notices file nobody can reach satisfies
// no licence, so this plugin emits them into the build output as a single
// `licenses.txt`, which the app serves and links from its UI.
//
// The upstream `@license` banners themselves are kept inside the JS chunks by
// `build.rollupOptions.output.comments = { legal: true }` in the vite config.
// (Vite 8 bundles JS with rolldown/oxc, whose minifier strips every comment
// unless that option is set. `esbuild.legalComments` is NOT the knob here: in
// Vite 8 the esbuild options only reach the CSS pipeline, which is why the CSS
// banners survived while every JS banner was being dropped.)

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export function licensesTxt({ root = process.cwd(), fileName = 'licenses.txt' } = {}) {
  const sources = ['THIRD-PARTY-NOTICES.txt', 'THIRD-PARTY-NOTICES-GO.txt']
  return {
    name: 'vulos-licenses-txt',
    apply: 'build',
    generateBundle() {
      const parts = []
      for (const s of sources) {
        const p = resolve(root, s)
        if (existsSync(p)) parts.push(readFileSync(p, 'utf8').trimEnd())
      }
      if (!parts.length) {
        // Fail the build rather than ship a bundle with no notices: the licences
        // of the code inside that bundle require them to travel with it.
        this.error(
          `no third-party notices found in ${root} (looked for ${sources.join(', ')}). ` +
            'Run `npm run notices` first -- the bundle may not ship without them.',
        )
        return
      }
      this.emitFile({ type: 'asset', fileName, source: parts.join('\n\n') + '\n' })
    },
  }
}
