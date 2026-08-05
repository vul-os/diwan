/**
 * Slides formatting E2E (WAVE-59, wave-48 toolbar) — real-browser flows for the
 * slide text-formatting controls added in wave-48: font-family, highlight, and
 * numbered (ordered) list. Hermetic harness (vite preview + mocked backend); the
 * slide's TipTap/ProseMirror editor runs LOCALLY in the page, so we assert the
 * real marks/nodes it emits into the slide body.
 *
 * How the slide editor is driven here (feat/slides-canvas): the deck is
 * deep-linked; its legacy flow content migrates into positioned text objects on
 * the object canvas. Double-clicking a text object opens an inline ProseMirror
 * editor (`.tiptap .ProseMirror`) — the same TipTap surface, now per-object.
 * We select the slide text (Ctrl+A) and click the wave-48 toolbar controls:
 *   • Font family — a Menu; picking "Georgia" applies textStyle{fontFamily} →
 *     an inline `font-family` style on a <span> in the slide body.
 *   • Highlight   — a color <input>; setting a value toggles a <mark> highlight.
 *   • Numbered    — the "Numbered list" button turns the block into an <ol>.
 */

import { type Locator } from '@playwright/test'
import { test, expect, type OfficePage } from './fixtures.js'

const DECK = {
  id: 'deck1', name: 'Pitch', type: 'slide',
  content: {
    themeId: 'obsidian', theme: 'black', transition: 'slide',
    slides: [{ id: 's1', title: 'Intro', content: '<p>Highlight me please</p>', notes: '' }],
    masters: null, customTheme: null,
  },
}

async function openDeck(page: OfficePage): Promise<void> {
  await page.route(/\/api\/files\/deck1$/, (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(DECK) })
  })
  await page.route('**/api/files', (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify([DECK]) })
  })
  await page.goto('/slides/deck1')
  await expect(page.getByLabel('Presentation title')).toHaveValue('Pitch', { timeout: 20_000 })
  // The canvas renders the migrated text objects.
  await expect(page.locator('.vslide-object').first()).toBeVisible({ timeout: 15_000 })
}

// Open a text object for editing, replace its text with a known selection, so a
// mark/list op has a real selection to act on.
async function typeAndSelectAll(page: OfficePage): Promise<Locator> {
  // Double-click the body text object (the last text object on the slide) to
  // open its inline editor.
  const objects = page.locator('.vslide-object')
  // Click to select the body text object, then click again to enter edit mode
  // (Google-Slides style). This opens the inline ProseMirror editor.
  await objects.last().click()
  await objects.last().click()
  const editor = page.locator('[data-object-text-editor] .ProseMirror').first()
  await expect(editor).toBeVisible({ timeout: 10_000 })
  // Focus the contenteditable directly (the overlay stops pointer propagation,
  // so a synthetic click may not seat the selection); then select-all + type.
  await editor.focus()
  await editor.evaluate((el) => {
    el.focus()
    const range = document.createRange()
    range.selectNodeContents(el)
    const sel = window.getSelection()
    if (!sel) throw new Error('window.getSelection() returned null')
    sel.removeAllRanges(); sel.addRange(range)
  })
  await page.keyboard.type('Highlight me please')
  await expect(editor).toContainText('Highlight me please')
  await page.keyboard.press('ControlOrMeta+A')
  return editor
}

test.describe('Slides text formatting (wave-48) — E2E', () => {
  test('font family — applying Georgia renders an inline font-family style', async ({ officePage: page }) => {
    await openDeck(page)
    const editor = await typeAndSelectAll(page)

    // Open the font-family menu (labelled "Font family: …") and pick Georgia.
    await page.getByRole('button', { name: /Font family:/i }).click()
    await page.getByRole('menuitem', { name: 'Georgia' }).click()

    // A <span> in the slide body now carries the Georgia font-family stack.
    await expect(editor.locator('span[style*="font-family"]').first())
      .toHaveAttribute('style', /Georgia/i)
  })

  test('highlight — setting a highlight colour wraps the selection in <mark>', async ({ officePage: page }) => {
    await openDeck(page)
    const editor = await typeAndSelectAll(page)

    // The highlight control is a hidden color <input> inside the "Highlight
    // color" label. It's React-controlled, so we set the value through React's
    // native value setter before dispatching input/change — otherwise React's
    // value tracker swallows the synthetic event and onChange never fires.
    const hi = page.getByLabel('Choose highlight color')
    await hi.evaluate((el) => {
      const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
      // This IS the unbound native property setter, extracted on purpose so it
      // can be invoked with an explicit receiver (`.call(el, ...)` below)
      // instead of React's tracked <input>.value setter — the whole point.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const setter = descriptor?.set
      if (!setter) throw new Error('HTMLInputElement.prototype has no value setter')
      setter.call(el, '#ffe066')
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    })

    // The Highlight extension renders a <mark> around the highlighted text.
    await expect(editor.locator('mark')).toHaveCount(1)
    await expect(editor.locator('mark')).toContainText('Highlight me')
  })

  test('numbered list — the toolbar button turns the block into an <ol>', async ({ officePage: page }) => {
    await openDeck(page)
    const editor = await typeAndSelectAll(page)

    await page.getByRole('button', { name: 'Numbered list' }).click()

    // The paragraph became an ordered list item.
    await expect(editor.locator('ol')).toHaveCount(1)
    await expect(editor.locator('ol li')).toContainText('Highlight me please')
  })
})
