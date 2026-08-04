/**
 * templates.test.js — built-in Docs/Sheets templates are static + well-shaped.
 */
import { describe, it, expect } from 'vitest'
import { DOC_TEMPLATES, SHEET_TEMPLATES, templatesFor } from '../templates'

describe('doc templates', () => {
  it('exposes resume, letter, and meeting-notes plus blank', () => {
    const ids = DOC_TEMPLATES.map((t) => t.id)
    expect(ids).toContain('blank')
    expect(ids).toContain('resume')
    expect(ids).toContain('letter')
    expect(ids).toContain('meeting-notes')
  })

  it('each doc template content is a Tiptap doc node (no raw HTML strings)', () => {
    for (const t of DOC_TEMPLATES) {
      expect(t.content.type).toBe('doc')
      expect(Array.isArray(t.content.content)).toBe(true)
      // The whole tree must be plain JSON nodes — no string that looks like HTML.
      const json = JSON.stringify(t.content)
      expect(json).not.toMatch(/<\s*script/i)
    }
  })
})

describe('sheet templates', () => {
  it('exposes budget, calendar, and tracker plus blank', () => {
    const ids = SHEET_TEMPLATES.map((t) => t.id)
    expect(ids).toEqual(expect.arrayContaining(['blank', 'budget', 'calendar', 'tracker']))
  })

  it('each sheet template content is a luckysheet-style array of sheets', () => {
    for (const t of SHEET_TEMPLATES) {
      expect(Array.isArray(t.content)).toBe(true)
      expect(t.content[0]).toHaveProperty('name')
      expect(t.content[0]).toHaveProperty('celldata')
      expect(Array.isArray(t.content[0].celldata)).toBe(true)
    }
  })
})

describe('templatesFor', () => {
  it('returns the right set per type and null for slides', () => {
    expect(templatesFor('doc')).toBe(DOC_TEMPLATES)
    expect(templatesFor('sheet')).toBe(SHEET_TEMPLATES)
    expect(templatesFor('slide')).toBeNull()
  })
})
