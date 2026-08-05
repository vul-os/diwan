/**
 * src/apps/sheets/ColorScaleLayer.tsx  (WAVE-63, WAVE-64)
 *
 * Reactive overlay that paints conditional formatting into the grid: COLOR
 * SCALES, DATA BARS and the WAVE-64 SINGLE-COLOUR rules (greater-than / text /
 * date / empty / duplicate / custom formula) — all of which computeAllColorScales
 * resolves to the same `{ bg } | { bar }` paint map, so this layer needs no
 * per-kind knowledge. It positions a coloured background / proportional bar over
 * each affected cell using the SAME getCellRect(row,col) that the live cursor
 * layer uses — so it tracks scroll/resize like the rest of the overlays.
 *
 * REACTIVITY: memoised on a signature of exactly the cells the rules read plus
 * the rule configs, so painting recomputes only when a source value or a rule
 * changes. The container is pointer-events:none so it never blocks grid
 * interaction; it sits BELOW the cell text (zIndex under the grid content is not
 * possible over the canvas, so we render a translucent tint that reads under the
 * value while staying legible).
 *
 * SECURITY: the only style values are (a) validated `#hex`/`rgb()` colours from
 * safeColor/lerp and (b) numeric widths — never a cell-derived string, never
 * innerHTML. So this path cannot inject a `url()`/`expression()`/script value
 * and never renders untrusted cell text at all.
 */
import { memo, useMemo, useState, useEffect, useCallback, type CSSProperties } from 'react'
import { getColorScales, computeAllColorScales, colorScaleSignature, type CSSheet } from './colorScales.js'

interface CellRect { top: number; left: number; width: number; height: number }

interface ColorScaleLayerProps {
  data: CSSheet[]
  getCellRect?: ((r: number, c: number) => CellRect | null | undefined) | null
  scrollTick?: unknown
}

function ColorScaleLayerInner({ data, getCellRect, scrollTick }: ColorScaleLayerProps) {
  const sheet = data?.[0]
  const rules = useMemo(() => getColorScales(data), [data])

  // Fingerprint of every rule's source cells + config → recompute only on change.
  const signature = useMemo(
    () => rules.map((r) => colorScaleSignature(r, sheet)).join('||'),
    [rules, sheet]
  )
  const paint = useMemo(
    () => computeAllColorScales(rules, sheet),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signature]
  )

  // Positions are DOM-measured, so recompute on paint change AND scroll/resize.
  const [rects, setRects] = useState<{ key: string; rect: CellRect; paint: (typeof paint)[string] }[]>([])
  const measure = useCallback(() => {
    if (!getCellRect) { setRects([]); return }
    const out: { key: string; rect: CellRect; paint: (typeof paint)[string] }[] = []
    for (const key in paint) {
      const [r, c] = key.split('_').map(Number)
      const rect = getCellRect(r, c)
      if (rect) out.push({ key, rect, paint: paint[key] })
    }
    setRects(out)
  }, [paint, getCellRect])

  useEffect(() => { measure() }, [measure, scrollTick])

  if (rects.length === 0) return null

  return (
    <div className="absolute inset-0" style={{ pointerEvents: 'none', overflow: 'hidden', zIndex: 5 }}>
      {rects.map(({ key, rect, paint: p }) => {
        if ('bg' in p) {
          return (
            <div
              key={key}
              style={{
                position: 'absolute',
                top: rect.top, left: rect.left, width: rect.width, height: rect.height,
                background: p.bg,
                opacity: 0.55, // translucent so the cell value stays legible over it
              }}
            />
          )
        }
        if ('bar' in p) {
          const w = Math.max(0, Math.min(1, p.bar.pct)) * (rect.width - 2)
          // Positive bars grow from the left; negative bars grow from the right.
          const style: CSSProperties = {
            position: 'absolute',
            top: rect.top + 1, height: rect.height - 2, width: w,
            background: p.bar.color, opacity: 0.45, borderRadius: 1,
          }
          if (p.bar.negative) { style.right = 'auto'; style.left = rect.left + (rect.width - 2) - w }
          else style.left = rect.left + 1
          return <div key={key} style={style} />
        }
        return null
      })}
    </div>
  )
}

export default memo(ColorScaleLayerInner)
