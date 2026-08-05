/**
 * MSW / RTL integration — WAVE41 Sheets: data-validation panel + number-format
 * menu, driven through the REAL components against the live workbook model, plus
 * server persistence and XLSX-export carry.
 *
 * The @fortune-sheet canvas grid itself does NOT run under jsdom (it hangs on
 * HTMLCanvasElement.getContext), so the interactive grid rendering is covered by
 * the Playwright E2E layer. Here we drive the two wave-41 side-surfaces that DO
 * run headless — DataValidationPanel and NumberFormatMenu — through their real
 * React UI, asserting:
 *   • the data-validation form writes a native `sheet.dataVerification` rule and
 *     leaves cell VALUES untouched (so it never perturbs CRDT grid-sync);
 *   • the number-format menu stamps only cells' `ct` descriptor over the selection;
 *   • both survive a save round-trip (PUT /api/files/:id then re-GET);
 *   • the XLSX export carries the number-format code (ct.fa → worksheet cell.z).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as XLSX from 'xlsx'
import DataValidationPanel from '../../apps/sheets/DataValidationPanel.jsx'
import NumberFormatMenu from '../../apps/sheets/NumberFormatMenu.jsx'
import { listValidationRules, clampDataValidation, type Regulation } from '../../apps/sheets/dataValidation.js'
import { detectPresetId } from '../../apps/sheets/numberFormats.js'
import { exportSheetsToXlsx } from '../../apps/sheets/sheetsExport.js'
import { api } from '../../lib/api.js'
import { server, resetMock, mockState } from './server.js'

vi.mock('file-saver', () => ({ saveAs: vi.fn() }))
import { saveAs } from 'file-saver'

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

// A small local plain-data sheet shape covering every field this file reads or
// writes across DataValidationPanel (DVSheet), NumberFormatMenu (SheetData) and
// exportSheetsToXlsx (ExportSheet) — charts.ts/dataValidation.ts/numberFormats.ts/
// sheetsExport.ts each declare their own narrow view of the same FortuneSheet
// shape (all carry a permissive index signature), so this single concrete shape
// is structurally assignable to each without a cast.
interface TestCell {
  r: number
  c: number
  v: { v: string | number; m: string; ct?: { fa: string; t: string } }
  [key: string]: unknown
}
interface TestSheet {
  name: string
  celldata: TestCell[]
  config: Record<string, never>
  dataVerification?: Record<string, unknown>
  [key: string]: unknown
}

// The panels hand their onChange callback back the same object, restated at
// their own (looser) declared parameter type (DVSheet[] / SheetData[]) — cast
// through unknown at that boundary, the same pattern SheetsEditor.tsx's own
// `cast<T>` uses to cross these sibling narrow-view types.
function cast<T>(v: unknown): T { return v as T }

/** Read a written regulation back out, typed — dataVerification is deliberately
 * `Record<string, unknown>` in production (it must accept a poisoned/partial
 * record from an untrusted file), so tests that read a rule they just wrote
 * assert against the real `Regulation` shape at the boundary. */
function reg(sheet: TestSheet, key: string): Regulation {
  return (sheet.dataVerification as Record<string, Regulation>)[key]
}

// A small workbook: a couple of numeric literals + one label. The Fortune-Sheet
// shape (celldata with r/c/v; per-sheet dataVerification map).
function makeWorkbook(): TestSheet[] {
  return [{
    name: 'Sheet1',
    celldata: [
      { r: 0, c: 0, v: { v: 'Priority', m: 'Priority' } },
      { r: 0, c: 1, v: { v: 1200.5, m: '1200.5' } },
      { r: 1, c: 1, v: { v: 0.25, m: '0.25' } },
    ],
    config: {},
  }]
}

beforeEach(() => {
  resetMock({ role: 'owner' })
  // Seed a sheet file so the save round-trip has something to PUT to.
  mockState.files.sh1 = { id: 'sh1', name: 'Budget', type: 'sheet', content: makeWorkbook() }
  vi.mocked(saveAs).mockClear()
})

// ── Data-validation panel: writes a rule, leaves the grid values untouched ────

