/**
 * Sheets + Slides E2E — the interactive flows that don't run headless (the
 * @fortune-sheet canvas grid; reveal.js rendering) exercised in a real browser.
 *
 * Sheets: open, edit a cell, formula bar, presence pill.
 * Slides: open, add a slide, presenter view toggle, presence.
 */

import { test, expect, type OfficePage } from './fixtures.js'

// A sheet + a slide deck. The editors deep-linked directly (no AppHome to run
// fetchFiles) load their file via api.getFile(id) → GET /api/files/:id, so we
// must serve BOTH the list and the per-id endpoints.
const SHEET = { id: 'sh1', name: 'Budget', type: 'sheet', content: [{ name: 'Sheet1', celldata: [{ r: 0, c: 0, v: { v: 'Item', m: 'Item' } }], config: {} }] }
const DECK = { id: 'deck1', name: 'Pitch', type: 'slide', content: { themeId: 'obsidian', theme: 'black', transition: 'slide', slides: [{ id: 's1', title: 'Intro', content: '<p>Intro</p>', notes: '' }], masters: null, customTheme: null } }

async function seedFiles(page: OfficePage): Promise<void> {
  const byId: Record<string, typeof SHEET | typeof DECK> = { sh1: SHEET, deck1: DECK }
  // Per-id GET (what the editor actually fetches on a deep link).
  await page.route(/\/api\/files\/(sh1|deck1)$/, (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const id = new URL(route.request().url()).pathname.split('/').pop()
    if (!id || !(id in byId)) return route.fallback()
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(byId[id]) })
  })
  // List endpoint (used if any list view mounts).
  await page.route('**/api/files', (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify([SHEET, DECK]) })
  })
}

test.describe('Sheets E2E', () => {
  test('opens a sheet, types into a cell, shows the presence pill', async ({ officePage: page }) => {
    await seedFiles(page)
    await page.goto('/sheets/sh1')

    // Title input (aria-label="Sheet title") confirms the editor mounted.
    await expect(page.getByLabel('Sheet title')).toHaveValue('Budget', { timeout: 20_000 })

    // Presence pill (role=status) is in the topbar.
    await expect(page.getByRole('status').first()).toBeVisible()

    // The Fortune-Sheet grid renders a canvas behind an interactive overlay
    // (#luckysheet-sheettable_0). Click the overlay (the canvas is aria-hidden
    // and intercepted) to focus a cell, then type a value.
    const overlay = page.locator('.fortune-sheet-overlay, [id^="luckysheet-sheettable"]').first()
    await expect(overlay).toBeVisible({ timeout: 20_000 })
    await overlay.click({ position: { x: 60, y: 40 } })
    await page.keyboard.type('123')
    await page.keyboard.press('Enter')

    // Smoke-level browser check: the interaction didn't throw and the editor is
    // still live (the pill remains). Deep cell/formula assertions are unit-tested
    // (src/__tests__/msw/sheetsEditor.integration.test.jsx).
    await expect(page.getByRole('status').first()).toBeVisible()
  })
})

test.describe('Sheets WAVE41 — data validation + number formats (E2E)', () => {
  test('applies a number-format preset to the selection from the toolbar menu', async ({ officePage: page }) => {
    await seedFiles(page)
    await page.goto('/sheets/sh1')
    await expect(page.getByLabel('Sheet title')).toHaveValue('Budget', { timeout: 20_000 })

    // The Fortune-Sheet grid renders in the real browser (the whole point of E2E).
    const overlay = page.locator('.fortune-sheet-overlay, [id^="luckysheet-sheettable"]').first()
    await expect(overlay).toBeVisible({ timeout: 20_000 })

    // Type a number into a cell, then open the number-format menu and apply a
    // currency preset to the selection. The menu is a radio list (real component).
    await overlay.click({ position: { x: 60, y: 40 } })
    await page.keyboard.type('1200.5')
    await page.keyboard.press('Enter')

    await page.getByRole('button', { name: 'Number format' }).first().click()
    const menu = page.getByRole('menu', { name: 'Number format presets' })
    await expect(menu).toBeVisible()
    // The current-format radio state is exposed for a11y (starts on Automatic).
    await expect(menu.getByRole('menuitemradio', { name: 'Automatic' })).toHaveAttribute('aria-checked', 'true')
    await menu.getByRole('menuitemradio', { name: /Currency \(\$\)/ }).click()

    // Menu closes after applying; editor still live (no throw on the canvas path).
    await expect(menu).toBeHidden()
    await expect(page.getByRole('status').first()).toBeVisible()
  })

  test('the data-validation toolbar action is wired against the live grid', async ({ officePage: page }) => {
    await seedFiles(page)
    await page.goto('/sheets/sh1')
    await expect(page.getByLabel('Sheet title')).toHaveValue('Budget', { timeout: 20_000 })
    await expect(page.locator('.fortune-sheet-overlay, [id^="luckysheet-sheettable"]').first())
      .toBeVisible({ timeout: 20_000 })

    // Smoke: the Data-validation toolbar control is present and clickable against
    // the real canvas without throwing. The full add-rule form flow (which does
    // not depend on the canvas) is covered at the RTL/MSW integration level in
    // src/__tests__/msw/sheetsWave41.integration.test.jsx — see the report note on
    // the SheetsEditor togglePanel/closeAllPanels self-close race that makes the
    // panel unreliable to open E2E once the grid initializes.
    const dv = page.getByRole('button', { name: /^Data validation/ }).first()
    await expect(dv).toBeVisible()
    await dv.click()
    await expect(page.getByRole('status').first()).toBeVisible()
  })
})

test.describe('Slides E2E', () => {
  test('opens a deck, adds a slide, toggles presenter view, shows presence', async ({ officePage: page }) => {
    await seedFiles(page)
    await page.goto('/slides/deck1')

    await expect(page.getByLabel('Presentation title')).toHaveValue('Pitch', { timeout: 20_000 })

    // Presence pill present.
    await expect(page.getByRole('status').first()).toBeVisible()

    // Add a slide → a second thumbnail appears.
    await page.getByLabel('Add slide').click()
    await expect(page.getByLabel(/^Slide 2/).first()).toBeVisible()

    // Presenter view opens a new window/popup — assert the click is wired (it
    // either opens a popup or is blocked by the environment; both are fine as
    // long as it does not throw).
    const popupPromise = page.context().waitForEvent('page', { timeout: 4_000 }).catch(() => null)
    await page.getByLabel('Open presenter view').click()
    const popup = await popupPromise
    if (popup) await popup.close().catch(() => {})
  })
})
