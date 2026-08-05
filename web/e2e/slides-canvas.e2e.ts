/**
 * Slides object-canvas E2E (CAPSTONE) — real-browser coverage of the
 * free-positioning object canvas (feat/slides-canvas): insert, keyboard-nudge,
 * pointer drag-move, resize (handle), rotate (handle), z-order, align, group /
 * ungroup, and animation playback. These interactions are pointer/geometry
 * driven and cannot run headless, so they are exercised here against a real
 * chromium page.
 *
 * Hermetic harness (vite preview + mocked backend). The SlideCanvas + arrange
 * toolbar + slideObjects/slideArrange logic all run LOCALLY in the page, so
 * every assertion is against the real committed object geometry the canvas
 * renders — objects are absolutely positioned in normalized [0,1] slide space
 * and painted as inline `left/top/width/height` percentages plus a
 * `transform: rotate(Ndeg)`; z is the inline `z-index`.
 *
 * WHY these assertions prove the feature WORKS (not just "renders"):
 *   • move  — the object's `left` % strictly increases after nudge/drag.
 *   • resize— the object's `width` % strictly increases after dragging the SE handle.
 *   • rotate— the object's `transform` goes from rotate(0) to a non-zero angle.
 *   • z     — bring-to-front makes the object's z-index the max on the slide.
 *   • align — align-left makes two objects share the same `left` %.
 *   • group — after Group, the contextual Ungroup control becomes enabled
 *             (canUngroup ⇔ a selected object actually carries a group tag),
 *             and Ungroup clears it again.
 *   • anim  — Play applies the real `vslide-anim-*` keyframe class to the object.
 */

import { type Locator } from '@playwright/test'
import { test, expect, type OfficePage } from './fixtures.js'

interface SlideAnimation {
  id: string
  label: string
  type: string
  effect: string
  order: number
}

interface Deck {
  id: string
  name: string
  type: string
  content: {
    themeId: string
    theme: string
    transition: string
    slides: [{
      id: string
      title: string
      content: string
      notes: string
      animations?: SlideAnimation[]
    }]
    masters: null
    customTheme: null
  }
}

interface MakeDeckOptions {
  animations?: SlideAnimation[] | null
}

// A deck whose single slide carries a title + body — the legacy→object migration
// turns these into TWO positioned text objects, giving us a multi-object slide to
// arrange/align/group without depending on the insert UI.
function makeDeck({ animations = null }: MakeDeckOptions = {}): Deck {
  return {
    id: 'deck1', name: 'Pitch', type: 'slide',
    content: {
      themeId: 'obsidian', theme: 'black', transition: 'slide',
      slides: [{
        id: 's1', title: 'Roadmap', content: '<p>Body copy here</p>', notes: '',
        ...(animations ? { animations } : {}),
      }],
      masters: null, customTheme: null,
    },
  }
}

async function openDeck(page: OfficePage, deck: Deck = makeDeck()): Promise<void> {
  await page.route(/\/api\/files\/deck1$/, (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(deck) })
  })
  await page.route('**/api/files', (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify([deck]) })
  })
  await page.goto('/slides/deck1')
  await expect(page.getByLabel('Presentation title')).toHaveValue('Pitch', { timeout: 20_000 })
  await expect(page.locator('.vslide-object').first()).toBeVisible({ timeout: 15_000 })
}

// Read the numeric % from an inline `left`/`top`/`width` style value.
const pctOf = (v: string | number): number => parseFloat(String(v).replace('%', ''))
const styleNum = (loc: Locator, prop: string): Promise<string> =>
  loc.evaluate((el, p) => (el.style as unknown as Record<string, string>)[p], prop)
// Extract the rotate() angle (deg) from an inline transform, 0 when none.
const rotationOf = (loc: Locator): Promise<number> => loc.evaluate((el) => {
  const m = /rotate\(([-\d.]+)deg\)/.exec(el.style.transform || '')
  return m ? parseFloat(m[1]) : 0
})

interface BoundingBox {
  x: number
  y: number
  width: number
  height: number
}

function requireBox(box: BoundingBox | null, what: string): BoundingBox {
  if (!box) throw new Error(`expected a bounding box for ${what}`)
  return box
}