describe('WAVE41 data validation panel (real component + model)', () => {
  it('creates a dropdown rule → native dataVerification metadata, cell values unchanged', async () => {
    let data = makeWorkbook()
    const onChange = (next: unknown) => { data = cast<TestSheet[]>(next) }
    render(
      <DataValidationPanel
        data={data}
        activeCell={{ row: 0, col: 0 }}
        onClose={() => {}}
        onChange={onChange}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Add rule/i }))
    // Default criteria is "dropdown" — fill items + range and save.
    await userEvent.type(screen.getByLabelText('Items (comma-separated)'), 'Low, Medium, High')
    const range = screen.getByLabelText('Apply to range')
    fireEvent.change(range, { target: { value: 'A1:A3' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))

    // Metadata written across the range, grouped into one rule for A1:A3.
    const rules = listValidationRules(data[0])
    expect(rules).toHaveLength(1)
    expect(rules[0].summary).toBe('Dropdown · 3 items')
    expect(rules[0].count).toBe(3)
    expect(reg(data[0], '0_0').type).toBe('dropdown')

    // Grid values are UNAFFECTED — no cell v was touched (CRDT-sync safe).
    expect(data[0].celldata).toEqual(makeWorkbook()[0].celldata)
  })

  it('creates a number-range rule (between) via the form', async () => {
    let data = makeWorkbook()
    render(
      <DataValidationPanel
        data={data}
        activeCell={{ row: 0, col: 1 }}
        onClose={() => {}}
        onChange={(next: unknown) => { data = cast<TestSheet[]>(next) }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Add rule/i }))
    // Switch criteria to Number.
    fireEvent.change(screen.getByLabelText('Criteria'), { target: { value: 'number' } })
    // "between" is the default condition (needs two values).
    await userEvent.type(screen.getByLabelText('Value'), '0')
    await userEvent.type(screen.getByLabelText('Upper value'), '100')
    fireEvent.change(screen.getByLabelText('Apply to range'), { target: { value: 'B1' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))

    const rules = listValidationRules(data[0])
    expect(rules).toHaveLength(1)
    expect(rules[0].summary).toBe('Number between 0 and 100')
    expect(reg(data[0], '0_1')).toMatchObject({ type: 'number', type2: 'between', value1: '0', value2: '100' })
  })

  it('surfaces a validation error for an empty dropdown (no rule written)', async () => {
    let data = makeWorkbook()
    render(
      <DataValidationPanel data={data} activeCell={{ row: 0, col: 0 }} onClose={() => {}} onChange={(n: unknown) => { data = cast<TestSheet[]>(n) }} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Add rule/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/at least one dropdown item/i)
    expect(data[0].dataVerification).toBeUndefined()
  })
})

// ── WAVE-64: the rest of the validation kinds, through the same real panel ────

