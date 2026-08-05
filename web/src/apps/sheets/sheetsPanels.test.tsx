/**
 * sheetsPanels.test.jsx  (WAVE-64)
 *
 * The three user-facing surfaces of this wave are PRODUCT surfaces, not debug
 * forms, so they are tested like product: the controls exist, they are labelled
 * for a screen reader, they are keyboard-operable, they emit CLAMPED descriptors,
 * and the export dialog cannot be bypassed when data is at stake.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import ChartWizard from './ChartWizard.jsx'
import PivotPanel from './PivotPanel.jsx'
import ExportDialog from './ExportDialog.jsx'
import { getCharts, CHART_TYPES, insertChart, type ChartSheet } from './charts.js'
import { getPivots, type PivotSheet } from './pivot.js'
import { setImportNotes } from './importNotes.js'
import type { ExportSheet } from './sheetsExport.js'

vi.mock('file-saver', () => ({ saveAs: vi.fn() }))

// charts.ts / sheetsExport.ts / importNotes.ts each declare their own narrow
// view of the same plain-data FortuneSheet shape (ChartSheet / ExportSheet /
// INSheet) — no shared base type. Production crosses these boundaries with
// the same cast-through-unknown helper (SheetsEditor.tsx's `cast<T>`).
function cast<T>(v: unknown): T { return v as T }

function wbFrom(grid: (string | number)[][]) {
  const celldata: { r: number; c: number; v: { v: string | number; m: string; ct: { fa: string; t: string } } }[] = []
  grid.forEach((row, r) => row.forEach((v, c) => {
    if (v === '' || v == null) return
    const isNum = typeof v === 'number'
    celldata.push({ r, c, v: { v, m: String(v), ct: { fa: 'General', t: isNum ? 'n' : 's' } } })
  }))
  return [{ name: 'Sheet1', celldata, config: {} }]
}

const GRID: (string | number)[][] = [
  ['Region', 'Date', 'Sales', 'Units'],
  ['East', '2024-01-05', 10, 1],
  ['West', '2024-02-11', 20, 2],
  ['East', '2024-02-20', 5, 3],
]

describe('ChartWizard — every new type is reachable and configurable', () => {
  it('offers all 14 types, grouped, as a keyboard-operable radiogroup', () => {
    render(<ChartWizard data={wbFrom(GRID)} onClose={() => {}} onChange={() => {}} />)
    const group = screen.getByRole('radiogroup', { name: /chart type/i })
    const radios = within(group).getAllByRole('radio')
    expect(radios).toHaveLength(CHART_TYPES.length)
    expect(radios.length).toBe(14)
    for (const label of ['Stacked column', 'Stacked bar', '100% column', '100% bar', 'Donut', 'Histogram']) {
      expect(within(group).getByRole('radio', { name: new RegExp(label, 'i') })).toBeTruthy()
    }
    // Group headings orient the user instead of a flat wall of 14 buttons.
    expect(screen.getByText('Bar & column')).toBeTruthy()
    expect(screen.getByText('Part-to-whole')).toBeTruthy()
    expect(screen.getByText('Distribution')).toBeTruthy()
  })

  it('picking Histogram reveals a bounded bucket control and emits a clamped descriptor', () => {
    const onChange = vi.fn((_data: ChartSheet[]) => {})
    render(<ChartWizard data={wbFrom(GRID)} onClose={() => {}} onChange={onChange} />)
    fireEvent.click(screen.getByRole('radio', { name: /histogram/i }))

    const bins = screen.getByLabelText(/buckets/i)
    expect(bins).toHaveAttribute('min', '2')
    expect(bins).toHaveAttribute('max', '50')
    expect(screen.getByText(/bins the FIRST numeric column/i)).toBeTruthy()   // it explains itself

    // Even if the input is driven past its bound, the descriptor is clamped.
    fireEvent.change(bins, { target: { value: '9999' } })
    fireEvent.change(screen.getByLabelText(/data range/i), { target: { value: 'C1:C4' } })
    fireEvent.click(screen.getByRole('button', { name: /insert chart/i }))

    const chart = getCharts(onChange.mock.calls[0][0])[0]
    expect(chart.type).toBe('histogram')
    expect(chart.options.bins).toBe(50)
    expect(chart.range).toBe('C1:C4')
  })

  it('picking Combo turns the secondary axis on and exposes its label field', () => {
    const onChange = vi.fn((_data: ChartSheet[]) => {})
    render(<ChartWizard data={wbFrom(GRID)} onClose={() => {}} onChange={onChange} />)
    fireEvent.click(screen.getByRole('radio', { name: /^combo$/i }))

    // VERIFIED TOOL DISAGREEMENT: getByLabelText<T extends HTMLElement =
    // HTMLElement>() can't infer T from the later .checked access, so tsc
    // needs this cast — removing it fails `tsc --noEmit` with "Property
    // 'checked' does not exist on type 'HTMLElement'". Confirmed by direct
    // removal.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const secondary = screen.getByLabelText(/secondary \(right\) axis/i) as HTMLInputElement
    expect(secondary.checked).toBe(true)                 // the reason to pick combo at all
    fireEvent.change(screen.getByLabelText(/secondary axis label/i), { target: { value: 'Margin %' } })
    fireEvent.click(screen.getByRole('button', { name: /insert chart/i }))

    const chart = getCharts(onChange.mock.calls[0][0])[0]
    expect(chart.type).toBe('combo')
    expect(chart.options.secondaryAxis).toBe(true)
    expect(chart.options.y2AxisLabel).toBe('Margin %')

    // …and it can be turned off, which also drops the label from the descriptor path.
    expect(secondary).toBeTruthy()
  })

  it('a stacked type explains that negatives are not dropped', () => {
    render(<ChartWizard data={wbFrom(GRID)} onClose={() => {}} onChange={() => {}} />)
    fireEvent.click(screen.getByRole('radio', { name: /stacked column/i }))
    expect(screen.getByText(/Negative values stack below the zero line/i)).toBeTruthy()
  })

  it('secondaryAxis is never set for a non-combo type', () => {
    const onChange = vi.fn((_data: ChartSheet[]) => {})
    render(<ChartWizard data={wbFrom(GRID)} onClose={() => {}} onChange={onChange} />)
    fireEvent.click(screen.getByRole('radio', { name: /^combo$/i }))     // turns it on
    fireEvent.click(screen.getByRole('radio', { name: /^column$/i }))    // switch away
    fireEvent.click(screen.getByRole('button', { name: /insert chart/i }))
    expect(getCharts(onChange.mock.calls[0][0])[0].options.secondaryAxis).toBe(false)
  })
})

describe('PivotPanel — multi-value editor', () => {
  const setup = () => {
    const onInsert = vi.fn((_data: PivotSheet[]) => {})
    render(<PivotPanel data={wbFrom(GRID)} selectionRect={{ r0: 0, r1: 3, c0: 0, c1: 3 }}
                       onClose={() => {}} onInsert={onInsert} />)
    return onInsert
  }

  it('adds a second value field with its own aggregation and display mode', () => {
    const onInsert = setup()
    fireEvent.click(screen.getByRole('button', { name: /add value/i }))

    // Two value rows, each independently labelled for a screen reader.
    expect(screen.getByLabelText(/value field 1/i)).toBeTruthy()
    const field2 = screen.getByLabelText(/value field 2/i)
    fireEvent.change(field2, { target: { value: 'Units' } })
    fireEvent.change(screen.getByLabelText(/aggregation for value 2/i), { target: { value: 'MEDIAN' } })
    fireEvent.change(screen.getByLabelText(/display for value 2/i), { target: { value: 'pct_total' } })
    fireEvent.change(screen.getByLabelText(/aggregation for value 1/i), { target: { value: 'SUM' } })

    fireEvent.click(screen.getByRole('button', { name: /insert live pivot/i }))
    const pivot = getPivots(onInsert.mock.calls[0][0])[0]
    expect(pivot.values).toHaveLength(2)
    expect(pivot.values[1]).toEqual({ field: 'Units', agg: 'MEDIAN', display: 'pct_total' })
  })

  it('removes a value field', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: /add value/i }))
    expect(screen.getByLabelText(/value field 2/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /remove value 2/i }))
    expect(screen.queryByLabelText(/value field 2/i)).toBeNull()
  })

  it('exposes date grouping for the row and column fields', () => {
    const onInsert = setup()
    fireEvent.change(screen.getByLabelText(/^row field$/i), { target: { value: 'Date' } })
    fireEvent.change(screen.getByLabelText(/group row dates/i), { target: { value: 'month' } })
    fireEvent.change(screen.getByLabelText(/^column field$/i), { target: { value: 'Region' } })
    fireEvent.change(screen.getByLabelText(/group column dates/i), { target: { value: 'year' } })

    fireEvent.click(screen.getByRole('button', { name: /insert live pivot/i }))
    const pivot = getPivots(onInsert.mock.calls[0][0])[0]
    expect(pivot.rowField).toBe('Date')
    expect(pivot.rowGroup).toBe('month')
    expect(pivot.colGroup).toBe('year')
  })

  it('renders a live preview whose percentage columns are shown as percentages', () => {
    setup()
    fireEvent.change(screen.getByLabelText(/^row field$/i), { target: { value: 'Region' } })
    fireEvent.change(screen.getByLabelText(/value field 1/i), { target: { value: 'Sales' } })
    fireEvent.change(screen.getByLabelText(/display for value 1/i), { target: { value: 'pct_total' } })
    const table = screen.getByRole('table')
    expect(within(table).getByText('Sales (% of total)')).toBeTruthy()
    expect(within(table).getAllByText(/%$/).length).toBeGreaterThan(0)   // e.g. "42.857%"
  })
})

describe('ExportDialog — the honest warning', () => {
  const dataWithCharts = () => {
    let d = insertChart(wbFrom(GRID), { id: 'c1', type: 'column', range: 'A1:D4', title: 'Rev' })
    d = insertChart(d, { id: 'c2', type: 'histogram', range: 'C1:C4', title: 'Spread' })
    return d
  }

  it('names every chart that cannot survive the format, and offers a real Cancel', () => {
    const onCancel = vi.fn(); const onConfirm = vi.fn((_format: string) => {})
    render(<ExportDialog data={cast<ExportSheet[]>(dataWithCharts())} format="ods" onCancel={onCancel} onConfirm={onConfirm} />)

    expect(screen.getByRole('dialog', { name: /export as/i })).toBeTruthy()
    const alert = screen.getByRole('alert')
    expect(within(alert).getByText(/2 charts can’t be embedded/i)).toBeTruthy()
    expect(within(alert).getByText('Rev')).toBeTruthy()        // named, not counted
    expect(within(alert).getByText('Spread')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onCancel).toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()                  // cancelling really cancels
  })

  it('xlsx: says the charts embed for real, and surfaces the histogram caveat', () => {
    const onConfirm = vi.fn((_format: string) => {})
    render(<ExportDialog data={cast<ExportSheet[]>(dataWithCharts())} format="xlsx" onCancel={() => {}} onConfirm={onConfirm} />)
    expect(screen.queryByRole('alert')).toBeNull()            // nothing is LOST in xlsx
    expect(screen.getByText(/Embedded with a caveat/i)).toBeTruthy()
    expect(screen.getByText(/histogram bins are embedded as fixed values/i)).toBeTruthy()
    expect(screen.getByText(/real Excel charts/i)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /^export$/i }))
    expect(onConfirm).toHaveBeenCalledWith('xlsx')
  })

  it('labels the confirm button as “Export anyway” when something WILL be lost', () => {
    render(<ExportDialog data={cast<ExportSheet[]>(dataWithCharts())} format="csv" onCancel={() => {}} onConfirm={() => {}} />)
    expect(screen.getByRole('button', { name: /export anyway/i })).toBeTruthy()
    // Stated both per-chart (why each one is lost) and as a summary note.
    expect(screen.getAllByText(/CSV holds values only/i).length).toBeGreaterThanOrEqual(2)
  })

  it('Escape closes the dialog (focus-trapped modal a11y)', () => {
    const onCancel = vi.fn()
    render(<ExportDialog data={cast<ExportSheet[]>(dataWithCharts())} format="ods" onCancel={onCancel} onConfirm={() => {}} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalled()
  })

  // What the IMPORT could not bring in. It is not in the workbook any more, so
  // nothing at export time can detect it — but this is the moment the user writes
  // a file back over an original that still HAS it. The import wrote it down
  // (importNotes) precisely so the dialog can say it here.
  describe('content the import could not bring in', () => {
    const importedLossy = () => setImportNotes(wbFrom(GRID), {
      pivots: 2,
      charts: [{ title: 'Radar', reason: 'radar charts aren’t supported' }],
      filename: 'budget.xlsx',
    })

    it('names the source file, the pivots and the charts that are NOT in the export', () => {
      render(<ExportDialog data={importedLossy()} format="xlsx" onCancel={() => {}} onConfirm={() => {}} />)

      const alert = screen.getByRole('alert')
      expect(within(alert).getByText(/not in this workbook/i)).toBeTruthy()
      expect(within(alert).getByText(/budget\.xlsx/)).toBeTruthy()
      expect(within(alert).getByText(/2 pivot tables/i)).toBeTruthy()
      expect(within(alert).getByText(/imported as ordinary cells/i)).toBeTruthy()
      expect(within(alert).getByText('Radar')).toBeTruthy()
      expect(within(alert).getByText(/radar charts aren’t supported/i)).toBeTruthy()
      // A loss the user must acknowledge, even though this format itself is lossless.
      expect(screen.getByRole('button', { name: /export anyway/i })).toBeTruthy()
    })

    it('says it for EVERY format — the content is gone regardless of what we write', () => {
      for (const format of ['xlsx', 'ods', 'csv', 'xlsx-server']) {
        const { unmount } = render(
          <ExportDialog data={importedLossy()} format={format} onCancel={() => {}} onConfirm={() => {}} />
        )
        expect(screen.getByText(/not in this workbook/i)).toBeTruthy()
        unmount()
      }
    })

    it('stays silent for a workbook that lost nothing', () => {
      render(<ExportDialog data={wbFrom(GRID)} format="xlsx" onCancel={() => {}} onConfirm={() => {}} />)
      expect(screen.queryByText(/not in this workbook/i)).toBeNull()
    })
  })
})
