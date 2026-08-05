/**
 * Sheets charts E2E (WAVE-59, wave-54 feature) — real-browser coverage of the
 * chart-insertion UI. Hermetic harness (vite preview + mocked backend); the
 * @fortune-sheet grid and the ChartWizard dialog run LOCALLY in the page.
 *
 * SCOPE NOTE (WAVE-61 — the wave-59 gap is now CLOSED): the wave-54 *live chart
 * render* (ChartLayer/ChartSvg painting an <svg> over the grid) was previously
 * NOT observable in a single-user session — `<Workbook onChange={handleChange}>`
 * fired with FortuneSheet-normalised sheet objects that DROPPED the app's custom
 * `sheet.charts` field, so `setData` clobbered charts on grid init and on the
 * next edit (verified then: 0 `[data-chart-id]` cards; 0 `charts` in the save
 * PUT). WAVE-61 makes charts a first-class, locally-authoritative, persisted
 * part of the sheet model: handleChange now MERGES the app's charts back onto
 * the normalised payload. So a wizard-inserted chart renders locally and
 * SURVIVES a subsequent cell edit — asserted live below. The injected-glyph SVG
 * escaping remains covered headless in src/apps/sheets/chartSvg.test.jsx.
 *
 * How the chart editor is driven here: the toolbar "Insert chart" opens the real
 * ChartWizard; its type picker is a radiogroup and its "Data range" is a plain
 * text input, so the flow does not depend on the flaky canvas marquee.
 */

import { test, expect, type OfficePage } from './fixtures.js'

interface SheetCell {
  r: number
  c: number
  v: { v: string | number; m: string }
}

interface SheetFile {
  id: string
  name: string
  type: string
  content: [{ name: string; celldata: SheetCell[]; config: Record<string, never> }]
}

function makeSheetFile(): SheetFile {
  const celldata: SheetCell[] = [
    { r: 0, c: 0, v: { v: 'Qtr', m: 'Qtr' } },
    { r: 0, c: 1, v: { v: 'Sales', m: 'Sales' } },
    { r: 1, c: 0, v: { v: 'Q1', m: 'Q1' } },
    { r: 1, c: 1, v: { v: 10, m: '10' } },
    { r: 2, c: 0, v: { v: 'Q2', m: 'Q2' } },
    { r: 2, c: 1, v: { v: 40, m: '40' } },
  ]
  return { id: 'sh1', name: 'Budget', type: 'sheet', content: [{ name: 'Sheet1', celldata, config: {} }] }
}

async function openSheet(page: OfficePage): Promise<void> {
  const file = makeSheetFile()
  await page.route(/\/api\/files\/sh1$/, (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(file) })
  })
  await page.route('**/api/files', (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify([file]) })
  })
  await page.goto('/sheets/sh1')
  await expect(page.getByLabel('Sheet title')).toHaveValue('Budget', { timeout: 20_000 })
  await expect(page.locator('.fortune-sheet-overlay, [id^="luckysheet-sheettable"]').first())
    .toBeVisible({ timeout: 20_000 })
}

