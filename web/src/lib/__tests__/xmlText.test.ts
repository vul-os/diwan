import { describe, it, expect } from 'vitest'
import { stripXmlInvalidChars, escapeXmlText } from '../xmlText.js'

// deep/office2: XML-1.0-illegal C0 control chars (VT/FF/NUL/…) flowed unfiltered
// into the docx/odt/pptx exporters, producing content.xml the app REFUSES to
// reopen. This pins the shared strip that the three exporters now funnel through.
const VT = String.fromCharCode(0x0B)
const FF = String.fromCharCode(0x0C)
const NUL = String.fromCharCode(0x00)
const US = String.fromCharCode(0x1F)   // unit separator
const BS = String.fromCharCode(0x08)

describe('stripXmlInvalidChars (export XML corruption guard)', () => {
  it('removes C0 control chars illegal in XML 1.0', () => {
    const dirty = 'A' + VT + 'B' + FF + 'C' + US + 'D' + NUL + 'E' + BS + 'F'
    expect(stripXmlInvalidChars(dirty)).toBe('ABCDEF')
  })
  it('KEEPS tab, newline, and carriage return (the legal C0 chars)', () => {
    expect(stripXmlInvalidChars('a\tb\nc\rd')).toBe('a\tb\nc\rd')
  })
  it('preserves astral emoji, CJK, and RTL text', () => {
    const good = 'hi 😀 中文 العربية'
    expect(stripXmlInvalidChars(good)).toBe(good)
  })
  it('strips the #xFFFE / #xFFFF non-characters', () => {
    expect(stripXmlInvalidChars('x' + String.fromCharCode(0xFFFE) + String.fromCharCode(0xFFFF) + 'y')).toBe('xy')
  })
})

describe('escapeXmlText (strip THEN escape)', () => {
  it('strips control chars and escapes the five XML metacharacters', () => {
    const dirty = 'a<b>&' + VT + '"c' + "'" + 'd'
    expect(escapeXmlText(dirty)).toBe('a&lt;b&gt;&amp;&quot;c&apos;d')
  })
  it('does not leave any XML-1.0-illegal char in the output', () => {
    const dirty = 'x' + VT + FF + NUL + 'y'
    const out = escapeXmlText(dirty)
    // No char in [0x00-0x1F] except tab/newline/CR remains.
    for (const ch of out) {
      const c = ch.charCodeAt(0)
      if (c < 0x20) expect([0x09, 0x0A, 0x0D]).toContain(c)
    }
  })
})
