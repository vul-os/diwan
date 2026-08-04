/**
 * conditionalFormatPanel.test.jsx  (WAVE-64)
 *
 * The conditional-format panel driven through its REAL UI: every rule family is
 * reachable, a rule round-trips (create → list → re-open → edit), an unfinished
 * rule surfaces an error instead of writing junk, and whatever the panel writes
 * is a CLAMPED descriptor that renders into a safe native paint instruction.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import ConditionalFormatPanel from './ConditionalFormatPanel.jsx'
import { getColorScales, buildNativeConditionFormat, CS_KINDS, type CSSheet, type ColorScaleRule, type NativeConditionFormat } from './colorScales.js'

function cast<T>(v: unknown): T { return v as T }

function workbook(colorScales?: ColorScaleRule[]): CSSheet[] {
  return [{
    name: 'Sheet1',
    celldata: [
      { r: 0, c: 0, v: { v: 5, m: '5', ct: { t: 'n' } } },
      { r: 1, c: 0, v: { v: 15, m: '15', ct: { t: 'n' } } },
      { r: 2, c: 0, v: { v: 'overdue', m: 'overdue', ct: { t: 's' } } },
    ],
    config: {},
    row: 100,
    column: 26,
    ...(colorScales ? { colorScales } : {}),
  }]
}

/** Render the panel over a mutable workbook; returns a getter for the latest data. */
function mount(initial: CSSheet[] = workbook()) {
  let data = initial
  const onColorScaleChange = vi.fn((next: CSSheet[]) => { data = next })
  const view = render(
    <ConditionalFormatPanel
      data={data}
      onClose={() => {}}
      onChange={(next) => { data = next }}
      onColorScaleChange={onColorScaleChange}
    />,
  )
  return { view, get: () => data, onColorScaleChange, rerender: () => view.rerender(
    <ConditionalFormatPanel data={data} onClose={() => {}} onChange={() => {}} onColorScaleChange={onColorScaleChange} />,
  ) }
}

describe('ConditionalFormatPanel — rule list', () => {
  it('shows an empty state and an Add rule affordance', () => {
    mount()
    expect(screen.getByText(/No rules yet/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Add rule/i })).toBeInTheDocument()
  })

  it('offers every registered rule kind in the condition menu', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: /Add rule/i }))
    const select = screen.getByLabelText(/Format cells if/i)
    const values = within(select).getAllByRole('option').map((o) => (o as HTMLOptionElement).value)
    expect(values.sort()).toEqual([...CS_KINDS].sort())
  })
})