test.describe('Sheets chart wizard (wave-54) — real-browser insert flow', () => {
  test('opens the wizard from the toolbar with the type radiogroup + range input', async ({ officePage: page }) => {
    await openSheet(page)
    await page.getByRole('button', { name: 'Insert chart' }).click()

    const dialog = page.getByRole('dialog', { name: 'Insert chart' })
    await expect(dialog).toBeVisible()
    // All five wave-54 chart types are offered as a radiogroup.
    const radios = dialog.getByRole('radiogroup', { name: 'Chart type' })
    // exact: the wave-62 chart types added "Stacked column" / "% column" /
    // "Stacked bar" …, so a substring match on "Column" now resolves to three
    // radios (strict-mode violation). Match the exact label.
    for (const t of ['Column', 'Bar', 'Line', 'Area', 'Pie']) {
      await expect(radios.getByRole('radio', { name: t, exact: true })).toBeVisible()
    }
    // The range field exists (defaults may be empty on a deep-link with no marquee).
    await expect(dialog.locator('#chart-range')).toBeVisible()

    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
  })

  for (const kind of ['Column', 'Line', 'Pie']) {
    test(`selecting the ${kind} type + a range and submitting closes the wizard without error`, async ({ officePage: page }) => {
      await openSheet(page)

      // Guard: a chart-render or descriptor bug that throws would surface here.
      const pageErrors: string[] = []
      page.on('pageerror', (e) => pageErrors.push(e.message))

      await page.getByRole('button', { name: 'Insert chart' }).click()
      const dialog = page.getByRole('dialog', { name: 'Insert chart' })
      await expect(dialog).toBeVisible()

      // Pick the type (radiogroup → aria-checked flips) and type an A1 range.
      const radio = dialog.getByRole('radio', { name: kind, exact: true })
      await radio.click()
      await expect(radio).toHaveAttribute('aria-checked', 'true')
      await dialog.locator('#chart-range').fill('A1:B3')

      // Submit runs the real makeChart/insertChart pipeline in the browser.
      await dialog.getByRole('button', { name: 'Insert chart' }).click()
      await expect(dialog).toBeHidden()

      // The editor is still alive (topbar presence pill) and nothing threw.
      await expect(page.getByRole('status').first()).toBeVisible()
      expect(pageErrors, `no page errors during ${kind} chart insert`).toEqual([])
    })
  }

  // ── WAVE-61: the wave-59 data-loss regression, now a live guard ────────────
  test('an inserted chart renders AND survives a subsequent cell edit (wave-61)', async ({ officePage: page }) => {
    await openSheet(page)

    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(e.message))

    // Insert a chart over the seeded A1:B3 data range.
    await page.getByRole('button', { name: 'Insert chart' }).click()
    const dialog = page.getByRole('dialog', { name: 'Insert chart' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('radio', { name: 'Column', exact: true }).click()
    await dialog.locator('#chart-range').fill('A1:B3')
    await dialog.getByRole('button', { name: 'Insert chart' }).click()
    await expect(dialog).toBeHidden()

    // The floating chart card renders over the grid (this is the wave-59 gap:
    // pre-fix there were 0 [data-chart-id] cards).
    const card = page.locator('[data-chart-id]').first()
    await expect(card).toBeVisible({ timeout: 10_000 })
    // It draws a live SVG (the wave-54 render).
    await expect(card.locator('svg').first()).toBeVisible()

    // Now edit a cell — FortuneSheet fires onChange with a charts-stripped,
    // normalised payload. Pre-fix this clobbered the chart; the fix merges it
    // back. The card must STILL be there. Click a cell BELOW the floating chart
    // (default geometry ~40,40 → 520,340) so the pointer reaches the grid, not
    // the chart overlay.
    const overlay = page.locator('.fortune-sheet-overlay, [id^="luckysheet-sheettable"]').first()
    await overlay.click({ position: { x: 60, y: 380 } })
    await page.keyboard.type('123')
    await page.keyboard.press('Enter')

    await expect(page.locator('[data-chart-id]').first()).toBeVisible()
    expect(pageErrors, 'no page errors during chart insert + edit').toEqual([])
  })

  test('a hostile chart title is captured as plain data and never executes on submit', async ({ officePage: page }) => {
    await openSheet(page)

    let pwned = false
    await page.exposeFunction('__pwn', () => { pwned = true })

    await page.getByRole('button', { name: 'Insert chart' }).click()
    const dialog = page.getByRole('dialog', { name: 'Insert chart' })
    await dialog.getByRole('radio', { name: 'Column', exact: true }).click()
    await dialog.locator('#chart-range').fill('A1:B3')
    // Type a script-y title into the wizard's plain text input.
    await dialog.locator('#chart-title').fill('<img src=x onerror=window.__pwn()>')
    await dialog.getByRole('button', { name: 'Insert chart' }).click()
    await expect(dialog).toBeHidden()

    // The title was a form string → stored as plain data. No markup was parsed,
    // no handler fired, and the editor is still live.
    await page.waitForTimeout(300)
    expect(pwned).toBe(false)
    expect(await page.evaluate(() => window.__pwned)).toBeFalsy()
    await expect(page.getByRole('status').first()).toBeVisible()
  })
})
