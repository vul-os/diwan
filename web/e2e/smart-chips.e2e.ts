/**
 * Smart chips E2E — the @-menu inserts an inline chip into a real document,
 * driven end-to-end in chromium against the production bundle.
 *
 * Also a boot guard: any uncaught page error while exercising the editor fails
 * the test (this repo has twice shipped a green build that booted to a blank
 * screen — passing unit tests do NOT prove the app runs).
 */

import { test, expect } from './fixtures.js'

test.describe('Docs smart chips E2E', () => {
  test('typing @ opens the chip menu and inserting a place chip adds an inline chip', async ({ officePage: page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(e.message))

    await page.goto('/docs/doc1')
    const editor = page.locator('.ProseMirror')
    await expect(editor).toBeVisible({ timeout: 15_000 })

    await editor.click()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.type(' @Paris')

    // The @-menu appears with at least a place option.
    const menu = page.getByTestId('smart-chip-menu')
    await expect(menu).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId('smart-chip-option-place')).toBeVisible()

    // Choose the place chip; an inline smart chip appears in the document.
    await page.getByTestId('smart-chip-option-place').first().click()
    await expect(editor.locator('[data-smart-chip]')).toHaveCount(1)
    await expect(editor.locator('.smart-chip-place')).toContainText('Paris')

    // The raw @query text is gone (replaced by the chip).
    const text = await editor.innerText()
    expect(text).not.toContain('@Paris')

    expect(pageErrors, `uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([])
  })

  test('a date chip can be inserted from the @-menu', async ({ officePage: page }) => {
    await page.goto('/docs/doc1')
    const editor = page.locator('.ProseMirror')
    await expect(editor).toBeVisible({ timeout: 15_000 })
    await editor.click()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.type(' @today')

    await expect(page.getByTestId('smart-chip-menu')).toBeVisible({ timeout: 5_000 })
    await page.getByTestId('smart-chip-option-date').first().click()
    await expect(editor.locator('.smart-chip-date')).toHaveCount(1)
  })
})
