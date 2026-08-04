/**
 * DocThumb — a crafted, per-type document preview tile for the launcher.
 * ----------------------------------------------------------------------------
 * The old launcher cards used a flat tinted box with a big faded icon — the
 * "clone" tell. This renders a tiny, on-brand *mock* of what each document
 * type looks like (ruled lines for a doc, a grid for a sheet, a slide frame
 * for a deck, a page for a PDF), tinted with the app's hue. It reads as a real
 * thumbnail without needing a server-rendered preview, and degrades gracefully.
 *
 *   <DocThumb type="doc"   className="h-28" />
 *   <DocThumb type="sheet" className="h-28" />
 *
 * `type` ∈ 'doc' | 'sheet' | 'slide' | 'pdf'. Pure SVG, no assets, aria-hidden
 * (the card's title is the accessible name).
 */

export type DocThumbType = 'doc' | 'sheet' | 'slide' | 'pdf' | 'whiteboard'

interface GlyphProps {
  tint: string
}

const TINT: Record<DocThumbType, string> = {
  doc:   'var(--app-docs)',
  sheet: 'var(--app-sheets)',
  slide: 'var(--app-slides)',
  pdf:   'var(--app-pdf)',
  whiteboard: 'var(--app-board)',
}

function DocGlyph({ tint }: GlyphProps) {
  // Ruled "paper" with a heading bar — a document at a glance.
  return (
    <svg viewBox="0 0 96 72" className="w-full h-full" preserveAspectRatio="xMidYMid meet">
      <rect x="26" y="8" width="44" height="56" rx="3" fill="var(--bg-elevated)" stroke="var(--line-strong)" />
      <rect x="32" y="16" width="24" height="4" rx="2" fill={tint} opacity="0.85" />
      <rect x="32" y="26" width="32" height="2.4" rx="1.2" fill="var(--ink-ghost)" />
      <rect x="32" y="32" width="32" height="2.4" rx="1.2" fill="var(--ink-ghost)" />
      <rect x="32" y="38" width="26" height="2.4" rx="1.2" fill="var(--ink-ghost)" />
      <rect x="32" y="47" width="32" height="2.4" rx="1.2" fill="var(--ink-ghost)" opacity="0.7" />
      <rect x="32" y="53" width="20" height="2.4" rx="1.2" fill="var(--ink-ghost)" opacity="0.7" />
    </svg>
  )
}

function SheetGlyph({ tint }: GlyphProps) {
  // A small grid with a tinted header row.
  const cols = [30, 44, 58]
  const rows = [24, 32, 40, 48]
  return (
    <svg viewBox="0 0 96 72" className="w-full h-full" preserveAspectRatio="xMidYMid meet">
      <rect x="24" y="10" width="48" height="52" rx="3" fill="var(--bg-elevated)" stroke="var(--line-strong)" />
      <rect x="24" y="10" width="48" height="8" rx="3" fill={tint} opacity="0.25" />
      {[16, ...cols].map((x) => (
        <line key={`v${x}`} x1={x} y1="10" x2={x} y2="62" stroke="var(--line)" strokeWidth="0.8" />
      ))}
      {rows.map((y) => (
        <line key={`h${y}`} x1="24" y1={y} x2="72" y2={y} stroke="var(--line)" strokeWidth="0.8" />
      ))}
      <rect x="26" y="12" width="10" height="4" rx="1" fill={tint} opacity="0.8" />
    </svg>
  )
}

function SlideGlyph({ tint }: GlyphProps) {
  // A 16:9 stage with a title + bullet lines.
  return (
    <svg viewBox="0 0 96 72" className="w-full h-full" preserveAspectRatio="xMidYMid meet">
      <rect x="20" y="16" width="56" height="40" rx="3" fill="var(--bg-elevated)" stroke="var(--line-strong)" />
      <rect x="27" y="23" width="28" height="5" rx="2.5" fill={tint} opacity="0.85" />
      <circle cx="29" cy="37" r="1.6" fill="var(--ink-ghost)" />
      <rect x="34" y="35.5" width="30" height="2.6" rx="1.3" fill="var(--ink-ghost)" />
      <circle cx="29" cy="45" r="1.6" fill="var(--ink-ghost)" />
      <rect x="34" y="43.5" width="24" height="2.6" rx="1.3" fill="var(--ink-ghost)" />
    </svg>
  )
}

function PdfGlyph({ tint }: GlyphProps) {
  return (
    <svg viewBox="0 0 96 72" className="w-full h-full" preserveAspectRatio="xMidYMid meet">
      <rect x="28" y="8" width="40" height="56" rx="3" fill="var(--bg-elevated)" stroke="var(--line-strong)" />
      <path d="M56 8 v10 h10" fill="none" stroke="var(--line-strong)" strokeWidth="1.2" />
      <rect x="34" y="46" width="20" height="9" rx="2" fill={tint} opacity="0.9" />
      <text x="44" y="53" textAnchor="middle" fontSize="6" fontWeight="700" fill="#fff" fontFamily="var(--font-sans)">PDF</text>
      <rect x="34" y="24" width="26" height="2.4" rx="1.2" fill="var(--ink-ghost)" />
      <rect x="34" y="30" width="26" height="2.4" rx="1.2" fill="var(--ink-ghost)" />
      <rect x="34" y="36" width="18" height="2.4" rx="1.2" fill="var(--ink-ghost)" />
    </svg>
  )
}

function WhiteboardGlyph({ tint }: GlyphProps) {
  // An infinite canvas: a few loose shapes + a connector, sketch-style.
  return (
    <svg viewBox="0 0 96 72" className="w-full h-full" preserveAspectRatio="xMidYMid meet">
      <rect x="16" y="10" width="64" height="52" rx="4" fill="var(--bg-elevated)" stroke="var(--line-strong)" />
      <rect x="26" y="20" width="20" height="14" rx="2" fill={tint} opacity="0.28" stroke={tint} strokeWidth="1.2" />
      <circle cx="62" cy="27" r="8" fill="none" stroke={tint} strokeWidth="1.4" opacity="0.85" />
      <path d="M46 27 h8" stroke="var(--ink-ghost)" strokeWidth="1.4" />
      <path d="M30 44 q10 8 24 2 t14 -2" fill="none" stroke={tint} strokeWidth="1.4" opacity="0.7" />
      <rect x="30" y="24" width="12" height="2.2" rx="1.1" fill={tint} opacity="0.9" />
    </svg>
  )
}

const GLYPH: Record<DocThumbType, (props: GlyphProps) => ReturnType<typeof DocGlyph>> =
  { doc: DocGlyph, sheet: SheetGlyph, slide: SlideGlyph, pdf: PdfGlyph, whiteboard: WhiteboardGlyph }

interface DocThumbProps {
  type?: DocThumbType
  className?: string
}

export default function DocThumb({ type = 'doc', className = '' }: DocThumbProps) {
  const Glyph = GLYPH[type] || DocGlyph
  const tint = TINT[type] || TINT.doc
  return (
    <div
      aria-hidden
      className={`relative flex items-center justify-center overflow-hidden ${className}`}
      style={{
        background:
          'radial-gradient(120% 120% at 50% 0%, color-mix(in srgb, ' +
          tint +
          ' 9%, transparent), transparent 70%), var(--bg-surface)',
      }}
    >
      <div className="w-[60%] max-w-[120px] drop-shadow-[0_2px_6px_rgba(0,0,0,0.35)]">
        <Glyph tint={tint} />
      </div>
    </div>
  )
}
