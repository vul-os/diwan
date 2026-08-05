import { useState, useRef, useCallback, useLayoutEffect } from 'react'
import type { ChangeEvent, KeyboardEvent, ReactNode, RefObject, TextareaHTMLAttributes } from 'react'

export interface MentionCollaborator {
  account_id: string
  display_name?: string
  name?: string
  [key: string]: unknown
}

// MentionInput — a plain <textarea> augmented with @-mention autocomplete over
// a supplied list of collaborators. It is a controlled component: the parent
// owns the raw text value; on submit the parent asks getMentions(value) for the
// set of mentioned account ids that appear in the text.
//
// SECURITY: the value is ALWAYS plain text. This component never renders HTML;
// mention chips in the *composer* are drawn from the parsed token, and the
// stored/displayed body is escaped by React text nodes on render (see
// renderMentions). So a crafted "@<script>" is inert — it is just characters.

// A mention token is @ followed by name chars. We match a trailing partial at
// the caret to drive the autocomplete popup.
const TRAILING_MENTION = /(^|\s)@([\w.-]*)$/

// buildMentionRegex escapes a display label so it can be matched literally in
// the body when resolving which account ids were actually typed.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * getMentions — resolve which collaborator account ids are @-mentioned in text.
 * Matches "@<label>" against each collaborator's display label (longest first
 * so "@Anna Lee" wins over "@Anna"). Returns a de-duplicated array of ids.
 */
export function getMentions(text: string, collaborators?: MentionCollaborator[] | null): string[] {
  if (!text || !collaborators?.length) return []
  const sorted = [...collaborators].sort((a, b) => labelOf(b).length - labelOf(a).length)
  const found = new Set<string>()
  for (const c of sorted) {
    const label = labelOf(c)
    if (!label) continue
    const re = new RegExp(`(^|\\s)@${escapeRegExp(label)}(?=\\s|$|[^\\w.\\-])`, 'g')
    if (re.test(text)) found.add(c.account_id)
  }
  return [...found]
}

function labelOf(c: MentionCollaborator): string {
  return c.display_name || c.name || c.account_id || ''
}

/**
 * renderMentions — display a body with @-mentions highlighted as chips. Returns
 * an array of React nodes. All text is emitted as plain React text nodes (never
 * dangerouslySetInnerHTML), so nothing in the body can inject markup or script.
 */
export function renderMentions(body: string, collaborators?: MentionCollaborator[] | null): ReactNode {
  if (!body) return body
  const labels = (collaborators || [])
    .map(labelOf)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
  if (labels.length === 0) return body

  const pattern = new RegExp(`@(${labels.map(escapeRegExp).join('|')})(?=\\s|$|[^\\w.\\-])`, 'g')
  const out: ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  let key = 0
  while ((m = pattern.exec(body)) !== null) {
    if (m.index > last) out.push(body.slice(last, m.index))
    out.push(
      <span key={`m${key++}`} className="text-accent font-medium bg-accent-tint rounded-xs px-0.5">
        {m[0]}
      </span>
    )
    last = m.index + m[0].length
  }
  if (last < body.length) out.push(body.slice(last))
  return out
}

interface MentionMenuState {
  query: string
  index: number
}

interface MentionInputProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange' | 'value'> {
  value: string
  onChange: (value: string) => void
  collaborators?: MentionCollaborator[]
  onEnter?: () => void
  className?: string
  wrapperClassName?: string
  rows?: number
  placeholder?: string
  textareaRef?: RefObject<HTMLTextAreaElement>
}

export default function MentionInput({
  value,
  onChange,
  collaborators = [],
  onEnter,
  className = '',
  wrapperClassName = '',
  rows = 2,
  placeholder = 'Add a comment…',
  textareaRef: externalRef,
  ...rest
}: MentionInputProps) {
  const innerRef = useRef<HTMLTextAreaElement>(null)
  const ref = externalRef || innerRef
  const [menu, setMenu] = useState<MentionMenuState | null>(null)

  const suggestions = menu
    ? collaborators.filter((c) => labelOf(c).toLowerCase().includes(menu.query.toLowerCase())).slice(0, 6)
    : []

  const updateMenu = useCallback((text: string, caret: number) => {
    const upto = text.slice(0, caret)
    const match = TRAILING_MENTION.exec(upto)
    if (match) setMenu({ query: match[2], index: 0 })
    else setMenu(null)
  }, [])

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value)
    updateMenu(e.target.value, e.target.selectionStart)
  }

  const insert = (c: MentionCollaborator) => {
    const el = ref.current
    if (!el) return
    const caret = el.selectionStart
    const before = value.slice(0, caret)
    const after = value.slice(caret)
    const match = TRAILING_MENTION.exec(before)
    if (!match) { setMenu(null); return }
    // Replace the trailing "@partial" with "@Label ".
    const prefix = before.slice(0, before.length - match[0].length) + (match[1] || '')
    const inserted = `@${labelOf(c)} `
    const next = prefix + inserted + after
    onChange(next)
    setMenu(null)
    // Restore caret just after the inserted mention.
    const pos = (prefix + inserted).length
    requestAnimationFrame(() => {
      if (ref.current) {
        ref.current.focus()
        ref.current.setSelectionRange(pos, pos)
      }
    })
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menu && suggestions.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMenu((m) => (m ? { ...m, index: (m.index + 1) % suggestions.length } : m)); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMenu((m) => (m ? { ...m, index: (m.index - 1 + suggestions.length) % suggestions.length } : m)); return }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insert(suggestions[menu.index]); return }
      if (e.key === 'Escape') { e.preventDefault(); setMenu(null); return }
    }
    if (e.key === 'Enter' && !e.shiftKey && onEnter) { e.preventDefault(); onEnter() }
  }

  // Keep the highlighted index in range if the suggestion list shrinks.
  useLayoutEffect(() => {
    if (menu && menu.index >= suggestions.length) setMenu((m) => (m ? { ...m, index: 0 } : m))
  }, [suggestions.length]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={`relative ${wrapperClassName}`}>
      <textarea
        ref={ref}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        rows={rows}
        placeholder={placeholder}
        className={className}
        {...rest}
      />
      {menu && suggestions.length > 0 && (
        <ul
          className="absolute z-30 left-2 right-2 bottom-full mb-1 bg-paper border border-line rounded-lg shadow-e2 py-1 text-xs overflow-hidden max-h-44 overflow-y-auto"
          role="listbox"
        >
          {suggestions.map((c, i) => (
            <li key={c.account_id}>
              <button
                type="button"
                role="option"
                aria-selected={i === menu.index}
                onMouseDown={(e) => { e.preventDefault(); insert(c) }}
                className={[
                  'w-full flex items-center gap-2 px-2.5 py-1.5 text-left transition-colors',
                  i === menu.index ? 'bg-accent-tint text-ink' : 'text-ink-muted hover:bg-accent-tint',
                ].join(' ')}
              >
                <span className="w-5 h-5 rounded-full bg-accent-tint text-accent flex items-center justify-center text-[10px] font-semibold flex-shrink-0">
                  {labelOf(c).slice(0, 1).toUpperCase()}
                </span>
                <span className="truncate">{labelOf(c)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
