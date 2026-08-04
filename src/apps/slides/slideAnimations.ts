/**
 * slideAnimations.js — turn stored per-slide `animations[]` config into actual
 * playback (P1). The TransitionPanel writes descriptors of the form:
 *
 *   { id, label, type: 'entrance'|'exit'|'emphasis', effect, order }
 *   effect ∈ 'fade-in' | 'fly-in' | 'bounce' | 'zoom-in' | 'spin' | 'custom'
 *
 * Playback strategy — no heavy dependency:
 *   • A small library of CSS `@keyframes` (see index.css `.vslide-anim-*`).
 *   • Each animation maps to a CSS class + inline animation-delay (staggered by
 *     `order`). We attach classes to the animatable objects of a slide.
 *   • Respects `prefers-reduced-motion`: when reduced, animations are treated as
 *     instantly-complete (entrance/emphasis show final state; exit is a no-op so
 *     content never disappears on a reduced-motion user).
 *
 * The same descriptor drives BOTH the in-editor preview (a "Play" button in the
 * canvas) and the reveal.js present surface, so what you configure is what you
 * see everywhere.
 */

export type AnimationEffect = 'fade-in' | 'fly-in' | 'bounce' | 'zoom-in' | 'spin' | 'custom'
export type AnimationType = 'entrance' | 'exit' | 'emphasis'

export interface SlideAnimation {
  id?: string
  label?: string
  type?: AnimationType
  effect: AnimationEffect
  order?: number
}

// Effect → CSS class emitting a keyframe. Kept aligned with index.css.
const ENTRANCE_CLASS: Record<AnimationEffect, string> = {
  'fade-in': 'vslide-anim-fade-in',
  'fly-in': 'vslide-anim-fly-in',
  'bounce': 'vslide-anim-bounce',
  'zoom-in': 'vslide-anim-zoom-in',
  'spin': 'vslide-anim-spin-in',
  'custom': 'vslide-anim-fade-in',
}
const EXIT_CLASS: Record<AnimationEffect, string> = {
  'fade-in': 'vslide-anim-fade-out',
  'fly-in': 'vslide-anim-fly-out',
  'bounce': 'vslide-anim-fade-out',
  'zoom-in': 'vslide-anim-zoom-out',
  'spin': 'vslide-anim-spin-out',
  'custom': 'vslide-anim-fade-out',
}
const EMPHASIS_CLASS: Record<AnimationEffect, string> = {
  'fade-in': 'vslide-anim-pulse',
  'fly-in': 'vslide-anim-pulse',
  'bounce': 'vslide-anim-bounce-emph',
  'zoom-in': 'vslide-anim-pulse',
  'spin': 'vslide-anim-spin-emph',
  'custom': 'vslide-anim-pulse',
}

const STAGGER_MS = 220

/** True when the user asked for reduced motion. Safe in jsdom (guards matchMedia). */
export function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/**
 * animationClassFor — resolve a stored descriptor to { className, delayMs }.
 * Returns null if the effect/type is not recognised (nothing to play).
 * Pure + framework-free so it is unit-testable without a DOM.
 */
export function animationClassFor(
  anim: SlideAnimation | null | undefined,
): { className: string; delayMs: number; type: AnimationType } | null {
  if (!anim || typeof anim !== 'object') return null
  const order = Number.isFinite(anim.order) ? Math.max(0, anim.order as number) : 0
  const delayMs = order * STAGGER_MS
  let className: string | undefined
  if (anim.type === 'exit') className = EXIT_CLASS[anim.effect]
  else if (anim.type === 'emphasis') className = EMPHASIS_CLASS[anim.effect]
  else className = ENTRANCE_CLASS[anim.effect] // default: entrance
  if (!className) return null
  return { className, delayMs, type: anim.type || 'entrance' }
}

/**
 * playAnimationsOn — run a slide's animations against a set of animatable DOM
 * elements. Entrance/emphasis effects are applied in `order`; exits play after
 * entrances have settled. Returns a cleanup function that removes the applied
 * classes/styles. Honours reduced-motion by short-circuiting to final state.
 *
 * `els` are the candidate elements (each animation targets els[order]
 * when present, else all els share the animation). `anims` is the stored
 * slide.animations array.
 */
export function playAnimationsOn(
  els: readonly (HTMLElement | null | undefined)[] | null | undefined,
  anims: readonly SlideAnimation[] | null | undefined,
): () => void {
  const targets = Array.isArray(els) ? els.filter((e): e is HTMLElement => Boolean(e)) : []
  const list = Array.isArray(anims) ? [...anims].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)) : []
  if (targets.length === 0 || list.length === 0) return () => {}

  const reduced = prefersReducedMotion()
  const applied: Array<{ el: HTMLElement; className: string }> = []

  list.forEach((anim, i) => {
    const resolved = animationClassFor(anim)
    if (!resolved) return
    // Target the element at the animation's order slot; fall back to the last.
    const el = targets[Math.min(i, targets.length - 1)]
    if (!el) return

    if (reduced) {
      // No motion: leave content in its natural, fully-visible state. An exit
      // under reduced motion is a no-op (never hide content abruptly).
      return
    }
    el.style.animationDelay = `${resolved.delayMs}ms`
    el.classList.add(resolved.className)
    applied.push({ el, className: resolved.className })
  })

  return () => {
    for (const { el, className } of applied) {
      el.classList.remove(className)
      el.style.animationDelay = ''
    }
  }
}
