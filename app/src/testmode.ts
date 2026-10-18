// HARDWARE TEST MODE: answers the open hardware questions in design/README.md
// and design/02-glasses-ux.md section 8 on real G2 glasses.
//
// Gestures (all pages):
//   tap            next test page            (Mic page + tapToggle: start/stop mic)
//   swipe up/down  previous/next variant on Ruler, Lines, Brightness, Cards
//                  (Mic page: swipe down = next page, so tapToggle can leave)
//   long press     hold mode: jump to Mic page and record until release
//   double tap     stop mic, open the system exit dialog (Even review rule)
//   menu (tap-then-hold): Talk | Next test page | Reset counters
// Every event is console.logged and counted by name and envelope field.

import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { render, serial, type Level, type Screen } from './layout'
import { label, type Gesture } from './input'
import { Mic, MAX_CLIP_MS, MIN_CLIP_MS, BYTES_PER_SEC, pcmToWav, peak } from './audio'
import { BACKEND_URL, getState, postStt } from './api'

// 'hold' = long press starts, release stops (preferred, needs long press on hardware).
// 'tapToggle' = tap on the Mic page starts/stops. Flip this after the first hardware test.
export const PTT_MODE: 'hold' | 'tapToggle' = 'hold'

// Menu ids as seen by test mode. The page is created with the Cue menu
// (cue.ts MENU); main.ts maps Talk -> 1, Last brief -> 2, Go quiet -> 3.

// ---- pages ----------------------------------------------------------------

type PageId = 'gestures' | 'ruler' | 'lines' | 'brightness' | 'cards' | 'mic'
const PAGES: PageId[] = ['gestures', 'ruler', 'lines', 'brightness', 'cards', 'mic']
const TITLES: Record<PageId, string> = {
  gestures: 'GESTURES', ruler: 'RULER', lines: 'LINES', brightness: 'BRIGHTNESS', cards: 'CARDS', mic: 'MIC',
}

