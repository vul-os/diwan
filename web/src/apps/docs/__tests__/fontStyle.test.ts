/**
 * Tests for the font-size / font-family textStyle attribute extensions.
 * These guard the fix for the bug where the toolbar's font selectors set a
 * `textStyle` attribute that the base extension silently dropped on render.
 */

import { describe, it, expect } from 'vitest'
import {
  normalizeFontSize,
  sanitizeFontFamily,
  fontSizeAttribute,
  fontFamilyAttribute,
} from '../../../lib/tiptap/fontStyle.js'

// parseHTML only reads `.style.<prop>` off its argument — a minimal stub
// covers it without constructing a real DOM element, cast through a local
// type the way narrow interface mocks are done elsewhere in the suite.
type StyleElementStub = { style: { fontSize?: string; fontFamily?: string } }
const asElement = (e: StyleElementStub): HTMLElement => e as unknown as HTMLElement

describe('normalizeFontSize', () => {
  it('appends pt to a bare number', () => {
    expect(normalizeFontSize('18')).toBe('18pt')
    expect(normalizeFontSize(24)).toBe('24pt')
  })
  it('accepts explicit CSS units', () => {
    expect(normalizeFontSize('18pt')).toBe('18pt')
    expect(normalizeFontSize('16px')).toBe('16px')
    expect(normalizeFontSize('1.5em')).toBe('1.5em')
    expect(normalizeFontSize('120%')).toBe('120%')
  })
  it('rejects empty / non-positive / out-of-range values', () => {
    expect(normalizeFontSize('')).toBeNull()
    expect(normalizeFontSize(null)).toBeNull()
    expect(normalizeFontSize(0)).toBeNull()
    expect(normalizeFontSize(-4)).toBeNull()
    expect(normalizeFontSize(9999)).toBeNull()
  })
  it('strips CSS-injection attempts down to the leading numeric size', () => {
    // parseFloat keeps only the leading number, discarding the injected CSS.
    expect(normalizeFontSize('18pt; color:red')).toBe('18pt')
    expect(normalizeFontSize('garbage')).toBeNull()
  })
})

describe('sanitizeFontFamily', () => {
  it('passes through a normal font stack', () => {
    expect(sanitizeFontFamily('Georgia, serif')).toBe('Georgia, serif')
    expect(sanitizeFontFamily('"Times New Roman", serif')).toBe('"Times New Roman", serif')
  })
  it('rejects style-breaking characters', () => {
    expect(sanitizeFontFamily('Arial; background:url(x)')).toBeNull()
    expect(sanitizeFontFamily('<script>')).toBeNull()
  })
  it('rejects empty', () => {
    expect(sanitizeFontFamily('')).toBeNull()
    expect(sanitizeFontFamily(null)).toBeNull()
  })
})

describe('fontSizeAttribute.renderHTML', () => {
  it('emits an inline font-size style when set', () => {
    expect(fontSizeAttribute.renderHTML({ fontSize: '28pt' })).toEqual({ style: 'font-size: 28pt' })
  })
  it('emits nothing when unset', () => {
    expect(fontSizeAttribute.renderHTML({ fontSize: null })).toEqual({})
  })
  it('parses a font-size back off an element', () => {
    expect(fontSizeAttribute.parseHTML(asElement({ style: { fontSize: '14px' } }))).toBe('14px')
    expect(fontSizeAttribute.parseHTML(asElement({ style: { fontSize: '' } }))).toBeNull()
  })
})

describe('fontFamilyAttribute.renderHTML', () => {
  it('emits an inline font-family style when set', () => {
    expect(fontFamilyAttribute.renderHTML({ fontFamily: 'Verdana, sans-serif' }))
      .toEqual({ style: 'font-family: Verdana, sans-serif' })
  })
  it('emits nothing when unset', () => {
    expect(fontFamilyAttribute.renderHTML({ fontFamily: null })).toEqual({})
  })
  it('strips quotes when parsing off an element', () => {
    expect(fontFamilyAttribute.parseHTML(asElement({ style: { fontFamily: '"Georgia"' } }))).toBe('Georgia')
  })
})