// Insert a fresh text box (x:0.3 w:0.4 — plenty of room to grow/move without
// hitting the stage edge) and return a STABLE locator to it by data-object-id.
// Objects render in z-sorted DOM order, so an nth()/first() locator re-resolves
// to a different object the moment a z-order op reorders the stack — the id
// locator is immune to that. Escape leaves edit mode but KEEPS the selection.
async function insertBox(page: OfficePage): Promise<Locator> {
  const before = await page.locator('.vslide-object').count()
  await page.getByRole('button', { name: 'Insert text box' }).click()
  await expect(page.locator('.vslide-object')).toHaveCount(before + 1)
  // The new text object opens its inline editor and is selected; capture its
  // stable id NOW (aria-pressed is set while editing).
  const editor = page.locator('[data-object-text-editor] .ProseMirror').first()
  await editor.waitFor({ timeout: 5000 })
  const id = await page.locator('.vslide-object[aria-pressed="true"]').getAttribute('data-object-id')
  const obj = page.locator(`[data-object-id="${id}"]`)
  // Escape commits + closes the inline editor. Then fully deselect (click an
  // empty stage corner) and cleanly single-click the object to select it — a
  // deterministic select that avoids the focus-timing race in whether Escape
  // also deselected, and never re-enters edit mode (which a second click on an
  // already-selected text object would). Now the object is selected + NOT
  // editing, so the arrange toolbar + resize/rotate handles are present.
  await page.keyboard.press('Escape')
  await editor.waitFor({ state: 'detached', timeout: 5000 })
  const stage = requireBox(await page.locator('.vslide-stage').boundingBox(), '.vslide-stage')
  await page.mouse.click(stage.x + stage.width * 0.95, stage.y + stage.height * 0.95) // empty corner
  await expect(obj).toHaveAttribute('aria-pressed', 'false')
  await obj.click()
  await expect(obj).toHaveAttribute('aria-pressed', 'true')
  // Inserted at x:0.3 w:0.4 — off the migrated objects' shared left edge (x~0.08)
  // so drag-snapping to a sibling can't lock it in place.
  return obj
}

// Measured stage size (px) — drag deltas are scaled to it so a move/resize is a
// meaningful fraction of the slide regardless of the preview viewport size.
async function stageBox(page: OfficePage): Promise<BoundingBox | null> {
  return page.locator('.vslide-stage').boundingBox()
}

