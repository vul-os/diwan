/**
 * Docs structured-content E2E (WAVE-59) — real-browser flows for the two Docs
 * features added since the wave-28 baseline: tables (wave-52) and inline images
 * (wave-57). Driven through the same hermetic harness as docs.e2e.js: a
 * production `vite preview` build with the backend/collab mocked in-browser
 * (fixtures.js). The TipTap/ProseMirror editor runs LOCALLY in the page, so
 * these assert the real editor DOM, not a stub.
 *
 * How the structured editors are driven here:
 *   • Tables — the toolbar's N×M grid picker (`Insert R by C table` buttons) is
 *     clicked to insert; once the caret is inside a table the contextual
 *     "Table options" menu exposes row/column/header-row/delete items. We assert
 *     against the emitted <table>/<tr>/<td>/<th> in `.ProseMirror`.
 *   • Images — inserted via the "Insert image from URL" popover using a tiny
 *     raster `data:` URI (the embed path the wave-57 policy allows). The wave-57
 *     image sub-toolbar (width presets / align / alt) is then exercised; the
 *     resulting <img> is asserted in the editor DOM.
 *   • Security — a document whose persisted `_html` carries an <img onerror> and
 *     a `data:image/svg+xml` src is opened (the wave-53 import → sanitizeDocHtml
 *     path). We assert nothing executed (no window.__pwned) and the hostile
 *     vectors are inert in the live DOM.
 */

import { test, expect } from './fixtures.js'
import { installBackend } from './fixtures.js'

// The hostile-import test below sets this from injected markup IF the sanitiser
// fails closed; the assertion is that it never fires.
declare global {
  interface Window {
    __pwned?: number
  }
}

// A 1×1 transparent PNG — an allow-listed raster image (wave-57 embed path).
// Base64 body (no data: prefix) so we can both build a File to feed the picker
// and reason about the resulting data: URI.
const PNG_1x1_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

// Build a Playwright setInputFiles payload for a raster PNG the wave-57 embed
// policy accepts (isEmbeddableImage: image/png, non-empty, under the size cap).
const PNG_FILE = {
  name: 'pixel.png',
  mimeType: 'image/png',
  buffer: Buffer.from(PNG_1x1_B64, 'base64'),
}

test.describe('Docs tables (wave-52) — E2E', () => {
  test.beforeEach(async ({ officePage: page }) => {
    await page.goto('/docs/doc1')
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 15_000 })
  })

  test('insert a 2×3 table from the grid picker → renders a <table> with header row', async ({ officePage: page }) => {
    const editor = page.locator('.ProseMirror')
    await editor.click()
    // Open the N×M grid picker and choose a 2-row × 3-col table.
    await page.getByRole('button', { name: 'Insert table' }).click()
    await page.getByRole('button', { name: 'Insert 2 by 3 table' }).click()

    // The table renders with a header row (withHeaderRow: true) → 3 <th> + one
    // body row of 3 <td>, inside a single <table>.
    const table = editor.locator('table')
    await expect(table).toHaveCount(1)
    await expect(table.locator('tr')).toHaveCount(2)
    await expect(table.locator('th')).toHaveCount(3)
    await expect(table.locator('td')).toHaveCount(3)
    // wave-52 a11y: header cells carry scope="col".
    await expect(table.locator('th').first()).toHaveAttribute('scope', 'col')
  })

  test('type into a cell, add a row + column, then toggle the header row off', async ({ officePage: page }) => {
    const editor = page.locator('.ProseMirror')
    await editor.click()
    await page.getByRole('button', { name: 'Insert table' }).click()
    await page.getByRole('button', { name: 'Insert 2 by 2 table' }).click()

    const table = editor.locator('table')
    await expect(table).toHaveCount(1)

    // Type into the first (header) cell — the caret is already inside the table
    // after insert. Assert the text lands in the table.
    await table.locator('th').first().click()
    await page.keyboard.type('Region')
    await expect(table).toContainText('Region')

    // Baseline: a 2×2 with header = 2 rows, 2 cols. Open the contextual menu.
    await expect(table.locator('tr')).toHaveCount(2)
    const openTableMenu = async () => {
      await page.getByRole('button', { name: 'Table options' }).click()
    }

    // Add a row below → 3 rows.
    await openTableMenu()
    await page.getByRole('menuitem', { name: 'Insert row below' }).click()
    await expect(table.locator('tr')).toHaveCount(3)

    // Add a column to the right → each row now has an extra cell. The header row
    // grows from 2 <th> to 3 <th>.
    await openTableMenu()
    await page.getByRole('menuitem', { name: 'Insert column right' }).click()
    await expect(table.locator('th')).toHaveCount(3)

    // Toggle the header row OFF → the header cells become body cells. There
    // should now be no <th> (header row demoted to a normal row).
    await openTableMenu()
    await page.getByRole('menuitem', { name: 'Toggle header row' }).click()
    await expect(table.locator('th')).toHaveCount(0)
  })

  test('delete row + delete the whole table', async ({ officePage: page }) => {
    const editor = page.locator('.ProseMirror')
    await editor.click()
    await page.getByRole('button', { name: 'Insert table' }).click()
    await page.getByRole('button', { name: 'Insert 3 by 2 table' }).click()

    const table = editor.locator('table')
    await expect(table.locator('tr')).toHaveCount(3)

    // Delete the current row → 2 rows remain.
    await page.getByRole('button', { name: 'Table options' }).click()
    await page.getByRole('menuitem', { name: 'Delete row' }).click()
    await expect(table.locator('tr')).toHaveCount(2)

    // Delete the whole table → no <table> left in the doc.
    await page.getByRole('button', { name: 'Table options' }).click()
    await page.getByRole('menuitem', { name: 'Delete table' }).click()
    await expect(editor.locator('table')).toHaveCount(0)
  })
})

