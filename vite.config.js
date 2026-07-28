import { writeFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { stripExternalCssImports } from './vite.strip-external-css-imports.js'
import { licensesTxt } from './vite-plugin-licenses.js'

// emptyOutDir wipes dist/ on every build, including the dist/.gitkeep
// placeholder that lets `go build` (//go:embed all:dist) compile before any
// frontend build exists. Recreate it after the bundle is written.
const keepGitkeep = {
  name: 'keep-dist-gitkeep',
  closeBundle() {
    writeFileSync('dist/.gitkeep', '')
  },
}

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

// Default config: monolithic diwan build (dist/).
// For the subdomain build use vite.config.office.js.
// (Chat/video are third-party per the VulOS standard, not built by Office;
// Calendar/Contacts are bring-your-own PIM via lilmail.)
// For library build use vite.config.lib.js.
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.js'],
    include: ['src/**/*.test.{js,jsx}', 'src/__tests__/**/*.test.{js,jsx}'],
    // The collaboration suites mount REAL ProseMirror editors (two per test, full
    // Docs schema) — that is the point of them, and it is slow in jsdom. With the
    // pool running them alongside everything else, vitest's 5s default started
    // timing out unrelated tests on a loaded machine. Give every test room; no
    // assertion anywhere is relaxed.
    testTimeout: 20_000,
  },
  // Belt-and-suspenders: pin to one React copy. (Historically load-bearing
  // when the vendored WebRTC fabric was a symlinked `file:` npm dependency
  // shipping its own react in node_modules — Vite 8's rolldown resolver would
  // otherwise load a SECOND React from that dep's own location, breaking
  // hooks. It is now first-party source under src/lib/collab/webrtc/ with no
  // node_modules of its own, but the pin is harmless to keep.)
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  plugins: [react(), keepGitkeep, stripExternalCssImports(), licensesTxt()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        manualChunks,
        // Keep upstream @license / @preserve banners in the bundled JS. MIT,
        // BSD and ISC all require the copyright notice to travel with every
        // copy, and a bundle served to a browser IS a copy. Vite 8 bundles JS
        // with rolldown, whose minifier drops every comment unless this is set.
        // (esbuild.legalComments does NOT do this under Vite 8 — those options
        // only reach the CSS pipeline, which is exactly why CSS banners survived
        // while every JS banner was being stripped.)
        comments: { legal: true },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
})
