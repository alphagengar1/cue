// Cue glasses app entry. Boots into the real Cue flow (src/cue.ts).
// Hardware test mode (src/testmode.ts) is still reachable: open the page with
// ?test=1, pick the menu item "Hardware test", or press the button on the phone page.

import { OsEventTypeList, StartUpPageCreateResult, waitForEvenAppBridge, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { createLayout, render, serial } from './layout'
import { describeRaw, parseGestures, type Gesture } from './input'
import * as cue from './cue'
import * as test from './testmode'
import { mountCuePhone } from './cuephone'
import { mountPhone as mountTestPhone } from './phone'

let mode: 'cue' | 'test' = 'cue'
let bridge: EvenAppBridge | null = null

function enterTest() {
  if (mode === 'test') return
  mode = 'test'
  cue.log('-> hardware test mode')
  cue.suspend()
  mountTestPhone(exitTest)
  if (bridge) test.initTestMode(bridge)
}

function exitTest() {
  if (mode === 'cue') return
  mode = 'cue'
  test.stopTestMode()
  mountCuePhone(enterTest)
  cue.resume()
  cue.log('<- back from hardware test mode')
}

// In test mode the Cue menu is on screen: map its items to test-mode ids.
const TEST_MENU: Record<number, number> = { 1: 1, 7: 2, 8: 3 }

function routeGestures(gs: Gesture[]) {
  if (mode === 'cue') return cue.handleGestures(gs)
  const menu = gs.find(g => g.name === 'menu')
  if (menu?.menuItemId === 9) return exitTest()
  if (menu) menu.menuItemId = TEST_MENU[menu.menuItemId ?? 0] ?? 0
  test.handleGestures(gs)
}

cue.onHardwareTest(enterTest)
cue.initCue()
const startInTest = new URLSearchParams(location.search).get('test') === '1'
if (startInTest) { mode = 'test'; cue.suspend(); mountTestPhone(exitTest) }
else mountCuePhone(enterTest)

bridge = await waitForEvenAppBridge()
cue.setBridgeStatus('bridge ready')
test.setBridgeStatus('bridge ready')
cue.attachBridge(bridge)

const first = mode === 'test' ? test.currentScreen() : cue.currentScreen()
const result = await createLayout(bridge, first, cue.MENU)
if (result !== StartUpPageCreateResult.success) {
  const msg = `createStartUpPageContainer failed: ${result} (1 invalid, 2 oversize, 3 out of memory)`
  cue.setBridgeStatus(msg); test.setBridgeStatus(msg); cue.log(msg)
} else {
  cue.setBridgeStatus('glasses page created'); test.setBridgeStatus('glasses page created')
  cue.log('createStartUpPageContainer ok')
}

if (mode === 'test') test.initTestMode(bridge)
else render(cue.currentScreen())   // state may have changed while the page was being created

const unsubscribe = bridge.onEvenHubEvent(event => {
  const pcm = event.audioEvent?.audioPcm
  if (pcm) {
    if (mode === 'cue') cue.handleAudio(pcm)
    else test.handleAudio(pcm)
  } else console.log('[cue] raw event', describeRaw(event))

  const gestures = parseGestures(event)
  if (gestures.length) routeGestures(gestures)

  const sys = event.sysEvent?.eventType
  if (sys === OsEventTypeList.SYSTEM_EXIT_EVENT || sys === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    unsubscribe()
  }
})

window.addEventListener('beforeunload', () => {
  void serial('audioControl(false)', () => bridge!.audioControl(false))
  unsubscribe()
})
