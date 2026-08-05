import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import type Reveal from 'reveal.js'
// SOVEREIGNTY: reveal.js core + theme CSS are served from the locally-bundled
// npm package (self-hosted), NOT fetched from cdnjs.cloudflare.com at runtime.
// A self-host product must never depend on a third-party CDN for its assets.
import 'reveal.js/dist/reveal.css'
// All reveal themes bundled as local asset URLs; picked by name below.
const REVEAL_THEMES = import.meta.glob('/node_modules/reveal.js/dist/theme/*.css', {
  query: '?url', import: 'default', eager: true,
}) as Record<string, string>
function revealThemeUrl(name: string | null | undefined): string {
  const key = `/node_modules/reveal.js/dist/theme/${name || 'black'}.css`
  return REVEAL_THEMES[key] || REVEAL_THEMES['/node_modules/reveal.js/dist/theme/black.css']
}
// Shared DOMPurify config (see src/lib/sanitize.js) — allows Tiptap/Reveal HTML
// tags, strips anything that could execute code (<script>, on* handlers,
// javascript: URLs, <iframe>).
import { sanitizeSlideHtml as sanitize } from '../../lib/sanitize'
import { ensureObjects, sortByZ, type SlideLike } from './slideObjects'
import ShapeSvg from './ShapeSvg'
import { playAnimationsOn, type SlideAnimation } from './slideAnimations'

interface PreviewSlide extends SlideLike {
  id: string
  background?: string
  transition?: string | undefined
  notes?: string
  animations?: SlideAnimation[] | undefined
}

interface PreviewData {
  slides: PreviewSlide[]
  transition?: string
  theme?: string
}

/**
 * SlidePreview — full-screen reveal.js presentation overlay.
 *
 * Renders each slide's positioned objects (P2) inside the reveal <section>, and
 * plays that slide's per-element animations (P1) on slide-change. reveal owns the
 * slide-to-slide transition; our CSS animation layer runs the entrance/exit/
 * emphasis effects on the objects (honouring prefers-reduced-motion).
 *
 * The presentation itself is reveal.js territory (its own themes), so the
 * design-system retint is intentionally light-touch. Background stays
 * pitch-black so reveal themes render correctly.
 */
export default function SlidePreview({ data, onClose }: { data: PreviewData; onClose: () => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const deckRef = useRef<Reveal.Api | null>(null)
  const animCleanupRef = useRef<(() => void) | null>(null)

  // Precompute objects per slide so render + animation playback agree.
  const slides = data.slides.map((s) => ({ ...s, _objects: ensureObjects(s) }))

  useEffect(() => {
    if (!containerRef.current) return
    let deck: Reveal.Api | null = null

    // Play the animations for the section that just became active.
    const playForSection = (sectionEl: HTMLElement | null | undefined) => {
      if (animCleanupRef.current) { animCleanupRef.current(); animCleanupRef.current = null }
      const idx = Number(sectionEl?.dataset?.slideIndex)
      const slide = Number.isFinite(idx) ? slides[idx] : null
      if (!slide) return
      const els = sortByZ(slide._objects)
        .map((o) => sectionEl!.querySelector<HTMLElement>(`[data-object-id="${o.id}"]`))
        .filter((el): el is HTMLElement => Boolean(el))
      animCleanupRef.current = playAnimationsOn(els, slide.animations || [])
    }

    import('reveal.js').then(({ default: RevealCtor }) => {
      deck = new RevealCtor(containerRef.current as HTMLElement, {
        embedded: true,
        transition: (data.transition || 'slide') as NonNullable<Reveal.Options['transition']>,
        margin: 0.04,
        controls: true,
        progress: true,
        slideNumber: true,
        hash: false,
        keyboard: true,
        overview: true,
        center: true,
      })
      deck.initialize().then(() => {
        deckRef.current = deck
        // First slide.
        playForSection(deck!.getCurrentSlide?.())
        deck!.on('slidechanged', (ev) => playForSection((ev as Event & { currentSlide?: HTMLElement }).currentSlide))
      })
    })

    return () => {
      if (animCleanupRef.current) { animCleanupRef.current(); animCleanupRef.current = null }
      try { deck?.destroy() } catch { /* ignore */ }
    }
  }, [data]) // eslint-disable-line

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  // Restore focus to whatever was focused before the presentation opened.
  const priorFocusRef = useRef<Element | null>(null)
  useEffect(() => {
    priorFocusRef.current = document.activeElement
    return () => {
      const el = priorFocusRef.current
      if (el && typeof (el as HTMLElement).focus === 'function') (el as HTMLElement).focus()
    }
  }, [])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Presentation"
      className="fixed inset-0 z-50 bg-black flex flex-col animate-fade-in">
      <div className="absolute top-4 right-4 z-10">
        <button
          onClick={onClose}
          aria-label="Exit presentation"
          title="Exit presentation (Esc)"
          className={[
            'inline-flex items-center justify-center h-9 w-9 rounded-md',
            'bg-black/55 text-white border border-white/10',
            'hover:bg-black/75 hover:border-white/20',
            'focus-visible:outline-none focus-visible:shadow-focus',
            'transition-[background,border-color] duration-fast ease-out',
          ].join(' ')}
        >
          <X size={18} />
        </button>
      </div>

      {/* reveal core CSS bundled via the module import above; theme CSS served
          from the local package asset (no cdnjs runtime fetch). */}
      <link rel="stylesheet" href={revealThemeUrl(data.theme)} />

      <div ref={containerRef} className="reveal flex-1 w-full">
        <div className="slides">
          {slides.map((slide, idx) => (
            <section
              key={slide.id}
              data-slide-index={idx}
              data-background={slide.background || undefined}
              data-transition={slide.transition && slide.transition !== 'none' ? slide.transition : undefined}
            >
              {/* Positioned-object stage: absolute objects on a 16:9 box.
                  Kept read-only; text HTML is sanitized before render. */}
              <div style={{ position: 'relative', width: '100%', aspectRatio: '16 / 9' }}>
                {sortByZ(slide._objects).map((obj) => (
                  <div
                    key={obj.id}
                    data-object-id={obj.id}
                    style={{
                      position: 'absolute',
                      left: `${obj.x * 100}%`, top: `${obj.y * 100}%`,
                      width: `${obj.w * 100}%`, height: `${obj.h * 100}%`,
                      transform: `rotate(${obj.rotation || 0}deg)`,
                      transformOrigin: 'center center',
                      zIndex: obj.z || 1,
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: ('valign' in obj && obj.valign === 'middle') ? 'center' : ('valign' in obj && obj.valign === 'bottom') ? 'flex-end' : 'flex-start',
                      textAlign: ('align' in obj ? obj.align : undefined) || 'left',
                      overflow: 'hidden',
                    }}
                  >
                    {obj.type === 'text' && (
                      <div dangerouslySetInnerHTML={{ __html: sanitize(obj.html) }} />
                    )}
                    {obj.type === 'image' && obj.src && (
                      <img src={obj.src} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                    )}
                    {obj.type === 'shape' && <ShapeSvg obj={obj} />}
                  </div>
                ))}
              </div>
              {slide.notes && <aside className="notes">{slide.notes}</aside>}
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
