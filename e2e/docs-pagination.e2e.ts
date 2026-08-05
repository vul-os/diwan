/**
 * Docs pagination / headers-footers / equations E2E (CAPSTONE) — real-browser
 * coverage of the Word/Google-Docs-parity features that only exist once the doc
 * is LAID OUT in a real browser (pagination measures rendered block heights; the
 * header/footer bands + KaTeX equations render into the live DOM).
 *
 * Hermetic harness (vite preview + mocked backend). The TipTap editor, the
 * pagination measure (measurePageBreaks against the laid-out article), the
 * header/footer bands, and KaTeX all run LOCALLY in the page.
 *
 * WHY these prove the feature WORKS:
 *   • pagination — a document taller than one page renders ≥1 `.doc-page-break`
 *     separator AND the status bar reports "N pages" with N ≥ 2.
 *   • headers    — applying a header via the real dialog paints the text into the
 *     rendered `.doc-hf-band`.
 *   • equation   — inserting LaTeX creates a `.math-inline[data-latex]` node that
 *     KaTeX renders to a `.katex` subtree (real typeset math, not raw source).
 */

import { test, expect, type OfficePage } from './fixtures.js'

// A long document — many paragraphs so the laid-out content exceeds one page and
// the pagination pass inserts page-break separators.
function longDocHtml(paras = 90): string {
  const p = '<p>The quick brown fox jumps over the lazy dog. '
    + 'Pack my box with five dozen liquor jugs. '
    + 'How vexingly quick daft zebras jump.</p>'
  return Array.from({ length: paras }, () => p).join('')
}

interface OpenDocOptions {
  html?: string
  headerFooter?: unknown
}

async function openDoc(page: OfficePage, { html, headerFooter }: OpenDocOptions = {}): Promise<void> {
  const doc = {
    id: 'doc1', name: 'Report', type: 'doc',
    content: { _html: html ?? '<p>Hello world</p>', ...(headerFooter ? { headerFooter } : {}) },
  }
  await page.route(/\/api\/files\/doc1$/, (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(doc) })
  })
  await page.goto('/docs/doc1')
  await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 15_000 })
}

test.describe('Docs pagination (CAPSTONE E2E)', () => {
  test('a multi-page document renders page-break separators and a page count > 1', async ({ officePage: page }) => {
    await openDoc(page, { html: longDocHtml(90) })

    // The measured page-break separators appear once the content is laid out.
    await expect.poll(async () => page.locator('.doc-page-break').count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(1)
    // Each separator is labelled with its page number ("page 2", "page 3", …).
    await expect(page.locator('.doc-page-break .doc-page-num').first()).toContainText(/page \d+/)

    // The status bar reflects the multi-page count.
    await expect(page.getByText(/\d+ pages/).first()).toBeVisible()
    const pagesText = await page.getByText(/\d+ pages/).first().innerText()
    expect(parseInt(pagesText, 10)).toBeGreaterThanOrEqual(2)
  })

  test('a short document stays a single page (no page breaks)', async ({ officePage: page }) => {
    await openDoc(page, { html: '<p>Just one line.</p>' })
    // Give the measure pass a moment; a one-liner must not paginate.
    await page.waitForTimeout(500)
    await expect(page.locator('.doc-page-break')).toHaveCount(0)
  })
})

test.describe('Docs headers & footers (CAPSTONE E2E)', () => {
  test('applying a header via the dialog paints it into the rendered band', async ({ officePage: page }) => {
    await openDoc(page)

    // Open the overflow menu → Headers & footers… dialog.
    await page.getByRole('button', { name: 'More formatting options' }).click()
    await page.getByRole('menuitem', { name: /Headers & footers/i }).click()

    const dialog = page.getByRole('dialog', { name: 'Headers & footers' })
    await expect(dialog).toBeVisible()
    // Type into the header centre cell and apply.
    await dialog.getByLabel('Header center').fill('CONFIDENTIAL DRAFT')
    await dialog.getByRole('button', { name: 'Apply' }).click()
    await expect(dialog).toBeHidden()

    // The rendered header band now shows the text on the page.
    await expect(page.locator('.doc-hf-band').first()).toContainText('CONFIDENTIAL DRAFT')
  })

  test('a persisted header/footer renders on open', async ({ officePage: page }) => {
    await openDoc(page, {
      headerFooter: { enabled: true, header: { center: 'Quarterly Report' }, footer: { right: 'Vulos' } },
    })
    await expect(page.locator('.doc-hf-band').filter({ hasText: 'Quarterly Report' })).toBeVisible()
  })
})

test.describe('Docs equations — KaTeX (CAPSTONE E2E)', () => {
  test('inserting LaTeX renders a typeset .katex equation in the document', async ({ officePage: page }) => {
    await openDoc(page)
    await page.locator('.ProseMirror').click()

    await page.getByTitle('Insert equation (KaTeX)').click()
    const dialog = page.getByRole('dialog', { name: 'Equation' })
    await expect(dialog).toBeVisible()

    // Live preview typesets as you type.
    await dialog.getByLabel('LaTeX source').fill('E = mc^2')
    await expect(dialog.getByLabel('Equation preview').locator('.katex')).toBeVisible()

    await dialog.getByRole('button', { name: 'Insert equation' }).click()
    await expect(dialog).toBeHidden()

    // The inline math node carries the source AND is KaTeX-rendered in the editor.
    const math = page.locator('.ProseMirror .math-inline[data-latex="E = mc^2"]')
    await expect(math).toHaveCount(1)
    await expect(math.locator('.katex')).toBeVisible()
  })

  test('an invalid/hostile LaTeX macro is rendered inertly, not executed', async ({ officePage: page }) => {
    await openDoc(page)
    await page.locator('.ProseMirror').click()

    let pwned = false
    await page.exposeFunction('__eqpwn', () => { pwned = true })

    await page.getByTitle('Insert equation (KaTeX)').click()
    const dialog = page.getByRole('dialog', { name: 'Equation' })
    // KaTeX runs with trust:false / strict — \href javascript: and \includegraphics
    // must not execute or inject an active sink.
    await dialog.getByLabel('LaTeX source').fill('\\href{javascript:window.__eqpwn()}{click}')
    await dialog.getByRole('button', { name: 'Insert equation' }).click()
    await expect(dialog).toBeHidden()

    await page.waitForTimeout(300)
    expect(pwned).toBe(false)
    // No javascript: href reached the live DOM.
    await expect(page.locator('.ProseMirror a[href^="javascript:"]')).toHaveCount(0)
  })
})
