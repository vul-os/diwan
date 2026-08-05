/**
 * Slides import-honesty E2E — a deck imported from a lossy .pptx surfaces an
 * itemised banner telling the user exactly what did NOT come in, and the export
 * menu restates it before a PowerPoint export overwrites the original.
 *
 * Also a boot guard (page.on('pageerror')).
 */

import { test, expect } from './fixtures.js'

test.describe('Slides import honesty E2E', () => {
  test('shows the import-loss banner and restates it in the export menu', async ({ officePage: page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(e.message))

    await page.goto('/slides/deck1')
    const banner = page.getByTestId('slide-import-loss-banner')
    await expect(banner).toBeVisible({ timeout: 15_000 })
    await expect(banner).toContainText('2 tables')
    await expect(banner).toContainText('1 chart')
    await expect(banner).toContainText(/exporting to PowerPoint will not restore/i)

    // The export menu restates the loss right where it matters.
    await page.getByRole('button', { name: /Export/i }).first().click()
    await expect(page.getByTestId('slide-export-loss-note')).toContainText(/will not contain 2 tables, 1 chart/i)
    await page.keyboard.press('Escape')

    // Dismiss the banner.
    await banner.getByRole('button', { name: /Dismiss import notice/i }).click()
    await expect(banner).toBeHidden()

    expect(pageErrors, `uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([])
  })
})
