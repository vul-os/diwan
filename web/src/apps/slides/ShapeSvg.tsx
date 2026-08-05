/**
 * ShapeSvg.jsx — render a shape object as pure SVG (P4).
 *
 * All geometry is derived from the object's clamped numeric fields (fill/stroke
 * are sanitizeColor()'d, strokeWidth/opacity are clampFinite()'d in
 * sanitizeObject), so there is no untrusted-string path into the DOM here.
 * The SVG uses a 0..100 viewBox and preserveAspectRatio=none so it stretches to
 * the object's absolutely-positioned box exactly.
 */

import type { ShapeSlideObject } from './slideObjects'

export default function ShapeSvg({ obj }: { obj: ShapeSlideObject }) {
  const fill = obj.fill || '#7c6af7'
  const stroke = obj.stroke || '#5b4dd0'
  const sw = Number.isFinite(obj.strokeWidth) ? obj.strokeWidth : 2
  const opacity = Number.isFinite(obj.opacity) ? obj.opacity : 1
  const kind = obj.shape || 'rect'

  // Half stroke inset so the outline isn't clipped by the viewBox edge.
  const p = sw / 2 + 1
  const common = { fill, stroke, strokeWidth: sw, opacity, vectorEffect: 'non-scaling-stroke' }

  let shape = null
  switch (kind) {
    case 'oval':
      shape = <ellipse cx="50" cy="50" rx={50 - p} ry={50 - p} {...common} />
      break
    case 'roundRect':
      shape = <rect x={p} y={p} width={100 - 2 * p} height={100 - 2 * p} rx="12" ry="12" {...common} />
      break
    case 'triangle':
      shape = <polygon points={`50,${p} ${100 - p},${100 - p} ${p},${100 - p}`} {...common} />
      break
    case 'star':
      shape = <polygon points={starPoints()} {...common} />
      break
    case 'line':
      shape = <line x1={p} y1="50" x2={100 - p} y2="50" stroke={stroke} strokeWidth={sw} opacity={opacity} vectorEffect="non-scaling-stroke" />
      break
    case 'arrow':
      // A horizontal arrow: shaft + head.
      shape = (
        <g fill={fill} stroke={stroke} strokeWidth={sw} opacity={opacity} vectorEffect="non-scaling-stroke">
          <line x1={p} y1="50" x2={72} y2="50" />
          <polygon points={`72,30 ${100 - p},50 72,70`} />
        </g>
      )
      break
    case 'callout':
      // Rounded speech bubble with a tail bottom-left.
      shape = (
        <path
          d={`M ${p} ${p} H ${100 - p} V 68 H 34 L 20 ${100 - p} L 26 68 H ${p} Z`}
          {...common} strokeLinejoin="round"
        />
      )
      break
    case 'rect':
    default:
      shape = <rect x={p} y={p} width={100 - 2 * p} height={100 - 2 * p} {...common} />
      break
  }

  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      width="100%"
      height="100%"
      style={{ display: 'block', pointerEvents: 'none' }}
      aria-hidden="true"
    >
      {shape}
    </svg>
  )
}

function starPoints() {
  const cx = 50, cy = 52, outer = 46, inner = 19, spikes = 5
  const pts = []
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 === 0 ? outer : inner
    const a = (Math.PI / spikes) * i - Math.PI / 2
    pts.push(`${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`)
  }
  return pts.join(' ')
}