test.describe('Docs images (wave-57) — E2E', () => {
  test.beforeEach(async ({ officePage: page }) => {
    await page.goto('/docs/doc1')
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 15_000 })
  })

  test('insert a raster image via the upload picker → renders <img> from the returned url', async ({ officePage: page }) => {
    const editor = page.locator('.ProseMirror')
    await editor.click()

    // The "Insert image (upload)" button click()s a hidden <input type=file>.
    // Feed it the raster PNG; the mock /upload returns { url: '/uploaded.png' }
    // so the image embeds as <img src="/uploaded.png"> (a safe relative URL).
    await page.locator('input[type=file]').setInputFiles(PNG_FILE)

    const img = editor.locator('img')
    await expect(img).toHaveCount(1)
    await expect(img).toHaveAttribute('src', '/uploaded.png')
  })

  test('data: URI embed fallback — when upload fails, the raster embeds as a base64 data: image', async ({ officePage: page }) => {
    // Force the server-upload path to fail so insertImageFile falls back to
    // fileToDataUri — the wave-57 raster-only base64 embed path.
    await page.route('**/api/upload', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"nope"}' }))

    const editor = page.locator('.ProseMirror')
    await editor.click()
    await page.locator('input[type=file]').setInputFiles(PNG_FILE)

    const img = editor.locator('img')
    await expect(img).toHaveCount(1)
    // The fallback produced a raster data: URI (never svg/xml/html).
    await expect(img).toHaveAttribute('src', /^data:image\/png;base64,/)
  })

  test('resize / align / alt via the wave-57 image sub-toolbar', async ({ officePage: page }) => {
    const editor = page.locator('.ProseMirror')
    await editor.click()
    await page.locator('input[type=file]').setInputFiles(PNG_FILE)
    const img = editor.locator('img')
    await expect(img).toHaveCount(1)

    // Clicking the image selects the node (NodeSelection) → the wave-57 image
    // context row (width presets / align / alt) appears. Node selection via a
    // single click can be raced by ProseMirror's selection handling under
    // parallel load, so retry the click until the sub-toolbar (its unique
    // "Set width 50%" control) is present. The presets carry unique titles, so we
    // scope the align buttons to the row that contains them.
    const w50 = page.getByTitle('Set width 50%')
    await expect(async () => {
      await img.click({ force: true })
      await expect(w50).toBeVisible({ timeout: 1_000 })
    }).toPass({ timeout: 10_000 })
    const imageRow = w50.locator('xpath=ancestor::div[1]')

    // Alt text (a11y) round-trips onto the <img>. Do this first, while the node
    // selection is freshest — each keystroke re-focuses the editor via
    // updateAttributes, so filling in one shot keeps the sub-toolbar mounted.
    await page.getByLabel('Image alt text').fill('A tiny test pixel')
    await expect(img).toHaveAttribute('alt', 'A tiny test pixel')

    // Re-select the image (the alt-field focus dance may have collapsed the
    // NodeSelection) before driving the width/align presets.
    await expect(async () => {
      await img.click({ force: true })
      await expect(w50).toBeVisible({ timeout: 1_000 })
    }).toPass({ timeout: 10_000 })

    // Width preset 50% → the <img> carries width:50% in its inline style.
    await w50.click()
    await expect(img).toHaveAttribute('style', /width:\s*50%/)

    // Align center (image sub-toolbar) → display:block + auto margins.
    await imageRow.getByTitle('Align center').click()
    await expect(img).toHaveAttribute('style', /margin-left:\s*auto/)
  })
})

