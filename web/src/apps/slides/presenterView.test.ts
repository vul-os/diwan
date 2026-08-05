/**
 * presenterView.test.js — SECURITY regression (sec/office-deep).
 *
 * The presenter window is built as a full HTML document string and opened as a
 * blob: URL (SAME ORIGIN as the app). Slide fields are embedded into an inline
 * `<script>` block as `var SLIDES = <json>`. `title`, `notes` and `background`
 * are UNTRUSTED (a hostile CRDT peer or a malicious .pptx import can set them),
 * and JSON.stringify does NOT escape `</script>` — so a value like
 * `</script><img src=x onerror=…>` would terminate the <script> element during
 * HTML parsing and run attacker code in the app origin.
 *
 * Fix: scriptSafeJson escapes `<` `>` `&` (and U+2028/U+2029) to \uXXXX, so no
 * field can break out of the script context regardless of per-field sanitising.
 */
import { describe, it, expect } from 'vitest'
import { buildPresenterHTML } from './PresenterView.jsx'

const PAYLOAD = '</script><img src=x onerror=alert(document.domain)>'

describe('buildPresenterHTML — script-context injection', () => {
  it('does not let a hostile notes field break out of the <script> block', () => {
    const html = buildPresenterHTML(
      [{ id: 's1', title: 'T', content: '<p>ok</p>', notes: PAYLOAD, background: '' }],
      0, 'black',
    )
    // The literal breakout sequence must never appear (it would close <script>).
    expect(html).not.toContain('</script><img')
    // The `<` of the payload is emitted as its < escape inside the JSON.
    expect(html).toContain('\\u003c/script\\u003e\\u003cimg')
  })

  it('escapes hostile title AND background fields too', () => {
    const html = buildPresenterHTML(
      [{ id: 's1', title: PAYLOAD, content: '', notes: '', background: PAYLOAD }],
      0, 'black',
    )
    expect(html).not.toContain('</script><img')
    // Every raw `</script>` in the file belongs to a real (legit) script tag —
    // count them against the opening tags so no stray one snuck in via a field.
    const closes = (html.match(/<\/script>/gi) || []).length
    const opens = (html.match(/<script\b/gi) || []).length
    expect(closes).toBe(opens)
  })

  it('still embeds well-formed, parseable slide data for benign input', () => {
    const html = buildPresenterHTML(
      [{ id: 's1', title: 'Hello', content: '<p>Hi</p>', notes: 'note', background: '#000' }],
      0, 'black',
    )
    expect(html).toContain('var SLIDES = [')
    // Extract the embedded JSON and confirm it round-trips through the browser's
    // JSON parser (the \uXXXX escapes decode back to the original characters).
    const m = html.match(/var SLIDES = (\[.*?\]);/s)
    expect(m).toBeTruthy()
    const slides = JSON.parse(m![1]) as { title: string; notes: string }[]
    expect(slides[0].title).toBe('Hello')
    expect(slides[0].notes).toBe('note')
  })
})
