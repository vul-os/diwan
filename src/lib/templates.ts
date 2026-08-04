// Built-in, STATIC document templates for Docs and Sheets (parity with the
// Slides deck gallery). These seed a brand-new file's content.
//
// SECURITY: all content here is authored in-repo (no user/network input) and is
// a plain data structure, not HTML. Docs content is a ProseMirror/Tiptap JSON
// doc (nodes + marks), which the editor renders through its schema — there is
// no HTML injection surface. Sheets content is a luckysheet-style celldata
// array of primitive cell values. Both are re-validated by the editors' own
// import guards on load, exactly like the blank shapes in filesStore.

// ── helpers to keep the Tiptap JSON terse ──────────────────────────────────
export type TiptapMark = { type: string; attrs?: Record<string, unknown> }
export type TiptapNode = {
  type: string
  attrs?: Record<string, unknown>
  content?: TiptapNode[]
  text?: string
  marks?: TiptapMark[]
}

const text = (s: string, marks?: TiptapMark[]): TiptapNode =>
  (marks ? { type: 'text', text: s, marks } : { type: 'text', text: s })
const bold = (s: string): TiptapNode => text(s, [{ type: 'bold' }])
const heading = (level: number, ...content: TiptapNode[]): TiptapNode => ({ type: 'heading', attrs: { level }, content })
const para = (...content: TiptapNode[]): TiptapNode => (content.length ? { type: 'paragraph', content } : { type: 'paragraph' })
const bullet = (...items: string[]): TiptapNode => ({
  type: 'bulletList',
  content: items.map((s) => ({ type: 'listItem', content: [{ type: 'paragraph', content: [text(s)] }] })),
})

export type DocTemplate = { id: string; label: string; desc: string; content: TiptapNode }
export type SheetTemplate = { id: string; label: string; desc: string; content: SheetTab[] }

// ── Docs templates (Tiptap JSON) ───────────────────────────────────────────
export const DOC_TEMPLATES: DocTemplate[] = [
  {
    id: 'blank',
    label: 'Blank',
    desc: 'An empty document',
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
  },
  {
    id: 'resume',
    label: 'Résumé',
    desc: 'Name, experience, education, skills',
    content: {
      type: 'doc',
      content: [
        heading(1, text('Your Name')),
        para(text('City, Country · you@email.com · (000) 000-0000')),
        heading(2, text('Summary')),
        para(text('A concise two-line summary of who you are and the value you bring.')),
        heading(2, text('Experience')),
        para(bold('Job Title'), text(' — Company · 20XX–Present')),
        bullet('Key achievement with a measurable result.', 'Another responsibility or accomplishment.'),
        heading(2, text('Education')),
        para(bold('Degree'), text(' — Institution · 20XX')),
        heading(2, text('Skills')),
        para(text('Skill one · Skill two · Skill three · Skill four')),
      ],
    },
  },
  {
    id: 'letter',
    label: 'Letter',
    desc: 'Formal block-style letter',
    content: {
      type: 'doc',
      content: [
        para(text('Your Name')),
        para(text('Your Address')),
        para(text('Date')),
        para(),
        para(text('Recipient Name')),
        para(text('Recipient Address')),
        para(),
        para(text('Dear [Recipient],')),
        para(text('Opening paragraph stating the purpose of your letter.')),
        para(text('Body paragraph with supporting details and context.')),
        para(text('Closing paragraph with a clear call to action or next step.')),
        para(),
        para(text('Sincerely,')),
        para(text('Your Name')),
      ],
    },
  },
  {
    id: 'meeting-notes',
    label: 'Meeting notes',
    desc: 'Agenda, notes, action items',
    content: {
      type: 'doc',
      content: [
        heading(1, text('Meeting Notes')),
        para(bold('Date: '), text('__________   '), bold('Attendees: '), text('__________')),
        heading(2, text('Agenda')),
        bullet('Topic one', 'Topic two', 'Topic three'),
        heading(2, text('Discussion')),
        para(text('Capture key points and decisions here.')),
        heading(2, text('Action Items')),
        bullet('Owner — task — due date', 'Owner — task — due date'),
      ],
    },
  },
]

// ── Sheets templates (luckysheet-style: [{ name, celldata, config }]) ───────
// celldata entries are { r, c, v: { v: value, m: display, bl?: 1 } }.
export type SheetCellValue = string | number
export type SheetCell = { r: number; c: number; v: { v: SheetCellValue; m: string; bl?: 1 } }
export type SheetTab = { name: string; celldata: SheetCell[]; config: Record<string, unknown> }

const cell = (r: number, c: number, v: SheetCellValue, boldCell: boolean): SheetCell =>
  ({ r, c, v: { v, m: String(v), ...(boldCell ? { bl: 1 } : {}) } })

function sheet(name: string, rows: SheetCellValue[][]): SheetTab[] {
  const celldata: SheetCell[] = []
  rows.forEach((row, r) => {
    row.forEach((val, c) => {
      if (val === null || val === undefined || val === '') return
      celldata.push(cell(r, c, val, r === 0))
    })
  })
  return [{ name, celldata, config: {} }]
}

export const SHEET_TEMPLATES: SheetTemplate[] = [
  {
    id: 'blank',
    label: 'Blank',
    desc: 'An empty spreadsheet',
    content: [{ name: 'Sheet1', celldata: [], config: {} }],
  },
  {
    id: 'budget',
    label: 'Monthly budget',
    desc: 'Income, expenses, and balance',
    content: sheet('Budget', [
      ['Category', 'Planned', 'Actual', 'Difference'],
      ['Income', 3000, 3000, 0],
      ['Rent', 1200, 1200, 0],
      ['Groceries', 400, 0, 0],
      ['Transport', 150, 0, 0],
      ['Utilities', 200, 0, 0],
      ['Savings', 500, 0, 0],
      ['Total', '', '', ''],
    ]),
  },
  {
    id: 'calendar',
    label: 'Weekly calendar',
    desc: 'A 7-day planner grid',
    content: sheet('Week', [
      ['Time', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
      ['09:00', '', '', '', '', '', '', ''],
      ['10:00', '', '', '', '', '', '', ''],
      ['11:00', '', '', '', '', '', '', ''],
      ['12:00', '', '', '', '', '', '', ''],
      ['13:00', '', '', '', '', '', '', ''],
      ['14:00', '', '', '', '', '', '', ''],
      ['15:00', '', '', '', '', '', '', ''],
      ['16:00', '', '', '', '', '', '', ''],
    ]),
  },
  {
    id: 'tracker',
    label: 'Task tracker',
    desc: 'Status, owner, and due date',
    content: sheet('Tasks', [
      ['Task', 'Owner', 'Status', 'Priority', 'Due'],
      ['Example task', 'Name', 'To do', 'High', ''],
      ['', '', '', '', ''],
      ['', '', '', '', ''],
      ['', '', '', '', ''],
    ]),
  },
]

export function templatesFor(type: string): DocTemplate[] | SheetTemplate[] | null {
  if (type === 'doc') return DOC_TEMPLATES
  if (type === 'sheet') return SHEET_TEMPLATES
  return null
}