describe('ConditionalFormatPanel — writes a clamped rule', () => {
  it('creates a numeric rule and stores it as plain, clamped data', () => {
    const { get } = mount()
    fireEvent.click(screen.getByRole('button', { name: /Add rule/i }))
    fireEvent.change(screen.getByLabelText(/Apply to range/i), { target: { value: 'A1:A3' } })
    fireEvent.change(screen.getByLabelText(/Format cells if/i), { target: { value: 'greaterThan' } })
    fireEvent.change(screen.getByLabelText(/^Value$/i), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))

    const rules = getColorScales(get())
    expect(rules).toHaveLength(1)
    expect(rules[0]).toMatchObject({ kind: 'greaterThan', range: 'A1:A3', value1: '10' })
    expect(rules[0].fill).toMatch(/^#[0-9a-f]{3,6}$/)
    expect(rules[0].id).toBeTruthy()
    expect(JSON.parse(JSON.stringify(rules[0]))).toEqual(rules[0]) // CRDT-safe

    // …and it renders into a safe native paint instruction.
    const native = buildNativeConditionFormat({ ...get()[0], colorScales: rules }, undefined)
    expect(native).toHaveLength(1)
    expect(native[0].cellrange).toEqual([{ row: [1, 1], column: [0, 0] }]) // only A2 (15) > 10
  })

  it('creates a text rule (second operand hidden) and a between rule (both shown)', () => {
    const { get } = mount()
    fireEvent.click(screen.getByRole('button', { name: /Add rule/i }))
    fireEvent.change(screen.getByLabelText(/Format cells if/i), { target: { value: 'textContains' } })
    expect(screen.queryByLabelText(/^To$/)).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/Apply to range/i), { target: { value: 'A1:A3' } })
    fireEvent.change(screen.getByLabelText(/^Value$/i), { target: { value: 'overdue' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    expect(getColorScales(get())[0]).toMatchObject({ kind: 'textContains', value1: 'overdue' })

    fireEvent.click(screen.getByRole('button', { name: /Add rule/i }))
    fireEvent.change(screen.getByLabelText(/Format cells if/i), { target: { value: 'between' } })
    expect(screen.getByLabelText(/^From$/)).toBeInTheDocument()
    expect(screen.getByLabelText(/^To$/)).toBeInTheDocument()
  })

  it('a kind with no operand (is empty) hides the value inputs entirely', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: /Add rule/i }))
    fireEvent.change(screen.getByLabelText(/Format cells if/i), { target: { value: 'isEmpty' } })
    expect(screen.queryByLabelText(/^Value$/i)).not.toBeInTheDocument()
    expect(screen.getByLabelText(/^Fill$/i)).toBeInTheDocument()
  })

  it('a custom-formula rule gets a formula field, and the formula is stored verbatim', () => {
    const { get } = mount()
    fireEvent.click(screen.getByRole('button', { name: /Add rule/i }))
    fireEvent.change(screen.getByLabelText(/Format cells if/i), { target: { value: 'formula' } })
    fireEvent.change(screen.getByLabelText(/Apply to range/i), { target: { value: 'A1:A3' } })
    fireEvent.change(screen.getByLabelText(/Custom formula/i), { target: { value: '=$A1>10' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    expect(getColorScales(get())[0]).toMatchObject({ kind: 'formula', formula: '=$A1>10' })
  })

  it('a colour-scale rule swaps the single-colour pickers for the gradient pickers', () => {
    const { get } = mount()
    fireEvent.click(screen.getByRole('button', { name: /Add rule/i }))
    fireEvent.change(screen.getByLabelText(/Format cells if/i), { target: { value: 'colorScale3' } })
    expect(screen.queryByLabelText(/^Fill$/i)).not.toBeInTheDocument()
    expect(screen.getByLabelText(/Min color/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Mid color/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Max color/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    expect(getColorScales(get())[0].kind).toBe('colorScale3')
  })
})

describe('ConditionalFormatPanel — error states', () => {
  it('refuses to save a rule with no operand, and writes nothing', () => {
    const { get, onColorScaleChange } = mount()
    fireEvent.click(screen.getByRole('button', { name: /Add rule/i }))
    fireEvent.change(screen.getByLabelText(/Format cells if/i), { target: { value: 'greaterThan' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    expect(screen.getByRole('alert')).toHaveTextContent(/number/i)
    expect(onColorScaleChange).not.toHaveBeenCalled()
    expect(getColorScales(get())).toHaveLength(0)
  })

  it('refuses an unusable range', () => {
    const { onColorScaleChange } = mount()
    fireEvent.click(screen.getByRole('button', { name: /Add rule/i }))
    fireEvent.change(screen.getByLabelText(/Apply to range/i), { target: { value: 'not-a-range' } })
    fireEvent.change(screen.getByLabelText(/^Value$/i), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    expect(screen.getByRole('alert')).toHaveTextContent(/range/i)
    expect(onColorScaleChange).not.toHaveBeenCalled()
  })

  it('refuses a date rule with a free-form date', () => {
    const { onColorScaleChange } = mount()
    fireEvent.click(screen.getByRole('button', { name: /Add rule/i }))
    fireEvent.change(screen.getByLabelText(/Format cells if/i), { target: { value: 'dateBefore' } })
    fireEvent.change(screen.getByLabelText(/^Value$/i), { target: { value: 'tomorrow' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    expect(screen.getByRole('alert')).toHaveTextContent(/date/i)
    expect(onColorScaleChange).not.toHaveBeenCalled()
  })
})

describe('ConditionalFormatPanel — round-trip + delete', () => {
  it('re-opens a saved rule with its fields prefilled and updates it in place', () => {
    const { get, rerender } = mount()
    // create
    fireEvent.click(screen.getByRole('button', { name: /Add rule/i }))
    fireEvent.change(screen.getByLabelText(/Apply to range/i), { target: { value: 'A1:A3' } })
    fireEvent.change(screen.getByLabelText(/Format cells if/i), { target: { value: 'lessThan' } })
    fireEvent.change(screen.getByLabelText(/^Value$/i), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    rerender()

    // listed with a human summary + its range
    expect(screen.getByText('Less than 10')).toBeInTheDocument()
    expect(screen.getByText('A1:A3')).toBeInTheDocument()
    const id = getColorScales(get())[0].id

    // re-open → fields prefilled → edit → saved in place (same id, no duplicate)
    fireEvent.click(screen.getByRole('button', { name: /Edit rule: Less than 10/i }))
    expect(screen.getByLabelText(/Apply to range/i)).toHaveValue('A1:A3')
    expect(screen.getByLabelText(/Format cells if/i)).toHaveValue('lessThan')
    expect(screen.getByLabelText(/^Value$/i)).toHaveValue('10')
    fireEvent.change(screen.getByLabelText(/^Value$/i), { target: { value: '7' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))

    const rules = getColorScales(get())
    expect(rules).toHaveLength(1)
    expect(rules[0].id).toBe(id)
    expect(rules[0].value1).toBe('7')
  })

  it('deletes a rule', () => {
    const { get, rerender } = mount(workbook([
      { id: 'cs_1', kind: 'isNotEmpty', range: 'A1:A3', fill: '#fce8e6', textColor: '', value1: '', value2: '', formula: '', min: '#f8696b', mid: '#ffeb84', max: '#63be7b', barColor: '#638ec6' },
    ]))
    expect(screen.getByText('Cell is not empty')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Delete rule: Cell is not empty/i }))
    rerender()
    expect(getColorScales(get())).toHaveLength(0)
  })

  it('lists a legacy native rule from an older file and can remove it', () => {
    let data = workbook()
    // A simplified legacy record -- the panel only reads conditionName/format.cellColor
    // to list it, not the full native shape.
    data[0].luckysheet_conditionformat_save = cast<NativeConditionFormat[]>([
      { conditionName: 'greaterThan', conditionValue: [5], format: { cellColor: '#ff0000' } },
    ])
    const onChange = vi.fn((next: CSSheet[]) => { data = next })
    render(<ConditionalFormatPanel data={data} onClose={() => {}} onChange={onChange} />)
    expect(screen.getByText(/Imported rules/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Delete imported rule/i }))
    expect(onChange).toHaveBeenCalled()
    expect(data[0].luckysheet_conditionformat_save).toHaveLength(0)
  })
})
