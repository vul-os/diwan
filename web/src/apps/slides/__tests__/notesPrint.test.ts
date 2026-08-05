/**
 * notesPrint.test.js — SECURITY regression for the "Print speaker notes" HTML.
 *
 * Slide titles + notes are untrusted plain text (a note can come straight from
 * an imported .pptx) written into a new same-origin window. A crafted <script>
 * in a note/title MUST be escaped, never rendered as a live element.
 */

import { describe, it, expect } from 'vitest'
import { buildNotesPrintHtml, escapeNotesHtml } from '../notesPrint'
import { sanitizeSlideHtml } from '../../../lib/sanitize.js'

describe('buildNotesPrintHtml — injection boundary', () => {
  it('escapes a hostile note and title (no live <script>)', () => {
    const deck = {
      slides: [
        {
          title: '<script>window.__pwned=1</script>',
          content: '<p>ok</p>',
          notes: '<img src=x onerror=alert(1)>',
        },
      ],
    }
    const html = buildNotesPrintHtml(deck, '<script>alert(2)</script>', sanitizeSlideHtml)

    // Parse the produced document and assert no live script/img element and no
    // element carrying an onerror handler survived from the untrusted fields.
    const dom = new DOMParser().parseFromString(html, 'text/html')
    expect(dom.querySelector('body script')).toBeNull()
    expect(dom.querySelector('img')).toBeNull()
    expect(dom.querySelector('[onerror]')).toBeNull()

    // The payloads survive only as ESCAPED text (visible, inert).
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&lt;img')
    expect(html).not.toMatch(/<script>window\.__pwned/)
  })

  it('escapes the & < > " \' characters', () => {
    expect(escapeNotesHtml(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;')
  })

  it('sanitises slide.content while keeping benign markup', () => {
    const deck = { slides: [{ title: 'T', content: '<p>hi<script>bad()</script></p>', notes: '' }] }
    const html = buildNotesPrintHtml(deck, 'Deck', sanitizeSlideHtml)
    const dom = new DOMParser().parseFromString(html, 'text/html')
    expect(dom.querySelector('script')).toBeNull()
    expect(dom.body.textContent).toContain('hi')
  })
})