describe('WAVE64 data validation kinds (real component + model)', () => {
  function panel() {
    let data = makeWorkbook()
    const view = render(
      <DataValidationPanel
        data={data}
        activeCell={{ row: 0, col: 0 }}
        onClose={() => {}}
        onChange={(next: unknown) => { data = cast<TestSheet[]>(next) }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Add rule/i }))
    return { view, get: () => data }
  }

  it('offers every advertised kind in the criteria menu', () => {
    panel()
    // VERIFIED TOOL DISAGREEMENT: getByLabelText<T extends HTMLElement =
    // HTMLElement>() can't infer T from this later .options access (generic
    // inference only looks at the call's own arguments), so tsc needs this
    // cast — removing it fails `tsc --noEmit` with "Property 'options' does
    // not exist on type 'HTMLElement'". Confirmed by direct removal.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const values = Array.from((screen.getByLabelText('Criteria') as HTMLSelectElement).options).map((o) => o.value)
    expect(values).toEqual(['dropdown', 'dropdownRange', 'checkbox', 'number', 'date', 'text', 'textLength'])
  })

  it('dropdown from a RANGE (cross-sheet) → a native dropdown whose list source is the range', () => {
    const { get } = panel()
    fireEvent.change(screen.getByLabelText('Criteria'), { target: { value: 'dropdownRange' } })
    fireEvent.change(screen.getByLabelText('List source range'), { target: { value: 'Sheet2!A1:A5' } })
    fireEvent.change(screen.getByLabelText('Apply to range'), { target: { value: 'A1:A2' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))

    const rules = listValidationRules(get()[0])
    expect(rules).toHaveLength(1)
    expect(rules[0].summary).toBe('Dropdown · from Sheet2!A1:A5')
    expect(reg(get()[0], '0_0')).toMatchObject({ type: 'dropdown', value1: 'Sheet2!A1:A5' })
    // Cell values are untouched (CRDT-sync safe), as with every other rule.
    expect(get()[0].celldata).toEqual(makeWorkbook()[0].celldata)
  })

  it('checkbox → a two-value rule that rejects anything else', () => {
    const { get } = panel()
    fireEvent.change(screen.getByLabelText('Criteria'), { target: { value: 'checkbox' } })
    fireEvent.change(screen.getByLabelText('Checked value'), { target: { value: 'Yes' } })
    fireEvent.change(screen.getByLabelText('Unchecked value'), { target: { value: 'No' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))

    expect(listValidationRules(get()[0])[0].summary).toBe('Checkbox · Yes / No')
    expect(reg(get()[0], '0_0')).toMatchObject({ value1: 'Yes,No', prohibitInput: true, checkbox: true })
  })

  it('date between → a native date rule with both operands', () => {
    const { get } = panel()
    fireEvent.change(screen.getByLabelText('Criteria'), { target: { value: 'date' } })
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: '2026-01-01' } })
    fireEvent.change(screen.getByLabelText('Upper value'), { target: { value: '2026-12-31' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))

    expect(reg(get()[0], '0_0')).toMatchObject({
      type: 'date', type2: 'between', value1: '2026-01-01', value2: '2026-12-31',
    })
    expect(listValidationRules(get()[0])[0].summary).toBe('Date between 2026-01-01 and 2026-12-31')
  })

  it('text contains → a native text_content rule', () => {
    const { get } = panel()
    fireEvent.change(screen.getByLabelText('Criteria'), { target: { value: 'text' } })
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'INV-' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    expect(reg(get()[0], '0_0')).toMatchObject({ type: 'text_content', type2: 'include', value1: 'INV-' })
  })

  it('text length → a native text_length rule, and switching criteria resets the condition', () => {
    const { get } = panel()
    fireEvent.change(screen.getByLabelText('Criteria'), { target: { value: 'text' } })
    expect(screen.getByLabelText('Condition')).toHaveValue('include')
    // Switching to a kind with a different condition vocabulary must not carry the
    // old token over (a `text_length` rule with type2 'include' would never match).
    fireEvent.change(screen.getByLabelText('Criteria'), { target: { value: 'textLength' } })
    expect(screen.getByLabelText('Condition')).toHaveValue('between')
    fireEvent.change(screen.getByLabelText('Condition'), { target: { value: 'lessThanOrEqualTo' } })
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    expect(reg(get()[0], '0_0')).toMatchObject({ type: 'text_length', type2: 'lessThanOrEqualTo', value1: '10' })
  })

  it('a hostile/unusable operand surfaces an error and writes NOTHING', async () => {
    const { get } = panel()
    fireEvent.change(screen.getByLabelText('Criteria'), { target: { value: 'dropdownRange' } })
    fireEvent.change(screen.getByLabelText('List source range'), { target: { value: 'javascript:alert(1)' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/valid source range/i)
    expect(get()[0].dataVerification).toBeUndefined()

    fireEvent.change(screen.getByLabelText('Criteria'), { target: { value: 'date' } })
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: '2026-99-99' } })
    fireEvent.change(screen.getByLabelText('Upper value'), { target: { value: 'whenever' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/valid date/i)
    expect(get()[0].dataVerification).toBeUndefined()
  })

  it('a poisoned dataVerification map from a loaded file is clamped away', () => {
    const wb = makeWorkbook()
    wb[0].dataVerification = {
      '0_0': { type: 'dropdown', type2: '', value1: 'a,b', value2: '', prohibitInput: true, hintShow: false, hintValue: '', validity: '', rangeTxt: '', remote: false },
      '0_1': { type: 'validity', type2: 'identificationNumber', value1: '', value2: '' },
      '0_2': { type: 'number', type2: 'evil', value1: '1', value2: '' },
    }
    const clamped = clampDataValidation(wb)
    expect(Object.keys(clamped[0].dataVerification!)).toEqual(['0_0'])
    expect(listValidationRules(clamped[0])[0].summary).toBe('Dropdown · 2 items')
  })
})

// ── Number-format menu: applies a preset to the selection ─────────────────────

