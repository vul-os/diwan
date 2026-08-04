/**
 * MentionInput.test.jsx — @-mention parse + escaped render.
 *
 * getMentions resolves typed "@Label" to the collaborator's account_id, and
 * ONLY for real collaborators. renderMentions returns plain React nodes (never
 * HTML), so a crafted body carries no markup/script.
 */
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { getMentions, renderMentions } from '../MentionInput'

const collabs = [
  { account_id: 'acct-alice', display_name: 'Alice' },
  { account_id: 'acct-bob', display_name: 'Bob' },
  { account_id: 'acct-annalee', display_name: 'Anna Lee' },
]

describe('getMentions', () => {
  it('resolves a single @-mention to its account id', () => {
    expect(getMentions('hey @Alice look', collabs)).toEqual(['acct-alice'])
  })

  it('resolves multiple distinct mentions', () => {
    const out = getMentions('@Alice and @Bob', collabs)
    expect(out.sort()).toEqual(['acct-alice', 'acct-bob'])
  })

  it('prefers the longest matching label (Anna Lee over Anna)', () => {
    expect(getMentions('ping @Anna Lee', collabs)).toEqual(['acct-annalee'])
  })

  it('does NOT resolve a name that is not a collaborator', () => {
    expect(getMentions('@Carol hi', collabs)).toEqual([])
  })

  it('de-duplicates repeated mentions of the same person', () => {
    expect(getMentions('@Alice @Alice', collabs)).toEqual(['acct-alice'])
  })

  it('returns empty for no collaborators or empty text', () => {
    expect(getMentions('@Alice', [])).toEqual([])
    expect(getMentions('', collabs)).toEqual([])
  })
})

describe('renderMentions (escaped, no injection)', () => {
  it('wraps a recognized mention in a chip and keeps the rest as text', () => {
    const { container } = render(<p>{renderMentions('hi @Alice!', collabs)}</p>)
    // The mention becomes a <span>, surrounding text stays plain.
    const chip = container.querySelector('span')
    expect(chip).not.toBeNull()
    expect(chip!.textContent).toBe('@Alice')
    expect(container.textContent).toBe('hi @Alice!')
  })

  it('never emits raw HTML — a script-like body renders as inert text', () => {
    const evil = 'hello <img src=x onerror=alert(1)> @Bob'
    const { container } = render(<p>{renderMentions(evil, collabs)}</p>)
    // No <img> node was created; the angle brackets are literal text.
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
  })

  it('leaves a body with no mentions untouched', () => {
    const { container } = render(<p>{renderMentions('plain text', collabs)}</p>)
    expect(container.querySelector('span')).toBeNull()
    expect(container.textContent).toBe('plain text')
  })
})
