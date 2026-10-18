// Turns a raw EvenHubEvent into named gestures, keeping which envelope field
// it came in on. Hardware test mode exists to find out which field each
// gesture really uses, so we read every envelope and never assume.

import { EventSourceType, OsEventTypeList, type EvenHubEvent } from '@evenrealities/even_hub_sdk'

export type Field = 'textEvent' | 'sysEvent' | 'listEvent' | 'menuItemClickEvent'

export type GestureName =
  | 'click' | 'double_click' | 'swipe_up' | 'swipe_down'
  | 'foreground_enter' | 'foreground_exit' | 'abnormal_exit' | 'system_exit'
  | 'imu' | 'long_press' | 'long_press_release' | 'menu' | 'unknown'

export interface Gesture {
  name: GestureName
  field: Field
  eventType?: number          // raw value (undefined = protobuf-omitted 0)
  side?: 'R' | 'L' | 'ring'   // sysEvent.eventSource, when present
  menuItemId?: number
  containerName?: string
  at: number
}

const NAMES: Record<number, GestureName> = {
  [OsEventTypeList.CLICK_EVENT]: 'click',
  [OsEventTypeList.SCROLL_TOP_EVENT]: 'swipe_up',
  [OsEventTypeList.SCROLL_BOTTOM_EVENT]: 'swipe_down',
  [OsEventTypeList.DOUBLE_CLICK_EVENT]: 'double_click',
  [OsEventTypeList.FOREGROUND_ENTER_EVENT]: 'foreground_enter',
  [OsEventTypeList.FOREGROUND_EXIT_EVENT]: 'foreground_exit',
  [OsEventTypeList.ABNORMAL_EXIT_EVENT]: 'abnormal_exit',
  [OsEventTypeList.SYSTEM_EXIT_EVENT]: 'system_exit',
  [OsEventTypeList.IMU_DATA_REPORT]: 'imu',
  [OsEventTypeList.LONG_PRESS_EVENT]: 'long_press',
  [OsEventTypeList.LONG_PRESS_RELEASE_EVENT]: 'long_press_release',
}

const SIDES: Partial<Record<number, Gesture['side']>> = {
  [EventSourceType.TOUCH_EVENT_FROM_GLASSES_R]: 'R',
  [EventSourceType.TOUCH_EVENT_FROM_GLASSES_L]: 'L',
  [EventSourceType.TOUCH_EVENT_FROM_RING]: 'ring',
}

// CLICK_EVENT is 0 and protobuf omits zero fields, so a tap arrives with
// eventType undefined. Default to CLICK only inside an envelope that exists.
const typeOf = (env: { eventType?: number }) => env.eventType ?? OsEventTypeList.CLICK_EVENT

/** All gestures in one bridge event (usually 0 or 1). Audio is handled separately. */
export function parseGestures(e: EvenHubEvent): Gesture[] {
  const at = Date.now()
  const out: Gesture[] = []
  if (e.textEvent) {
    const t = typeOf(e.textEvent)
    out.push({ name: NAMES[t] ?? 'unknown', field: 'textEvent', eventType: e.textEvent.eventType,
      containerName: e.textEvent.containerName, at })
  }
  if (e.sysEvent) {
    const t = typeOf(e.sysEvent)
    const src = e.sysEvent.eventSource
    out.push({ name: NAMES[t] ?? 'unknown', field: 'sysEvent', eventType: e.sysEvent.eventType,
      side: src === undefined ? undefined : SIDES[src], at })
  }
  if (e.listEvent) {
    const t = typeOf(e.listEvent)
    out.push({ name: NAMES[t] ?? 'unknown', field: 'listEvent', eventType: e.listEvent.eventType,
      containerName: e.listEvent.containerName, at })
  }
  if (e.menuItemClickEvent) {
    out.push({ name: 'menu', field: 'menuItemClickEvent', menuItemId: e.menuItemClickEvent.itemID, at })
  }
  return out
}

/** Short label for the HUD and log, e.g. "click @sysEvent R". */
export function label(g: Gesture): string {
  const what = g.name === 'menu' ? `menu #${g.menuItemId ?? '?'}` : g.name
  return `${what} @${g.field}${g.side ? ' ' + g.side : ''}`
}

/** JSON for console.log without dumping PCM bytes. */
export function describeRaw(e: EvenHubEvent): string {
  return JSON.stringify(e, (k, v) => {
    if (k === 'audioPcm' && v && typeof v.length === 'number') return `<${v.length} bytes>`
    if (k === 'audioEvent' && v?.audioPcm) return { ...v, audioPcm: `<${v.audioPcm.length} bytes>` }
    return v
  })
}