const RULERS: { name: string; body: string }[] = [
  { name: 'digits x6', body: '1234567890'.repeat(6) },
  { name: 'tens marks', body: '---------1---------2---------3---------4---------5---------6' },
  { name: 'wide W x60', body: 'W'.repeat(60) },
  { name: 'mixed 60', body: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWX' },
  { name: 'glyphs', body: 'safe: ━━━ ─── █ ▲ ▼ ● ○ ■ □ ★ │ ╭╮╯╰\nunsafe: · ✓ “quotes” é — emoji 🙂\nIf this whole page is blank, an unsafe glyph broke it.' },
  { name: 'prose', body: 'Both FIRST Robotics alums; she mentors. Ask about her talk on hiring freshmen for field-test tooling. Northwind is scaling autonomy field tests.' },
]

const numbered = (n: number) => Array.from({ length: n }, (_, i) => `${i + 1}  body line ${i + 1}`).join('\n')
const LINES = [
  { name: '8 lines', body: numbered(8) },
  { name: '12 lines (overflow)', body: numbered(12) },
]

// The worked examples from 02-glasses-ux.md section 6, exactly as designed.
const CARDS: { name: string; hdr: string; body: string; foot: string }[] = [
  { name: 'A card 1', hdr: '1/3 CONNECT | Priya Raman',
    body: 'Both FIRST Robotics alums; she mentors.\nAsk about her talk on hiring freshmen\nfor field-test tooling.',
    foot: 'src: northwindrobotics.com/careers' },
  { name: 'A card 2', hdr: '2/3 CONTEXT | Northwind Robotics',
    body: 'University recruiter, 3 yrs. Northwind\nis scaling autonomy field tests; blog\nsays SWE intern hiring opens Nov.',
    foot: 'src: northwindrobotics.com/blog' },
  { name: 'A card 3', hdr: '3/3 ANGLE | goal: internship',
    body: 'Pitch: your drone-map app is field\ntooling. Ask: do SWE interns include\nfreshmen? Who screens applications?',
    foot: 'tap: quiet   swipe up: back' },
  { name: 'A card 3 (cofounder)', hdr: '3/3 ANGLE | goal: cofounder',
    body: 'Not a cofounder lead. Ask: which\nNorthwind engineers left to start\ncompanies? Any intro to one?',
    foot: 'tap: quiet   swipe up: back' },
  { name: 'B org only', hdr: '1/1 CONTEXT | Helio Labs (org only)',
    body: 'Marcus not confirmed. Helio Labs is a\n4-person seed startup: open-source\nsolar forecasting, grid API in Sep.\nAsk who they are hiring first.',
    foot: 'src: heliolabs.dev/about' },
]

const VARIANTS: Partial<Record<PageId, number>> = {
  ruler: RULERS.length, lines: LINES.length, brightness: 5, cards: CARDS.length,
}

// ---- state ----------------------------------------------------------------

export interface LogLine { t: string; text: string }

const st = {
  page: 0,
  variant: { ruler: 0, lines: 0, brightness: 4, cards: 0 } as Record<string, number>,
  counts: {} as Record<string, number>,   // "click@sysEvent" -> n
  total: 0,
  last: null as Gesture | null,
  log: [] as LogLine[],
  micMsg: 'not used yet',
  clipUrl: '',
  clipInfo: '',
  peak: 0,
  pendingTalk: false,
  backend: BACKEND_URL ? 'checking...' : 'VITE_BACKEND_URL not set (stats only)',
  bridgeStatus: 'waiting for bridge...',
}

let bridge: EvenAppBridge | null = null
let mic: Mic | null = null
let micTimer: number | undefined
let autoStop: number | undefined
const listeners: (() => void)[] = []

export const onChange = (fn: () => void) => { listeners.push(fn) }
const notify = () => listeners.forEach(fn => fn())

export function log(text: string) {
  const t = new Date().toLocaleTimeString([], { hour12: false })
  st.log.unshift({ t, text })
  st.log.length = Math.min(st.log.length, 150)
  console.log(`[cue] ${text}`)
  notify()
}

export function setBridgeStatus(s: string) { st.bridgeStatus = s; notify() }

// ---- screens --------------------------------------------------------------

const pageId = () => PAGES[st.page]
const v = (p: PageId) => st.variant[p] ?? 0
const lastLine = () => st.last ? `#${st.total} ${label(st.last)}` : 'no events yet | 2x tap: exit'
const sum = (name: string) =>
  Object.entries(st.counts).filter(([k]) => k.startsWith(name + '@')).reduce((n, [, c]) => n + c, 0)

function scr(hdr: string, hdrLevel: Level, body: string, bodyLevel: Level, foot: string, footLevel: Level): Screen {
  return { hdr, hdrLevel, body, bodyLevel, foot, footLevel }
}

export function currentScreen(): Screen {
  const p = pageId()
  const title = `TEST ${st.page + 1}/${PAGES.length} ${TITLES[p]}`
  switch (p) {
    case 'gestures':
      return scr(`${title} | tap: next`, 3,
        `Last: ${st.last ? label(st.last) : '(none)'}\n` +
        `Total events: ${st.total}\n` +
        `click ${sum('click')}  2x ${sum('double_click')}  up ${sum('swipe_up')}  down ${sum('swipe_down')}\n` +
        `long ${sum('long_press')}  release ${sum('long_press_release')}  menu ${sum('menu')}\n` +
        `fg in ${sum('foreground_enter')}  fg out ${sum('foreground_exit')}`, 4,
        lastLine(), 2)
    case 'ruler':
      return scr(`${title} ${v(p) + 1}/${RULERS.length} ${RULERS[v(p)].name}`, 3, RULERS[v(p)].body, 4, lastLine(), 2)
    case 'lines':
      return scr(`${title} | hdr line 1\nhdr line 2 (hidden if 1 fits)`, 3,
        LINES[v(p)].body, 4,
        `${lastLine()}\nfoot line 2 (hidden if 1 fits)`, 2)
    case 'brightness': {
      const lvl = v(p) as Level
      return scr(`${title} | body level ${lvl}`, 3,
        `textColor ${lvl}: The quick brown fox 0123456789\n` +
        `safe glyphs: ━━━ ─── █ ▲ ▼ ● ○ ■ □ ★\n` +
        `swipe up/down: level 0-4`, lvl,
        `foot level 1 | ${lastLine()}`, 1)
    }
    case 'cards': {
      const c = CARDS[v(p)]
      return scr(c.hdr, 3, c.body, 4, c.foot, 2)
    }
    case 'mic':
      return micScreen(title)
  }
}

function micScreen(title: string): Screen {
  const s = mic?.stats
  const hint = PTT_MODE === 'hold' ? 'hold: record | tap: next' : 'tap: start/stop | swipe down: next'
  if (!s?.recording) {
    return scr(`${title} | mode: ${PTT_MODE}`, 3,
      `${PTT_MODE === 'hold' ? 'Hold a temple to record,\nrelease to stop.' : 'Tap to record, tap to stop.'} (8 s max)\n` +
      `Last: ${st.clipInfo || '(none)'}\n` +
      `STT: ${st.micMsg}`, 4,
      hint, 2)
  }
  const wall = (Date.now() - s.startedAt) / 1000
  const audioSec = s.bytes / BYTES_PER_SEC
  const span = s.firstFrameAt ? (s.lastFrameAt - s.firstFrameAt) / 1000 : 0
  const rate = span > 0 ? (s.bytes / 1024 / span).toFixed(1) : '-'
  const filled = Math.min(16, Math.round((wall * 1000 / MAX_CLIP_MS) * 16))
  return scr('● Listening', 4,
    `frames ${s.frames} | ${s.bytes} B\n` +
    `audio ${audioSec.toFixed(1)} s | wall ${wall.toFixed(1)} s\n` +
    `rate ${rate} KB/s (real time 31.3)\n` +
    `frame ${s.lastFrameBytes} B | peak ${st.peak.toFixed(2)}\n` +
    '━'.repeat(filled) + '─'.repeat(16 - filled), 3,
    PTT_MODE === 'hold' ? 'release to send' : 'tap to send', 2)
}

const show = () => { render(currentScreen()); notify() }

// ---- actions --------------------------------------------------------------

function goPage(delta: number) {
  st.page = (st.page + delta + PAGES.length) % PAGES.length
  show()
}

function goVariant(delta: number): boolean {
  const p = pageId()
  const n = VARIANTS[p]
  if (!n) return false
  st.variant[p] = (v(p) + delta + n) % n
  show()
  return true
}

async function startMic(reason: string) {
  if (!mic || mic.stats.recording) return
  st.page = PAGES.indexOf('mic')
  st.peak = 0
  log(`mic start (${reason})`)
  await mic.start()
  if (mic.stats.openResult === false) st.micMsg = 'audioControl(true) returned false: mic permission?'
  show()
  micTimer = window.setInterval(show, 1000)    // 1 s HUD updates keep BLE light while audio streams
  autoStop = window.setTimeout(() => void finishMic('8 s auto-stop'), MAX_CLIP_MS)
}

function clearMicTimers() {
  clearInterval(micTimer); clearTimeout(autoStop)
  micTimer = autoStop = undefined
}

async function finishMic(reason: string) {
  if (!mic?.stats.recording) return
  clearMicTimers()
  log(`mic stop (${reason})`)
  const clip = await mic.stop()
  const s = mic.stats
  const ms = (clip?.length ?? 0) / BYTES_PER_SEC * 1000
  const span = s.firstFrameAt ? s.lastFrameAt - s.firstFrameAt : 0
  st.clipInfo = `${(ms / 1000).toFixed(1)} s, ${s.frames} frames, ${s.bytes} B`
  log(`clip: ${st.clipInfo}; first frame after ${s.firstFrameAt ? s.firstFrameAt - s.startedAt : '-'} ms; ` +
    `frame span ${span} ms; peak ${st.peak.toFixed(2)}`)
  // Count frames that keep arriving after audioControl(false) (BLE lag).
  setTimeout(() => { log(`late frames after stop: ${mic?.stats.lateFrames ?? 0}`) }, 1500)
  if (!clip || ms < MIN_CLIP_MS) {
    st.micMsg = s.frames === 0 ? 'no audio frames arrived' : `clip under ${MIN_CLIP_MS} ms, discarded`
    show()
    return
  }
  if (st.clipUrl) URL.revokeObjectURL(st.clipUrl)
  st.clipUrl = URL.createObjectURL(pcmToWav(clip))
  if (!BACKEND_URL) { st.micMsg = 'no backend set; stats only'; show(); return }
  st.micMsg = 'posting to /api/stt...'
  show()
  const r = await postStt(clip)
  st.micMsg = r.ok
    ? `"${r.data?.transcript ?? ''}" (${r.ms} ms)`
    : `error ${r.status} ${r.error ?? ''} (${r.ms} ms)`
  log(`POST /api/stt -> ${r.status} in ${r.ms} ms: ${JSON.stringify(r.data ?? r.error)}`)
  show()
}

async function cancelMic(reason: string) {
  if (!mic?.stats.recording) return
  clearMicTimers()
  await mic.stop({ tail: false, discard: true })
  st.micMsg = `discarded (${reason})`
  log(`mic discarded (${reason})`)
  show()
}

function toggleMic(reason: string) {
  if (mic?.stats.recording) void finishMic(reason)
  else void startMic(reason)
}

// Some firmware may send the same tap in two envelopes; act once, log both.
let lastAct = { name: '', at: 0 }

export function handleGestures(gs: Gesture[]) {
  for (const g of gs) {
    const key = `${g.name}@${g.field}`
    st.counts[key] = (st.counts[key] ?? 0) + 1
    st.total++
    st.last = g
    log(`${label(g)} (eventType=${g.eventType ?? 'undefined'}${g.containerName ? `, container=${g.containerName}` : ''})`)
  }
  const g = gs[0]
  if (!g) return
  const dup = g.name === lastAct.name && g.at - lastAct.at < 80
  lastAct = { name: g.name, at: g.at }
  if (dup) { log(`(${g.name} repeated within 80 ms: not acted on twice)`); return }
  act(g)
  show()
}

function act(g: Gesture) {
  const p = pageId()
  switch (g.name) {
    case 'double_click':
      // Exit always works. Stop the mic, but do not unsubscribe: the user may cancel.
      void cancelMic('double tap')
      void serial('shutDownPageContainer(1)', () => bridge!.shutDownPageContainer(1))
      return
    case 'click':
      if (p === 'mic' && PTT_MODE === 'tapToggle') return toggleMic('tap')
      if (mic?.stats.recording) return void finishMic('tap')
      return goPage(1)
    case 'swipe_up':
      goVariant(-1)
      return
    case 'swipe_down':
      if (!goVariant(1) && p === 'mic') goPage(1)
      return
    case 'long_press':
      if (PTT_MODE === 'hold') void startMic('long press')
      return
    case 'long_press_release':
      if (PTT_MODE === 'hold') void finishMic('release')
      return
    case 'foreground_enter':
      // 02: the menu opening sends FOREGROUND_ENTER. Drop a capture in progress.
      void cancelMic('foreground enter (menu opened?)')
      return
    case 'foreground_exit':
      if (st.pendingTalk) { st.pendingTalk = false; void startMic('menu Talk, after foreground exit') }
      return
    case 'menu':
      if (g.menuItemId === 1) {
        if (mic?.stats.recording) return void finishMic('menu Talk')
        // 02: start only after the FOREGROUND_EXIT that follows the click. Fallback after 1.5 s.
        st.pendingTalk = true
        setTimeout(() => {
          if (st.pendingTalk) { st.pendingTalk = false; void startMic('menu Talk, no foreground exit in 1.5 s') }
        }, 1500)
      } else if (g.menuItemId === 2) goPage(1)
      else if (g.menuItemId === 3) { st.counts = {}; st.total = 0; st.last = null; log('counters reset') }
      return
    case 'system_exit':
    case 'abnormal_exit':
      void cancelMic(g.name)
      return
  }
}

export function handleAudio(pcm: Uint8Array) {
  if (!mic) return
  mic.onFrame(pcm)
  if (mic.stats.recording) {
    st.peak = Math.max(st.peak, peak(pcm))
    if (mic.stats.frames === 1) log(`first audio frame: ${pcm.length} B`)
    throttledNotify()
  }
}

let notifyQueued = false
function throttledNotify() {
  if (notifyQueued) return
  notifyQueued = true
  setTimeout(() => { notifyQueued = false; notify() }, 250)
}

// ---- phone page helpers -------------------------------------------------------

/** Phone-page button: same as a tap on the glasses, minus the mic toggle. */
export function phoneNextPage() { goPage(1) }
export function phoneToggleMic() { toggleMic('phone button') }

export function snapshot() {
  const p = pageId()
  const variantName =
    p === 'ruler' ? RULERS[v(p)].name : p === 'lines' ? LINES[v(p)].name :
    p === 'brightness' ? `level ${v(p)}` : p === 'cards' ? CARDS[v(p)].name : ''
  return { ...st, pageId: p, pageNum: st.page + 1, pageCount: PAGES.length, variantName,
    screen: currentScreen(), mic: mic?.stats, pttMode: PTT_MODE }
}

/** Plain-text results the tester can copy into the design docs. */
export function resultsText(): string {
  const s = mic?.stats
  const span = s?.firstFrameAt ? (s.lastFrameAt - s.firstFrameAt) / 1000 : 0
  const rows = Object.entries(st.counts).sort().map(([k, n]) => `  ${k}: ${n}`).join('\n') || '  (none)'
  return [
    `Cue hardware test, ${new Date().toISOString()}`,
    `PTT_MODE: ${PTT_MODE}`,
    `Bridge: ${st.bridgeStatus}`,
    `Events (name@field: count):`, rows,
    `Long press delivered: ${sum('long_press') > 0 ? 'YES' : 'no'}; release: ${sum('long_press_release') > 0 ? 'YES' : 'no'}`,
    `Swipe delivered: up ${sum('swipe_up')}, down ${sum('swipe_down')}`,
    `Mic last clip: ${st.clipInfo || '(none)'}; audioControl(true)=${s?.openResult}; ` +
      `rate ${span > 0 ? (s!.bytes / 1024 / span).toFixed(1) : '-'} KB/s; late frames ${s?.lateFrames ?? 0}; peak ${st.peak.toFixed(2)}`,
    `STT: ${st.micMsg}`,
    `Backend: ${st.backend}`,
  ].join('\n')
}

/** Leaving test mode: drop any capture in progress. */
export function stopTestMode() {
  void cancelMic('leaving test mode')
}

// ---- init -------------------------------------------------------------------

export function initTestMode(b: EvenAppBridge) {
  bridge = b
  mic ??= new Mic(b)
  show()
  if (BACKEND_URL) {
    void getState().then(r => {
      st.backend = `GET ${BACKEND_URL}/api/state -> ${r.status || 'network error'} in ${r.ms} ms${r.error ? ` (${r.error})` : ''}`
      log(st.backend)
    })
  }
}
