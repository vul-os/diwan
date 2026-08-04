/**
 * Unit tests for the shared date/size formatters. These back six panels
 * (AppHome, Home, CommentsPanel, SuggestionPanel, ActivityFeed, HistoryPanel)
 * that previously each carried a copy-pasted formatter, so a regression here
 * would ripple across the app — hence a direct, deterministic test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { timeAgo, timeAgoLong, formatTs, formatBytes } from '../format.js'

const NOW = new Date('2026-03-15T12:00:00Z').getTime()

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => vi.useRealTimers())

const ago = (ms: number) => new Date(NOW - ms)
const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN, DAY = 24 * HOUR

describe('timeAgo', () => {
  it('reads coarse buckets: just now / m / h / d', () => {
    expect(timeAgo(ago(10 * SEC))).toBe('just now')
    expect(timeAgo(ago(5 * MIN))).toBe('5m ago')
    expect(timeAgo(ago(3 * HOUR))).toBe('3h ago')
    expect(timeAgo(ago(2 * DAY))).toBe('2d ago')
  })

  it('falls back to a short calendar date past a week', () => {
    const out = timeAgo(ago(10 * DAY))
    expect(out).not.toMatch(/ago/)
    expect(out).toMatch(/Mar/) // "Mar 5"
  })

  it('accepts a Date, an ISO string, and epoch ms interchangeably', () => {
    expect(timeAgo(ago(5 * MIN))).toBe('5m ago')            // Date
    expect(timeAgo(ago(5 * MIN).toISOString())).toBe('5m ago') // string
    expect(timeAgo(NOW - 5 * MIN)).toBe('5m ago')          // number
  })

  it('returns empty string for null / invalid input', () => {
    expect(timeAgo(null)).toBe('')
    expect(timeAgo('')).toBe('')
    expect(timeAgo('not-a-date')).toBe('')
  })
})

describe('timeAgoLong', () => {
  it('keeps counting days up to 30 before a full date', () => {
    expect(timeAgoLong(ago(10 * DAY))).toBe('10d ago')
    expect(timeAgoLong(ago(29 * DAY))).toBe('29d ago')
    expect(timeAgoLong(ago(40 * DAY))).not.toMatch(/ago/)
  })

  it('shares the sub-day buckets with timeAgo', () => {
    expect(timeAgoLong(ago(30 * SEC))).toBe('just now')
    expect(timeAgoLong(ago(90 * MIN))).toBe('1h ago')
  })
})

describe('formatTs', () => {
  it('emits an absolute short date + time', () => {
    const out = formatTs('2026-03-04T09:30:00Z')
    expect(out).toMatch(/Mar 4/)
    // Time portion present (locale-formatted HH:MM).
    expect(out).toMatch(/\d{1,2}:\d{2}/)
  })
  it('is empty for falsy input', () => {
    expect(formatTs('')).toBe('')
    expect(formatTs(null)).toBe('')
  })
})

describe('formatBytes', () => {
  it('formats B / KB / MB with sensible precision', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(820)).toBe('820 B')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(1024 * 1024 * 3.4)).toBe('3.4 MB')
  })
  it('coerces non-numeric input to 0 B rather than NaN', () => {
    expect(formatBytes(undefined)).toBe('0 B')
    expect(formatBytes(null)).toBe('0 B')
  })
})