test.describe('Slides object canvas — geometry (CAPSTONE E2E)', () => {
  test('Insert text box adds a new positioned object to the slide', async ({ officePage: page }) => {
    await openDeck(page)
    const before = await page.locator('.vslide-object').count()
    expect(before).toBeGreaterThanOrEqual(2) // migrated title + body

    await page.getByRole('button', { name: 'Insert text box' }).click()
    // A new object is added AND selected (its inline editor opens for text).
    await expect(page.locator('.vslide-object')).toHaveCount(before + 1)
  })

  test('keyboard nudge moves the selected object to the right', async ({ officePage: page }) => {
    await openDeck(page)
    const obj = page.locator('.vslide-object').first()
    await obj.click() // single click → select (NOT edit)
    await expect(obj).toHaveAttribute('aria-pressed', 'true')

    const leftBefore = pctOf(await styleNum(obj, 'left'))
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight')
    // Each ArrowRight nudges x by 0.005 (0.5%) and commits, so left grows ~2.5%.
    await expect.poll(async () => pctOf(await styleNum(obj, 'left')))
      .toBeGreaterThan(leftBefore + 1)
  })

  test('pointer drag moves an object across the stage', async ({ officePage: page }) => {
    await openDeck(page)
    const obj = await insertBox(page)
    const leftBefore = pctOf(await styleNum(obj, 'left'))
    const topBefore = pctOf(await styleNum(obj, 'top'))

    const box = requireBox(await obj.boundingBox(), 'the inserted object')
    const stage = requireBox(await stageBox(page), '.vslide-stage')
    // Drag ~20% of the stage down-and-right, in steps so the canvas pointermove
    // handler fires and commits on pointer-up.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(
      box.x + box.width / 2 + stage.width * 0.2,
      box.y + box.height / 2 + stage.height * 0.2,
      { steps: 10 })
    await page.mouse.up()

    await expect.poll(async () => pctOf(await styleNum(obj, 'left'))).toBeGreaterThan(leftBefore + 8)
    expect(pctOf(await styleNum(obj, 'top'))).toBeGreaterThan(topBefore + 8)
  })

  test('resizing via the SE handle enlarges the object', async ({ officePage: page }) => {
    await openDeck(page)
    const obj = await insertBox(page)
    const widthBefore = pctOf(await styleNum(obj, 'width'))

    const handle = page.getByLabel('Resize se')
    await expect(handle).toBeVisible()
    const hb = requireBox(await handle.boundingBox(), 'the resize handle')
    const stage = requireBox(await stageBox(page), '.vslide-stage')
    // Pull the SE handle right+down by ~15% of the stage → the box widens.
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
    await page.mouse.down()
    await page.mouse.move(hb.x + stage.width * 0.15, hb.y + stage.height * 0.15, { steps: 10 })
    await page.mouse.up()

    await expect.poll(async () => pctOf(await styleNum(obj, 'width'))).toBeGreaterThan(widthBefore + 6)
  })

  test('rotating via the rotate handle sets a non-zero angle', async ({ officePage: page }) => {
    await openDeck(page)
    const obj = await insertBox(page)
    expect(await rotationOf(obj)).toBe(0)

    const rot = page.getByLabel('Rotate')
    await expect(rot).toBeVisible()
    const rb = requireBox(await rot.boundingBox(), 'the rotate handle')
    // Grab the rotate handle and swing it sideways around the object centre.
    await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2)
    await page.mouse.down()
    await page.mouse.move(rb.x + 140, rb.y + 80, { steps: 10 })
    await page.mouse.up()

    await expect.poll(async () => rotationOf(obj)).toBeGreaterThan(1)
  })

  test('Bring to front makes the object the top of the z-order', async ({ officePage: page }) => {
    await openDeck(page)
    const objs = page.locator('.vslide-object')

    // Select the lowest object in the z-order (nth(0) — objects render z-sorted)
    // and capture its STABLE id, because bring-to-front reorders the DOM.
    const lowest = objs.nth(0)
    await lowest.click()
    await expect(lowest).toHaveAttribute('aria-pressed', 'true')
    const id = await lowest.getAttribute('data-object-id')
    const target = page.locator(`[data-object-id="${id}"]`)
    const zTarget = () => target.evaluate((el) => Number(el.style.zIndex) || 0)

    await page.getByRole('button', { name: 'Bring to front' }).click()

    // That specific object's z-index is now the UNIQUE maximum on the slide.
    await expect.poll(async () => {
      const zs = await objs.evaluateAll((els) => els.map((e) => Number(e.style.zIndex) || 0))
      const zt = await zTarget()
      return zt === Math.max(...zs) && zs.filter((z) => z === zt).length === 1
    }).toBe(true)
  })

  test('Align left gives two selected objects the same left edge', async ({ officePage: page }) => {
    await openDeck(page)
    const objs = page.locator('.vslide-object')
    const a = objs.nth(0)
    const b = objs.nth(1)

    await a.click()
    await b.click({ modifiers: ['Shift'] }) // additive → multi-select
    await expect(a).toHaveAttribute('aria-pressed', 'true')
    await expect(b).toHaveAttribute('aria-pressed', 'true')

    await page.getByRole('button', { name: 'Align left' }).click()

    await expect.poll(async () => {
      const la = pctOf(await styleNum(a, 'left'))
      const lb = pctOf(await styleNum(b, 'left'))
      return Math.abs(la - lb)
    }).toBeLessThan(0.6)
  })

  test('Group tags the selection (Ungroup enables) and Ungroup clears it', async ({ officePage: page }) => {
    await openDeck(page)
    const objs = page.locator('.vslide-object')
    await objs.nth(0).click()
    await objs.nth(1).click({ modifiers: ['Shift'] })

    const groupBtn = page.getByRole('button', { name: 'Group', exact: true })
    const ungroupBtn = page.getByRole('button', { name: 'Ungroup' })
    // With ≥2 selected, Group is enabled and Ungroup is not (nothing grouped yet).
    await expect(groupBtn).toBeEnabled()
    await expect(ungroupBtn).toBeDisabled()

    await groupBtn.click()
    // canUngroup ⇔ a selected object now carries a group tag → the real
    // groupObjects() ran and mutated the model.
    await expect(ungroupBtn).toBeEnabled()

    await ungroupBtn.click()
    await expect(ungroupBtn).toBeDisabled()
  })
})

test.describe('Slides animations — playback (CAPSTONE E2E)', () => {
  test('Play applies the entrance animation class to the object', async ({ officePage: page }) => {
    // Ensure motion is not suppressed so the class is actually applied.
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await openDeck(page, makeDeck({
      animations: [{ id: 'a1', label: 'Fade in', type: 'entrance', effect: 'fade-in', order: 0 }],
    }))

    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(e.message))

    const play = page.getByRole('button', { name: 'Play animations' })
    await expect(play).toBeEnabled()
    await play.click()

    // The order-0 animation targets the first object in z-order; the real
    // playAnimationsOn() adds the fade-in keyframe class for the play window.
    await expect(page.locator('.vslide-object.vslide-anim-fade-in').first())
      .toHaveCount(1, { timeout: 3_000 })
    expect(pageErrors).toEqual([])
  })
})
