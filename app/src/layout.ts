// The fixed 3-container HUD layout from design/02-glasses-ux.md section 2,
// plus render(screen): diff against what is on the glasses and send one
// textContainerUpgrade per changed container, one bridge call at a time.

import {
  CreateStartUpPageContainer,
  MenuContainerProperty,
  MenuItemProperty,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'

export type Level = 0 | 1 | 2 | 3 | 4

// Render contract (02 section 2). Same shape the laptop mirror will use.
export interface Screen {
  hdr: string; hdrLevel: Level
  body: string; bodyLevel: Level
  foot: string; footLevel: Level
}

type Slot = 'hdr' | 'body' | 'foot'

// Geometry: firmware line height is a fixed 27 px (even-pretext). Each container's
// inner height (h - 2 * PAD) is an exact multiple of 27, so no partial line ever
// shows: hdr and foot hold exactly 1 line, body exactly BODY_LINES. On hardware the
// old 44/200/44 px boxes (inner 32/188 px) showed cut-off lines.
export const LINE_PX = 27
export const PAD = 4
export const BODY_LINES = 5
export const INNER_W = 576 - 2 * PAD          // text wrap width in px (568)
const box = (lines: number) => lines * LINE_PX + 2 * PAD

// ID and name must match exactly on every upgrade or it silently no-ops.
const CONTAINERS: Record<Slot, { id: number; y: number; h: number; capture: 0 | 1 }> = {
  hdr: { id: 1, y: 0, h: box(1), capture: 0 },                          // 0-35
  body: { id: 2, y: 44, h: box(BODY_LINES), capture: 1 },               // 44-187
  foot: { id: 3, y: 288 - box(1), h: box(1), capture: 0 },              // 253-288
}
const SLOTS: Slot[] = ['hdr', 'body', 'foot']
const LEVEL = { hdr: 'hdrLevel', body: 'bodyLevel', foot: 'footLevel' } as const

// Unverified: whether an empty string is accepted. A single space is safe.
const text = (s: string) => (s === '' ? ' ' : s)

let bridge: EvenAppBridge | null = null
let shown: Screen | null = null

// ---- serial bridge queue -------------------------------------------------
// The Even skills say: serialize every bridge call and cap each one, since a
// flaky BLE hop can hang for ~30 s. Everything (render, audioControl, exit)
// goes through here.
let chain: Promise<unknown> = Promise.resolve()

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms)
    p.then(v => { clearTimeout(t); resolve(v) }, e => { clearTimeout(t); reject(e) })
  })
}

export function serial<T>(label: string, fn: () => Promise<T>, ms = 5000): Promise<T | undefined> {
  const run = chain.then(() => withTimeout(fn(), ms, label)).catch(err => {
    console.warn(`[bridge] ${label} failed:`, err)
    return undefined
  })
  chain = run
  return run
}

// ---- create once ----------------------------------------------------------
export async function createLayout(
  b: EvenAppBridge,
  first: Screen,
  menu: { id: number; name: string }[],
): Promise<StartUpPageCreateResult> {
  bridge = b
  const textObject = SLOTS.map(slot => {
    const c = CONTAINERS[slot]
    return new TextContainerProperty({
      xPosition: 0, yPosition: c.y, width: 576, height: c.h,
      borderWidth: 0, borderColor: 0, borderRadius: 0, paddingLength: PAD,
      containerID: c.id, containerName: slot,
      isEventCapture: c.capture,
      content: text(first[slot]),
      textColor: first[LEVEL[slot]],
    })
  })
  const menuObject = new MenuContainerProperty({
    menuItems: menu.map(m => new MenuItemProperty({ itemID: m.id, itemName: m.name })),
  })
  const result = await b.createStartUpPageContainer(
    new CreateStartUpPageContainer({ containerTotalNum: 3, textObject, menuObject }),
  )
  if (result === StartUpPageCreateResult.success) {
    shown = { ...first }
    return result
  }
  // The startup page can only be created once per app launch. After a WebView
  // reload (dev hot reload) the create call fails and the glasses keep the old
  // page, so rebuild it in place instead.
  const rebuilt = await b.rebuildPageContainer(
    new RebuildPageContainer({ containerTotalNum: 3, textObject, menuObject }),
  )
  if (rebuilt) {
    shown = { ...first }
    return StartUpPageCreateResult.success
  }
  return result
}

// ---- render ---------------------------------------------------------------
let pending: Screen | null = null
let scheduled = false
const listeners: ((s: Screen) => void)[] = []

/** Called with every Screen passed to render() (phone mirror uses this). */
export function onRender(fn: (s: Screen) => void) { listeners.push(fn) }

export function render(next: Screen) {
  pending = next
  listeners.forEach(fn => fn(next))
  if (scheduled || !bridge) return
  scheduled = true
  // Coalesce: if several renders arrive while BLE is busy, only the latest is sent.
  void serial('render', async () => {
    scheduled = false
    const s = pending
    pending = null
    if (s) await apply(s)
  }, 8000)
}

async function apply(s: Screen) {
  if (!bridge || !shown) return
  for (const slot of SLOTS) {
    const level = s[LEVEL[slot]]
    if (shown[slot] === s[slot] && shown[LEVEL[slot]] === level) continue
    const ok = await bridge.textContainerUpgrade(new TextContainerUpgrade({
      containerID: CONTAINERS[slot].id,
      containerName: slot,
      content: text(s[slot]),
      textColor: level,
    }))
    if (!ok) console.warn(`[render] textContainerUpgrade(${slot}) returned false`)
    shown = { ...shown, [slot]: s[slot], [LEVEL[slot]]: level }
  }
}
