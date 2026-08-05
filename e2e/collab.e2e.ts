/**
 * Collaboration E2E — version history (with wave-14 restore gate), comments,
 * and the serverless (peer-to-peer) collaboration contract, driven through the
 * real browser UI against a mocked backend.
 */

import { test, expect } from '@playwright/test'
import { installBackend } from './fixtures.js'

test.describe('Version history + wave-14 restore gate (E2E)', () => {
  test('owner can restore a version', async ({ page }) => {
    await installBackend(page, { role: 'owner' })
    await page.goto('/docs/doc1')
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 15_000 })

    await page.getByRole('button', { name: 'Version history' }).first().click()
    await expect(page.getByText('First draft')).toBeVisible()

    await page.getByTitle('Restore this version').first().click()
    // Confirm inside the dialog.
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: /^Restore$/ }).click()
    await expect(page.getByText('Version restored')).toBeVisible()
  })

  test('WAVE-14: a viewer is refused restore (403) and sees an error', async ({ page }) => {
    await installBackend(page, { role: 'viewer' })
    await page.goto('/docs/doc1')
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 15_000 })

    await page.getByRole('button', { name: 'Version history' }).first().click()
    await expect(page.getByText('First draft')).toBeVisible()

    await page.getByTitle('Restore this version').first().click()
    await page.getByRole('dialog').getByRole('button', { name: /^Restore$/ }).click()

    await expect(page.getByText(/forbidden/i)).toBeVisible()
    await expect(page.getByText('Version restored')).toHaveCount(0)
  })
})

test.describe('Comments (E2E)', () => {
  test('add a comment, then resolve it', async ({ page }) => {
    await installBackend(page, { role: 'owner' })
    await page.goto('/docs/doc1')
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 15_000 })

    await page.getByRole('button', { name: 'Comments' }).first().click()
    const box = page.getByPlaceholder('Add a comment…')
    await expect(box).toBeVisible()
    await box.fill('Please review this section')
    await page.getByRole('button', { name: /^Comment$/ }).click()

    await expect(page.getByText('Please review this section')).toBeVisible()

    // Resolve the comment (the Resolve action lives on the comment card).
    await page.getByRole('button', { name: /Resolve/i }).first().click()
    // The resolved comment shows a "Resolved" status pill. Scope to the badge
    // (exact text) so we don't collide with the "Resolved" filter TAB that also
    // appears once a resolved comment exists (strict-mode ambiguity otherwise).
    await expect(page.getByText('Resolved', { exact: true }).first()).toBeVisible()
  })
})

/**
 * Serverless (peer-to-peer) collaboration, in the real browser.
 *
 * Office collaboration is ALWAYS peer-to-peer: Yjs CRDT updates over an
 * E2E-encrypted WebRTC room, with a content-blind relay only as a NAT-traversal
 * fallback. There is NO central document server — the app must never issue a
 * /v1/documents/:id/collab/* request (op relay, doc-state hub, or server
 * presence). This smoke pins that contract against the bundle the user runs: any
 * such request is a hard regression back toward a server-mediated architecture.
 */
test.describe('Serverless (P2P) collab (E2E smoke)', () => {
  test('typing edits the document without any central-server collab request', async ({ page }) => {
    await installBackend(page, { role: 'owner' })

    // Fail LOUDLY if the app ever calls a server-mediated collab endpoint.
    const collabRequests: string[] = []
    await page.route('**/v1/documents/*/collab/**', (route) => {
      collabRequests.push(route.request().url())
      // Answer 404 so, if a regression reintroduces the call, the app degrades
      // rather than hanging — but the assertion below still fails the test.
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' })
    })

    await page.goto('/docs/doc1')
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 15_000 })

    await page.locator('.ProseMirror').click()
    await page.keyboard.type(' a locally-hydrated, peer-to-peer edit')

    // The edit lands in the (locally-hydrated) document…
    await expect(page.locator('.ProseMirror')).toContainText('peer-to-peer edit')

    // …and NOTHING was sent to a central collab server. The only server role in
    // collab is content-blind peer discovery (/api/peering/*), never document
    // content, ops, state, or presence.
    await page.waitForTimeout(500) // past any publish/presence debounce
    expect(collabRequests).toEqual([])
  })
})
