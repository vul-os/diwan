/**
 * e2e/whiteboard.e2e.js — the whiteboard document type end-to-end.
 *
 * jsdom cannot run Excalidraw's canvas engine (the integration layer stubs it),
 * so this is the layer that mounts the REAL Excalidraw canvas in a real browser
 * and proves the whiteboard opens, renders and carries its title — plus that
 * Office stays documents+whiteboards only (no Talk/Meet/Mail launcher, removed in
 * acc7261).
 */

import { test, expect } from './fixtures.js'

test.describe('Whiteboard', () => {
  test('opens a whiteboard and renders the real Excalidraw canvas', async ({ officePage: page }) => {
    page._mockState.files.wb1 = {
      id: 'wb1', name: 'System Diagram', type: 'whiteboard',
      content: { elements: [], files: {} },
    }

    await page.goto('/whiteboards/wb1')

    await expect(page.getByTestId('whiteboard-editor')).toBeVisible()
    // The real Excalidraw editor mounts its own container.
    await expect(page.locator('.excalidraw').first()).toBeVisible({ timeout: 20_000 })
    await expect(page.getByLabel('Whiteboard title')).toHaveValue('System Diagram')
    // The whiteboard credits the MIT Excalidraw editor it is built on.
    await expect(page.getByText(/Excalidraw · MIT/i)).toBeVisible()
  })

  test('the New menu offers Whiteboard, and creating one opens the canvas', async ({ officePage: page }) => {
    await page.goto('/whiteboards')

    // Open the create modal (AppHome "New" affordance).
    await page.getByRole('button', { name: /^New /i }).first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    // Pick the Whiteboard type, name it, create — scoped to the modal so we can't
    // hit a whiteboard-labelled affordance on the page behind it.
    await dialog.getByRole('button', { name: /Whiteboard/i }).click()
    await dialog.getByLabel(/Name/i).fill('My Board')
    await dialog.getByRole('button', { name: /^Create$/i }).click()

    await expect(page).toHaveURL(/\/whiteboards\/file_/)
    await expect(page.locator('.excalidraw').first()).toBeVisible({ timeout: 20_000 })
  })

  test('Office is documents + whiteboards only — no Talk/Meet/Mail launcher', async ({ officePage: page }) => {
    await page.goto('/whiteboards')
    // The nav rail shows Docs/Sheets/Slides/Whiteboards/PDF — never a comms app.
    await expect(page.getByRole('link', { name: /Whiteboards/i }).first()).toBeVisible()
    await expect(page.getByRole('link', { name: /^Talk$/i })).toHaveCount(0)
    await expect(page.getByRole('link', { name: /^Meet$/i })).toHaveCount(0)
    await expect(page.getByRole('link', { name: /^Mail$/i })).toHaveCount(0)
  })
})
