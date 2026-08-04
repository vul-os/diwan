import { describe, it, expect } from 'vitest'

// NOTE (pre-existing, not touched by this conversion): this is a standalone
// reimplementation of the literal/regex-match scanning logic, operating on a
// plain string. The real `findAllMatches` exported from
// `../components/FindReplace.tsx` takes a ProseMirror `doc: PMNode` and walks
// its text nodes instead — a different signature entirely, so there is
// nothing in the source to import types from here. Flagging for whoever
// revisits this file; out of scope for a type-only conversion.

interface TextMatch {
  index: number
  length: number
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function findAllMatches(textContent: string, term: string, caseSensitive: boolean, useRegex: boolean): TextMatch[] {
  if (!term) return []
  const flags = caseSensitive ? 'g' : 'gi'
  let re: RegExp
  try {
    re = new RegExp(useRegex ? term : escapeRegex(term), flags)
  } catch { return [] }
  const matches: TextMatch[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(textContent)) !== null) {
    matches.push({ index: m.index, length: m[0].length })
    if (re.lastIndex === m.index) re.lastIndex++
  }
  return matches
}

describe('findAllMatches', () => {
  it('finds simple matches case-insensitive', () => {
    const matches = findAllMatches('Hello HELLO hello', 'hello', false, false)
    expect(matches).toHaveLength(3)
  })

  it('respects case-sensitive mode', () => {
    const matches = findAllMatches('Hello HELLO hello', 'hello', true, false)
    expect(matches).toHaveLength(1)
    expect(matches[0].index).toBe(12)
  })

  it('returns empty for no match', () => {
    expect(findAllMatches('abc', 'xyz', false, false)).toHaveLength(0)
  })

  it('returns empty for empty term', () => {
    expect(findAllMatches('abc', '', false, false)).toHaveLength(0)
  })

  it('escapes regex special chars in literal mode', () => {
    const matches = findAllMatches('price: $1.00', '$1.00', false, false)
    expect(matches).toHaveLength(1)
  })

  it('uses regex in regex mode', () => {
    const matches = findAllMatches('foo123bar456', '\\d+', false, true)
    expect(matches).toHaveLength(2)
    expect(matches[0].length).toBe(3) // '123'
    expect(matches[1].length).toBe(3) // '456'
  })

  it('returns empty for invalid regex', () => {
    const matches = findAllMatches('abc', '[invalid', false, true)
    expect(matches).toHaveLength(0)
  })

  it('correctly reports match positions', () => {
    const matches = findAllMatches('abcabcabc', 'abc', true, false)
    expect(matches).toHaveLength(3)
    expect(matches[0].index).toBe(0)
    expect(matches[1].index).toBe(3)
    expect(matches[2].index).toBe(6)
  })

  it('handles overlapping-style zero-width guard correctly', () => {
    // Empty string literal mode should return 0 (guarded at top)
    expect(findAllMatches('hello', '', false, false)).toHaveLength(0)
  })

  it('regex mode respects case-insensitive flag', () => {
    const matches = findAllMatches('FooFOOfoo', 'foo', false, true)
    expect(matches).toHaveLength(3)
  })

  it('regex mode respects case-sensitive flag', () => {
    const matches = findAllMatches('FooFOOfoo', 'foo', true, true)
    expect(matches).toHaveLength(1)
    expect(matches[0].index).toBe(6)
  })

  it('literal mode does not treat dot as wildcard', () => {
    const matches = findAllMatches('a.b axb', 'a.b', false, false)
    expect(matches).toHaveLength(1)
    expect(matches[0].index).toBe(0)
  })
})
