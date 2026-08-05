/**
 * MSW / RTL integration — Sheets.
 *
 * The full SheetsEditor embeds @fortune-sheet, whose canvas grid does not run
 * under jsdom (it hangs on HTMLCanvasElement.getContext). That interactive grid
 * flow — clicking a cell, typing, the formula bar — is covered by the Playwright
 * E2E layer, which runs in a real browser.
 *
 * Here we integration-test the parts of Sheets that DO run headless: the real
 * SheetsFindReplace component operating on the live cell-data model (a genuine
 * cell edit / value round-trip), and the presence pill derivation that drives
 * the Sheets ConnectionPill.
 */

import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SheetsFindReplace, { collectCells, findMatches, applyReplace, type FRSheet } from '../../apps/sheets/SheetsFindReplace.jsx'
import ConnectionPill from '../../components/ConnectionPill.jsx'
import { deriveStatusPill, countLivePeers } from '../../lib/collab/presenceCommon.js'

// FortuneSheet cell shape as this test reads it back — FRSheet's own
// FRCellEntry.v is a wide union (FRCellValue | string | number | boolean |
// null | undefined) that doesn't guarantee the object shape this fixture
// always uses, so a local, narrower type is cast at the two read sites below.
interface Cell {
  r: number
  c: number
  v: { v: string | number; m?: string; f?: string }
}

// A small workbook with a formula cell and a couple of literals.
function makeData() {
  return [{
    name: 'Sheet1',
    celldata: [
      { r: 0, c: 0, v: { v: 'Revenue', m: 'Revenue' } },
      { r: 0, c: 1, v: { v: 100, m: '100' } },
      { r: 1, c: 0, v: { v: 'Cost', m: 'Cost' } },
      { r: 1, c: 1, v: { v: 40, m: '40' } },
      // A formula cell: =B1-B2
      { r: 2, c: 1, v: { v: 60, m: '60', f: '=B1-B2' } },
    ],
    config: {},
  }]
}

describe('Sheets cell edit via Find/Replace (real component + model)', () => {
  it('replaces a cell value and returns updated cell data (edit round-trip)', () => {
    const data = makeData()
    const cells = collectCells(data)
    const idxs = findMatches(cells, 'Revenue', true)
    expect(idxs).toHaveLength(1)
    const next = applyReplace(data, cells, idxs, 'Revenue', 'Sales', true)
    const edited = (next[0].celldata as Cell[]).find((c) => c.r === 0 && c.c === 0)
    expect(edited!.v.v).toBe('Sales')
    // Non-matching cells (and the formula cell) are untouched.
    const formulaCell = (next[0].celldata as Cell[]).find((c) => c.r === 2 && c.c === 1)
    expect(formulaCell!.v.f).toBe('=B1-B2')
  })

  it('drives an edit through the SheetsFindReplace UI, calling onChange with new data', async () => {
    const data = makeData()
    let current: FRSheet[] = data
    // SheetsFindReplace's real onChange type is (data: FRSheet[]) => void — it
    // only ever calls onChange(newData) directly, never a setState-style
    // updater function.
    const onChange = (newData: FRSheet[]) => { current = newData }
    render(<SheetsFindReplace data={data} onChange={onChange} onClose={() => {}} />)

    // Reveal the replace row (toggle button carries aria-pressed).
    const toggle = screen.getByRole('button', { name: 'Replace', pressed: false })
    fireEvent.click(toggle)

    // Type a find term + replacement, then Replace All.
    const findInput = screen.getByPlaceholderText('Find…')
    await userEvent.type(findInput, 'Cost')
    const replaceInput = screen.getByPlaceholderText('Replace with…')
    await userEvent.type(replaceInput, 'Expense')

    fireEvent.click(screen.getByRole('button', { name: /Replace all/i }))

    await waitFor(() => {
      const edited = current[0].celldata.find((c) => c.r === 1 && c.c === 0)
      expect(edited!.v.v).toBe('Expense')
    })
  })
})

describe('Sheets presence pill', () => {
  it('renders "Live" with a peer count when a collaborator is connected', () => {
    const peers = { p2: 'connected' }
    const pill = deriveStatusPill({ configured: true, joined: true, peers })
    expect(pill.status).toBe('live')
    render(<ConnectionPill pill={pill} peerCount={countLivePeers(peers)} />)
    const el = screen.getByRole('status')
    expect(el).toHaveTextContent('Live')
    expect(el).toHaveAttribute('aria-label', expect.stringContaining('1 collaborator'))
  })

  it('renders a calm "Live" (solo) when connected with no peers', () => {
    const pill = deriveStatusPill({ configured: true, joined: true, peers: {} })
    expect(pill.status).toBe('solo')
    render(<ConnectionPill pill={pill} />)
    expect(screen.getByRole('status')).toHaveTextContent('Live')
  })
})
