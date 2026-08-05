/**
 * vite.config.office.js — office.vulos.org bundle
 *
 * Builds to dist-office/ from src/entries/office.tsx.
 * Code-splits per app (docs/sheets/slides/pdf) for optimal load times.
 *
 * Deploy: upload dist-office/ to Tigris at office/<sha>/
 *   Fly SPA fallback: configure the fly.toml `[[http_service]]` block (or the
 *   static file server fronting it) to serve index.html for any unmatched path.
 *   See scripts/deploy-static.sh and DEPLOY.md for deployment instructions.
 *
 * Usage: vite build --config vite.config.office.js
 */

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { stripExternalCssImports } from './vite.strip-external-css-imports.js'
import { licensesTxt } from './vite-plugin-licenses.js'

const dir = import.meta.dirname

// Vite 8's rolldown bundler requires manualChunks in function form (the
// object/record form is a legacy rollup-only shape). Map each vendored
// package to its chunk by node_modules path.
const chunkGroups = {
  'vendor-react': ['react', 'react-dom', 'react-router-dom'],
  'vendor-tiptap': [
    '@tiptap/react', '@tiptap/starter-kit',
    '@tiptap/extension-image', '@tiptap/extension-link',
    '@tiptap/extension-table', '@tiptap/extension-table-row',
    '@tiptap/extension-table-cell', '@tiptap/extension-table-header',
    '@tiptap/extension-text-align', '@tiptap/extension-text-style',
    '@tiptap/extension-color', '@tiptap/extension-highlight',
    '@tiptap/extension-underline', '@tiptap/extension-task-list',
    '@tiptap/extension-task-item', '@tiptap/extension-character-count',
    '@tiptap/extension-placeholder', '@tiptap/extension-typography',
  ],
  'vendor-sheets': ['@fortune-sheet/react'],
  'vendor-slides': ['reveal.js', 'pptxgenjs'],
  'vendor-export': ['docx', 'xlsx', 'file-saver', 'turndown', 'mammoth'],
  'vendor-pdf': ['pdfjs-dist', 'pdf-lib', 'signature_pad'],
}

function manualChunks(id) {
  if (!id.includes('/node_modules/')) return
  for (const [chunk, pkgs] of Object.entries(chunkGroups)) {
    for (const pkg of pkgs) {
      if (id.includes(`/node_modules/${pkg}/`)) return chunk
    }
  }
}

export default defineConfig({
  // Same one-React pin as vite.config.js — see the comment there.
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  // licensesTxt reads THIRD-PARTY-NOTICES.txt / THIRD-PARTY-NOTICES-GO.txt,
  // both of which stay at the repo root (one level up from this config's own
  // dir, web/) — not `dir` itself.
  plugins: [react(), stripExternalCssImports(), licensesTxt({ root: resolve(dir, '..') })],
  root: dir,
  define: {
    'import.meta.env.VITE_BUILD_TARGET': JSON.stringify('web'),
  },
  build: {
    outDir: resolve(dir, 'dist-office'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      input: resolve(dir, 'index.office.html'),
      output: {
        manualChunks,
        // Preserve upstream @license banners in the bundle — see vite.config.js.
        comments: { legal: true },
      },
    },
  },
  server: {
    port: 5174,
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
    },
  },
})
