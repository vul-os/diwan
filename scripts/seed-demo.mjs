#!/usr/bin/env node
/**
 * Diwan — demo data seeder
 *
 * Writes static JSON files for docs/sheets/slides into a temp data directory.
 * (Calendar + Contacts moved to the Vulos Mail/PIM product, so they are no
 * longer seeded here — Office is documents-only.)
 *
 * Usage (standalone):
 *   node scripts/seed-demo.mjs
 *
 * The screenshotter calls this automatically — no need to run it manually.
 *
 * Data dir: /tmp/vulos-demo-data  (never touches ./data)
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEMO_DATA_DIR = '/tmp/vulos-demo-data'

// A sandboxed HOME for the screenshot/demo server. The backend's local-drive
// scanner (backend/handlers/localfiles.go) walks $HOME/Documents, Downloads and
// Desktop — so running the server with HOME pointed here keeps the "on your
// computer" panel populated with fabricated demo files instead of leaking the
// operator's real filesystem into committed screenshots.
export const DEMO_HOME_DIR = '/tmp/vulos-demo-home'

// ── helpers ──────────────────────────────────────────────────────────────────

function ensureDir(p) {
  mkdirSync(p, { recursive: true })
}

function writeJSON(p, obj) {
  writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8')
}

// ── 1. Static JSON files (docs / sheets / slides) ────────────────────────────
// These are read directly from disk by the Go backend — no API call needed.
// Place them in DEMO_DATA_DIR; the backend is started with DATA_DIR pointing there.

export function seedStaticFiles() {
  ensureDir(DEMO_DATA_DIR)
  ensureDir(path.join(DEMO_DATA_DIR, 'versions'))
  ensureDir(path.join(DEMO_DATA_DIR, 'comments'))
  ensureDir(path.join(DEMO_DATA_DIR, 'replies'))
  ensureDir(path.join(DEMO_DATA_DIR, 'suggestions'))
  ensureDir(path.join(DEMO_DATA_DIR, 'envelopes'))
  ensureDir(path.join(DEMO_DATA_DIR, 'signers'))
  ensureDir(path.join(DEMO_DATA_DIR, 'audit'))
  ensureDir(path.join(DEMO_DATA_DIR, 'sealed'))
  ensureDir(path.join(DEMO_DATA_DIR, 'tokens'))

  const now = new Date().toISOString()
  const yesterday = new Date(Date.now() - 86400000).toISOString()
  const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString()

  // ── Doc ──────────────────────────────────────────────────────────────────
  writeJSON(path.join(DEMO_DATA_DIR, 'demo.json'), {
    id: 'demo',
    name: 'Q2 2026 Product Update',
    type: 'doc',
    content: {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 1 },
          content: [{ type: 'text', text: 'Q2 2026 Product Update' }],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'This document summarises the key milestones, shipped features, and upcoming priorities for Diwan during the second quarter of 2026. It is intended for internal distribution and review before the all-hands on Friday.' },
          ],
        },
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: 'What we shipped' }],
        },
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Calendar reminders with email dispatch and in-app toasts (OFFICE-CAL-3)' }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'PDF multi-party signing with Ed25519 audit trail (OFFICE-40–47)' }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Track-changes (suggestion mode) for Docs (OFFICE-27)' }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'XLSX import/export for Sheets (OFFICE-SHEETS-5)' }] }] },
          ],
        },
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: 'In progress' }],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'The team is currently finishing the ' },
            { type: 'text', marks: [{ type: 'bold' }], text: 'offline-first sync layer' },
            { type: 'text', text: ' for Docs — CRDT-based merging so two people editing the same file from different network partitions converge without conflicts when they reconnect.' },
          ],
        },
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: 'Metrics (week ending 2026-06-13)' }],
        },
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                { type: 'tableHeader', attrs: {}, content: [{ type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'Metric' }] }] },
                { type: 'tableHeader', attrs: {}, content: [{ type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'This week' }] }] },
                { type: 'tableHeader', attrs: {}, content: [{ type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'Last week' }] }] },
              ],
            },
            {
              type: 'tableRow',
              content: [
                { type: 'tableCell', attrs: {}, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Active users' }] }] },
                { type: 'tableCell', attrs: {}, content: [{ type: 'paragraph', content: [{ type: 'text', text: '1 247' }] }] },
                { type: 'tableCell', attrs: {}, content: [{ type: 'paragraph', content: [{ type: 'text', text: '1 091' }] }] },
              ],
            },
            {
              type: 'tableRow',
              content: [
                { type: 'tableCell', attrs: {}, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Docs saved' }] }] },
                { type: 'tableCell', attrs: {}, content: [{ type: 'paragraph', content: [{ type: 'text', text: '3 842' }] }] },
                { type: 'tableCell', attrs: {}, content: [{ type: 'paragraph', content: [{ type: 'text', text: '3 210' }] }] },
              ],
            },
          ],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Full data in the analytics dashboard. Questions? Leave a comment on this doc.' },
          ],
        },
      ],
    },
    created_at: twoDaysAgo,
    updated_at: yesterday,
  })

  // ── Second doc ────────────────────────────────────────────────────────────
  writeJSON(path.join(DEMO_DATA_DIR, 'doc-arch.json'), {
    id: 'doc-arch',
    name: 'Architecture Decision Record — Sync Layer',
    type: 'doc',
    content: {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 1 },
          content: [{ type: 'text', text: 'ADR-014: Sync Layer for Offline-First Docs' }],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', marks: [{ type: 'bold' }], text: 'Status:' },
            { type: 'text', text: ' Accepted · ' },
            { type: 'text', marks: [{ type: 'bold' }], text: 'Date:' },
            { type: 'text', text: ' 2026-06-10' },
          ],
        },
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: 'Context' }],
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Diwan currently uses last-write-wins (LWW) for concurrent edits. This is adequate for single-user deployments but causes silent data loss when two users edit the same document simultaneously on a slow or partitioned network.' }],
        },
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: 'Decision' }],
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'We will adopt a CRDT (Conflict-free Replicated Data Type) approach using Yjs for rich-text documents. The server acts as a passive relay and durable snapshot store; clients hold the authoritative CRDT state and reconcile via the Y-protocol websocket.' }],
        },
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: 'Consequences' }],
        },
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Offline edits merge correctly on reconnect — no data loss.' }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Initial bundle size increases by ~60 KB (Yjs + y-prosemirror).' }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Server stores binary Yjs snapshots alongside the JSON content blob.' }] }] },
          ],
        },
      ],
    },
    created_at: twoDaysAgo,
    updated_at: now,
  })

  // ── Sheet ─────────────────────────────────────────────────────────────────
  // FortuneSheet cell format: { r: row, c: col, v: { v: value, m: display, t: type, f: formula } }
  const sheetCells = [
    // Header row
    { r: 0, c: 0, v: { v: 'Month', m: 'Month', t: 's', bl: 1 } },
    { r: 0, c: 1, v: { v: 'Revenue (ZAR)', m: 'Revenue (ZAR)', t: 's', bl: 1 } },
    { r: 0, c: 2, v: { v: 'Expenses (ZAR)', m: 'Expenses (ZAR)', t: 's', bl: 1 } },
    { r: 0, c: 3, v: { v: 'Profit (ZAR)', m: 'Profit (ZAR)', t: 's', bl: 1 } },
    { r: 0, c: 4, v: { v: 'Margin %', m: 'Margin %', t: 's', bl: 1 } },
    // Data rows
    { r: 1, c: 0, v: { v: 'Jan 2026', m: 'Jan 2026', t: 's' } },
    { r: 1, c: 1, v: { v: 48200, m: '48200', t: 'n' } },
    { r: 1, c: 2, v: { v: 31400, m: '31400', t: 'n' } },
    { r: 1, c: 3, v: { f: '=B2-C2', v: 16800, m: '16800', t: 'n' } },
    { r: 1, c: 4, v: { f: '=D2/B2*100', v: 34.85, m: '34.85', t: 'n' } },

    { r: 2, c: 0, v: { v: 'Feb 2026', m: 'Feb 2026', t: 's' } },
    { r: 2, c: 1, v: { v: 52800, m: '52800', t: 'n' } },
    { r: 2, c: 2, v: { v: 33100, m: '33100', t: 'n' } },
    { r: 2, c: 3, v: { f: '=B3-C3', v: 19700, m: '19700', t: 'n' } },
    { r: 2, c: 4, v: { f: '=D3/B3*100', v: 37.31, m: '37.31', t: 'n' } },

    { r: 3, c: 0, v: { v: 'Mar 2026', m: 'Mar 2026', t: 's' } },
    { r: 3, c: 1, v: { v: 61500, m: '61500', t: 'n' } },
    { r: 3, c: 2, v: { v: 35700, m: '35700', t: 'n' } },
    { r: 3, c: 3, v: { f: '=B4-C4', v: 25800, m: '25800', t: 'n' } },
    { r: 3, c: 4, v: { f: '=D4/B4*100', v: 41.95, m: '41.95', t: 'n' } },

    { r: 4, c: 0, v: { v: 'Apr 2026', m: 'Apr 2026', t: 's' } },
    { r: 4, c: 1, v: { v: 67200, m: '67200', t: 'n' } },
    { r: 4, c: 2, v: { v: 38900, m: '38900', t: 'n' } },
    { r: 4, c: 3, v: { f: '=B5-C5', v: 28300, m: '28300', t: 'n' } },
    { r: 4, c: 4, v: { f: '=D5/B5*100', v: 42.11, m: '42.11', t: 'n' } },

    { r: 5, c: 0, v: { v: 'May 2026', m: 'May 2026', t: 's' } },
    { r: 5, c: 1, v: { v: 73400, m: '73400', t: 'n' } },
    { r: 5, c: 2, v: { v: 41200, m: '41200', t: 'n' } },
    { r: 5, c: 3, v: { f: '=B6-C6', v: 32200, m: '32200', t: 'n' } },
    { r: 5, c: 4, v: { f: '=D6/B6*100', v: 43.87, m: '43.87', t: 'n' } },

    { r: 6, c: 0, v: { v: 'Jun 2026', m: 'Jun 2026', t: 's' } },
    { r: 6, c: 1, v: { v: 79100, m: '79100', t: 'n' } },
    { r: 6, c: 2, v: { v: 43600, m: '43600', t: 'n' } },
    { r: 6, c: 3, v: { f: '=B7-C7', v: 35500, m: '35500', t: 'n' } },
    { r: 6, c: 4, v: { f: '=D7/B7*100', v: 44.88, m: '44.88', t: 'n' } },

    // Total row
    { r: 7, c: 0, v: { v: 'TOTAL', m: 'TOTAL', t: 's', bl: 1 } },
    { r: 7, c: 1, v: { f: '=SUM(B2:B7)', v: 382200, m: '382200', t: 'n', bl: 1 } },
    { r: 7, c: 2, v: { f: '=SUM(C2:C7)', v: 223900, m: '223900', t: 'n', bl: 1 } },
    { r: 7, c: 3, v: { f: '=SUM(D2:D7)', v: 158300, m: '158300', t: 'n', bl: 1 } },
    { r: 7, c: 4, v: { f: '=D8/B8*100', v: 41.42, m: '41.42', t: 'n', bl: 1 } },
  ]

  writeJSON(path.join(DEMO_DATA_DIR, 'demo-sheet.json'), {
    id: 'demo-sheet',
    name: 'Revenue Tracker H1 2026',
    type: 'sheet',
    content: [
      {
        name: 'Revenue',
        celldata: sheetCells,
        config: {
          columnlen: { 0: 110, 1: 140, 2: 150, 3: 140, 4: 110 },
        },
        row: 10,
        column: 6,
      },
      {
        name: 'Notes',
        celldata: [
          { r: 0, c: 0, v: { v: 'All figures in South African Rand (ZAR)', m: 'All figures in South African Rand (ZAR)', t: 's' } },
          { r: 1, c: 0, v: { v: 'Exchange rate used: 1 USD = 18.4 ZAR (as of 2026-06-01)', m: 'Exchange rate used: 1 USD = 18.4 ZAR (as of 2026-06-01)', t: 's' } },
        ],
        config: {},
        row: 5,
        column: 4,
      },
    ],
    created_at: twoDaysAgo,
    updated_at: yesterday,
  })

  // ── Slide deck ────────────────────────────────────────────────────────────
  writeJSON(path.join(DEMO_DATA_DIR, 'demo-slides.json'), {
    id: 'demo-slides',
    name: 'Diwan — Product Overview',
    type: 'slide',
    content: {
      themeId: 'obsidian',
      theme: 'black',
      transition: 'slide',
      masters: null,
      customTheme: null,
      slides: [
        {
          id: 'slide-1',
          master: 'title',
          title: 'Diwan',
          content: '<p><strong>Open-source productivity suite</strong><br>Documents · Sheets · Slides · PDF</p>',
          notes: 'Welcome! This deck gives a 5-minute overview of what Diwan is and why we built it.',
          bg: '',
        },
        {
          id: 'slide-2',
          master: 'content',
          title: 'The Problem',
          content: '<ul><li>Google Workspace and Microsoft 365 lock your data in the cloud</li><li>Most open-source suites are desktop-only or feel dated</li><li>No single tool combines docs, sheets, slides, and PDF without a vendor account</li></ul>',
          notes: 'Emphasise that this is about sovereignty — knowing where your data lives.',
          bg: '',
        },
        {
          id: 'slide-3',
          master: 'content',
          title: 'Our Answer: One Binary',
          content: '<ul><li>Single Go binary — run it anywhere in seconds</li><li>Zero telemetry, no cloud account required</li><li>SQLite by default, PostgreSQL when you scale</li><li>PWA-installable on any device</li></ul>',
          notes: 'The single binary story is the killer differentiator for self-hosters.',
          bg: '',
        },
        {
          id: 'slide-4',
          master: 'content',
          title: 'What\'s Inside',
          content: '<table><tr><th>Surface</th><th>Engine</th></tr><tr><td>Documents</td><td>TipTap (ProseMirror)</td></tr><tr><td>Sheets</td><td>Fortune Sheet</td></tr><tr><td>Slides</td><td>Reveal.js</td></tr><tr><td>PDF</td><td>pdf.js + pdf-lib</td></tr></table>',
          notes: 'Each surface is also available as an importable npm component via @vulos/office-client.',
          bg: '',
        },
        {
          id: 'slide-5',
          master: 'content',
          title: 'Roadmap Highlights',
          content: '<ul><li>Q3 2026 — offline-first CRDT sync for Docs</li><li>Q3 2026 — S3/Tigris object store integration</li><li>Q4 2026 — AI writing assistant (local model, opt-in)</li><li>Q4 2026 — Mobile-native PWA install flow</li></ul>',
          notes: 'These are the items the team voted as highest value in the last planning session.',
          bg: '',
        },
      ],
    },
    created_at: twoDaysAgo,
    updated_at: now,
  })

  // ── Whiteboard (Excalidraw scene) ──────────────────────────────────────────
  // A small architecture sketch so the whiteboard doc-type showcases real
  // shapes/arrows/text. Elements carry the full Excalidraw field set so the
  // canvas renders them without a restore pass.
  const wbEl = (o) => ({
    angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent',
    fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1,
    opacity: 100, groupIds: [], frameId: null, roundness: { type: 3 },
    seed: Math.floor(Math.random() * 2 ** 31), versionNonce: Math.floor(Math.random() * 2 ** 31),
    isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false,
    version: 1, ...o,
  })
  const wbText = (o) => wbEl({
    type: 'text', fontSize: 20, fontFamily: 1, textAlign: 'center', verticalAlign: 'middle',
    baseline: 18, containerId: null, originalText: o.text, lineHeight: 1.25, roundness: null,
    ...o,
  })
  writeJSON(path.join(DEMO_DATA_DIR, 'demo-board.json'), {
    id: 'demo-board',
    name: 'Diwan — Architecture Sketch',
    type: 'whiteboard',
    content: {
      type: 'excalidraw',
      elements: [
        wbEl({ id: 'box-client', type: 'rectangle', x: 120, y: 140, width: 220, height: 90, index: 'a0', backgroundColor: '#a5d8ff' }),
        wbText({ id: 't-client', x: 150, y: 172, width: 160, height: 25, index: 'a1', text: 'Browser (P2P peer)', strokeColor: '#1e1e1e' }),
        wbEl({ id: 'box-box', type: 'rectangle', x: 500, y: 140, width: 220, height: 90, index: 'a2', backgroundColor: '#b2f2bb' }),
        wbText({ id: 't-box', x: 540, y: 172, width: 140, height: 25, index: 'a3', text: 'Vulos OS box', strokeColor: '#1e1e1e' }),
        wbEl({ id: 'box-relay', type: 'rectangle', x: 310, y: 360, width: 220, height: 90, index: 'a4', backgroundColor: '#ffec99' }),
        wbText({ id: 't-relay', x: 330, y: 384, width: 180, height: 42, index: 'a5', text: 'Content-blind relay\n(hard-NAT fallback)', strokeColor: '#1e1e1e', height: 42 }),
        wbEl({ id: 'arrow-1', type: 'arrow', x: 345, y: 185, width: 150, height: 0, index: 'a6', points: [[0, 0], [150, 0]], strokeColor: '#1971c2', roundness: null, startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: 'arrow' }),
        wbText({ id: 't-e2e', x: 360, y: 150, width: 120, height: 20, index: 'a7', text: 'E2E WebRTC', fontSize: 16, strokeColor: '#1971c2', height: 20 }),
        wbEl({ id: 'arrow-2', type: 'arrow', x: 260, y: 235, width: 120, height: 120, index: 'a8', points: [[0, 0], [120, 120]], strokeColor: '#e8590c', roundness: null, strokeStyle: 'dashed', startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: 'arrow' }),
        wbEl({ id: 'arrow-3', type: 'arrow', x: 580, y: 235, width: 120, height: 120, index: 'a9', points: [[0, 0], [-120, 120]], strokeColor: '#e8590c', roundness: null, strokeStyle: 'dashed', startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: 'arrow' }),
      ],
      files: {},
    },
    created_at: twoDaysAgo,
    updated_at: now,
  })

  console.log(`  wrote static seed files → ${DEMO_DATA_DIR}`)
}

// ── Local-drive demo files ──────────────────────────────────────────────────
// Populate a sandboxed HOME so the "on your computer" scanner shows a tidy,
// fabricated set of files. Content is a tiny placeholder string — the scanner
// only reads name/size/mtime, never the bytes — so `.docx`/`.xlsx` etc. can be
// plain text stubs.
export function seedLocalDriveFiles(homeDir = DEMO_HOME_DIR) {
  const stub = (label) =>
    `Diwan demo file — ${label}. Fabricated sample data for screenshots; not a real document.\n`

  const layout = {
    Documents: [
      'Q3 Planning Notes.md',
      'Onboarding Guide.docx',
      'Product Roadmap.md',
      'Revenue Model 2026.xlsx',
      'Team Offsite Deck.pptx',
      'Brand Guidelines.pdf',
      'Release Checklist.md',
      'Meeting Notes — 2026-06-12.md',
    ],
    Downloads: [
      'Partnership Agreement.pdf',
      'Analytics Export.csv',
      'Design Review.pptx',
    ],
    Desktop: [
      'Scratchpad.txt',
      'Invoice Template.xlsx',
    ],
  }

  for (const [sub, files] of Object.entries(layout)) {
    const dir = path.join(homeDir, sub)
    ensureDir(dir)
    for (const f of files) {
      writeFileSync(path.join(dir, f), stub(f), 'utf8')
    }
  }

  console.log(`  wrote local-drive demo files → ${homeDir}`)
}

// ── Main (standalone) ─────────────────────────────────────────────────────────
async function main() {
  console.log('\nDiwan — demo seeder')
  console.log(`  data dir : ${DEMO_DATA_DIR}`)
  console.log(`  home dir : ${DEMO_HOME_DIR}`)

  seedStaticFiles()
  seedLocalDriveFiles()

  console.log('\nSeed done.\n')
}

// Only run main() when invoked directly, not when imported.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(e => { console.error('Fatal:', e); process.exit(1) })
}