describe('WAVE41 number-format menu (real component + model)', () => {
  it('applies a currency preset to the selection → only ct rewritten', async () => {
    let data = makeWorkbook()
    render(
      <NumberFormatMenu
        selection={{ r0: 0, r1: 1, c0: 1, c1: 1 }}
        activeCell={{ row: 0, col: 1 }}
        data={data}
        onChange={(next: unknown) => { data = cast<TestSheet[]>(next) }}
      />,
    )
    // Open the menu and pick Currency ($).
    fireEvent.click(screen.getByRole('button', { name: /Number format/i }))
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Currency \(\$\)/ }))

    const b1 = data[0].celldata.find((c) => c.r === 0 && c.c === 1)!
    const b2 = data[0].celldata.find((c) => c.r === 1 && c.c === 1)!
    expect(b1.v.ct).toEqual({ fa: '"$"#,##0.00', t: 'n' })
    expect(b2.v.ct).toEqual({ fa: '"$"#,##0.00', t: 'n' })
    // Raw values are untouched (transparent to CRDT sync).
    expect(b1.v.v).toBe(1200.5)
    expect(b2.v.v).toBe(0.25)
    // The label cell (A1, out of the B-column selection) is unformatted.
    expect(data[0].celldata.find((c) => c.r === 0 && c.c === 0)!.v.ct).toBeUndefined()
  })

  it('reflects the active cell\'s current format as the checked radio', async () => {
    const data = makeWorkbook()
    // Pre-format B1 as percent so the menu should highlight it.
    data[0].celldata.find((c) => c.r === 0 && c.c === 1)!.v.ct = { fa: '0.00%', t: 'n' }
    render(<NumberFormatMenu selection={null} activeCell={{ row: 0, col: 1 }} data={data} onChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /Number format/i }))
    const percent = await screen.findByRole('menuitemradio', { name: /^Percent$/ })
    expect(percent).toHaveAttribute('aria-checked', 'true')
    expect(detectPresetId(data[0].celldata.find((c) => c.r === 0 && c.c === 1)!.v)).toBe('percent')
  })
})

// ── Persistence: both survive a save (PUT) → re-GET round-trip ─────────────────

describe('WAVE41 persistence through save (MSW round-trip)', () => {
  it('a validation rule + number format saved via PUT come back on re-GET', async () => {
    const wb = makeWorkbook()
    // Apply a dropdown rule to A1 and a currency format to B1 directly on the model
    // (the panels' onChange is unit-covered above); here we assert the PERSISTENCE.
    wb[0].dataVerification = { '0_0': { type: 'dropdown', type2: '', value1: 'a,b', value2: '', prohibitInput: true } }
    wb[0].celldata.find((c) => c.r === 0 && c.c === 1)!.v.ct = { fa: '"$"#,##0.00', t: 'n' }

    await api.updateFile('sh1', 'Budget', wb)
    expect(mockState.calls).toContain('PUT /files/sh1')

    const reloaded = cast<{ content: TestSheet[] }>(await api.getFile('sh1'))
    const sheet = reloaded.content[0]
    expect(reg(sheet, '0_0').type).toBe('dropdown')
    expect(sheet.celldata.find((c) => c.r === 0 && c.c === 1)!.v.ct!.fa).toBe('"$"#,##0.00')
  })
})

// ── XLSX export carries the number format (ct.fa → worksheet cell.z) ───────────

describe('WAVE41 XLSX export carries the number format', () => {
  it('a currency-formatted cell exports with its format code in the real .xlsx', async () => {
    const wb = makeWorkbook()
    wb[0].celldata.find((c) => c.r === 0 && c.c === 1)!.v.ct = { fa: '"$"#,##0.00', t: 'n' }
    // An unformatted numeric cell must NOT carry a `z` (General is the default).
    // (B2 keeps its raw 0.25 with no ct.)

    // WAVE-64: the exporter is async — it re-opens the ZIP SheetJS produced to
    // inject the real OOXML chart parts before handing the Blob to saveAs.
    await exportSheetsToXlsx(wb, 'Budget')
    expect(vi.mocked(saveAs)).toHaveBeenCalledTimes(1)

    // Parse the ACTUAL Blob the real exporter handed to saveAs, so this asserts
    // the full exportSheetsToXlsx → XLSX.write → Blob path (not a re-implementation).
    const [blob, filename] = vi.mocked(saveAs).mock.calls[0] as [Blob, string]
    expect(filename).toBe('Budget.xlsx')
    const buf = await blob.arrayBuffer()
    const parsed = XLSX.read(new Uint8Array(buf), { type: 'array', cellNF: true })
    const ws = parsed.Sheets[parsed.SheetNames[0]]

    // ws['B1']/['B2'] hit WorkSheet's own [cell: string]: CellObject | WSKeys | any
    // index signature, which resolves to any by TS's rules — cast the reads.
    expect((ws['B1'] as XLSX.CellObject).z).toBe('"$"#,##0.00') // currency format carried through
    // The unformatted cell did NOT inherit the currency format (xlsx read-back
    // may fill 'General' as its default; the point is it's not our custom code).
    expect((ws['B2'] as XLSX.CellObject).z).not.toBe('"$"#,##0.00')
    expect((ws['B2'] as XLSX.CellObject).v).toBe(0.25) // raw value preserved
  })
})