test.describe('Docs image security at the browser level (wave-53 + wave-57)', () => {
  // A document whose PERSISTED html carries the two live image hazards:
  //   • <img onerror=…> that would set window.__pwned if it executed
  //   • an <img src="data:image/svg+xml…"> whose SVG carries an onload script
  // This html is served as the doc's `content._html`, so opening the doc runs it
  // through resolveContent → sanitizeDocHtml (the wave-53 import boundary) and
  // then the DocImage node's fail-closed renderHTML (wave-57/58).
  const HOSTILE_HTML =
    '<p>Report</p>' +
    '<img src="x" onerror="window.__pwned=(window.__pwned||0)+1">' +
    '<img src="data:image/svg+xml;base64,' +
    // <svg onload="window.__pwned=…"><script>…</script></svg>
    'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIG9ubG9hZD0id2luZG93Ll9fcHduZWQ9KHdpbmRvdy5fX3B3bmVkfHwwKSsxIj48c2NyaXB0PndpbmRvdy5fX3B3bmVkPSh3aW5kb3cuX19wd25lZHx8MCkrMTwvc2NyaXB0Pjwvc3ZnPg==' +
    '">' +
    '<p>End</p>'

  test('a hostile persisted image import renders inert — no window.__pwned, no svg/onerror in the live DOM', async ({ page }) => {
    const state = await installBackend(page, { role: 'owner' })
    // Seed a NEW doc whose content is the hostile _html (served by GET
    // /api/files/hostile). The editor imports it via sanitizeDocHtml.
    state.files.hostile = {
      id: 'hostile', name: 'Hostile Import', type: 'doc',
      content: { _html: HOSTILE_HTML },
    }

    // Fail loudly if any injected handler ever fires.
    await page.exposeFunction('__pwnReport', () => {})

    await page.goto('/docs/hostile')
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 15_000 })
    // The benign text survived the sanitiser.
    await expect(page.locator('.ProseMirror')).toContainText('Report')

    // Give any deferred onerror/onload a chance to fire, then assert nothing did.
    await page.waitForTimeout(500)
    const pwned = await page.evaluate(() => window.__pwned)
    expect(pwned).toBeFalsy()

    // No on*-handler attribute survived onto any live <img>, and no svg data:
    // URI src is present in the editor DOM (the sanitiser + node fail-close
    // dropped them). A raster src or no src is fine; an svg/exec src is not.
    const imgProbe = await page.locator('.ProseMirror').evaluate((root) => {
      const imgs = Array.from(root.querySelectorAll('img'))
      return {
        anyOnError: imgs.some((i) => i.hasAttribute('onerror') || i.getAttribute('onerror')),
        anySvgSrc: imgs.some((i) => /data:image\/svg\+xml|data:text\/html/i.test(i.getAttribute('src') || '')),
        hasScriptTag: !!root.querySelector('script'),
      }
    })
    expect(imgProbe.anyOnError).toBe(false)
    expect(imgProbe.anySvgSrc).toBe(false)
    expect(imgProbe.hasScriptTag).toBe(false)
  })
})
