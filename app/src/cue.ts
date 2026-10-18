// The real Cue state machine (design/02-glasses-ux.md sections 4-5):
// Ready, Listening, Thinking, Card 1..N, Confirm person, Quiet, Error.
// Same 3-container layout as before; every change is a render(Screen), which
// sends in-place textContainerUpgrades (layout.ts).

import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import type { Brief, Card, Goal, Query } from '../../shared/types'
import { measureTextWrap, pxTruncate } from '@evenrealities/pretext'
import { BODY_LINES, INNER_W, render, serial, type Level, type Screen } from './layout'
import { label, type Gesture } from './input'
import { BYTES_PER_SEC, MAX_CLIP_MS, MIN_CLIP_MS, Mic, peak, type Clip } from './audio'
import { BACKEND_URL, getBrief, getState, postConfirm, postRecap, postSay, postStt, postTranscript, putGoal, type ApiResult } from './api'
import { MOCK, MOCK_TRANSCRIPT, mockBrief, mockConfirm, mockGoal, mockSlowPath } from './mock'

// Measured on hardware: long press = sysEvent 9, release = 10. See 02 "Measured on hardware".
export const PTT_MODE = 'hold' as 'hold' | 'tapToggle'

export const MENU = [
  { id: 1, name: 'Talk' },
  { id: 7, name: 'Last brief' },
  { id: 10, name: 'Text me a recap' },   // Photon: iMessage to the wearer, never to the person met
  { id: 12, name: 'Record conversation' },// consent line first, then 20 s chunks -> transcript on the brief
  { id: 8, name: 'Go quiet' },
  // Dev only (?dev=1): judges should not see it. The phone page button still opens it.
  ...(new URLSearchParams(location.search).has('dev') ? [{ id: 9, name: 'Hardware test' }] : []),
]
const MENU_GOAL: Record<number, Goal> = {
  2: 'internship', 3: 'cofounder', 4: 'learn', 5: 'teammates_sponsors', 6: 'mentorship',
}
const GOAL_LABEL: Record<Goal, string> = {
  internship: 'internship', cofounder: 'cofounder', learn: 'learn',
  teammates_sponsors: 'teammates', mentorship: 'mentorship',
}

const CARD_IDLE_MS = 25000
const FLASH_MS = 6000                     // confirmation screen after a spoken command, e.g. "★ recap texted"
const REC_CHUNK_MS = 20000                // conversation recording: upload a chunk every 20 s
const REC_MAX_MS = 15 * 60000             // and stop by itself after 15 min
const CONFIRM_IDLE_MS = 10000
const THINK_SLOW_MS = 6000
const THINK_TIMEOUT_MS = 15000
const ERROR_BACK_MS = 4000
const POLL_MS = 5000
const POLL_MAX_AGE_MS = 5 * 60_000
const MOCK_SLOW_PATH_MS = 15000

export type StateName = 'ready' | 'listening' | 'thinking' | 'card' | 'confirm' | 'quiet' | 'error' | 'consent' | 'recording'
type ErrorKind = 'stt_empty' | 'offline' | 'timeout' | 'mic' | 'failed'

export interface LogLine { t: string; text: string }

const st = {
  state: 'ready' as StateName,
  prev: 'ready' as StateName,           // where to go back to if a clip is discarded
  goal: 'internship' as Goal,
  eventName: 'LA Hacks',
  brief: null as Brief | null,
  briefIsMock: false,
  cardIndex: 0,
  confirmIndex: 0,
  heard: '',                            // "Jordan | Sentry | developer advocate"
  heardIsMock: false,
  transcript: '',
  thinkingSlow: false,
  errorKind: 'failed' as ErrorKind,
  updated: false,                       // card foot shows "★ updated" until the next flip
  quietUpdates: 0,
  angleUpdating: false,
  setupSeen: false,
  peak: 0,
  listenStart: 0,
  listenByTap: false,                   // menu Talk: no finger held, so "tap to send"
  backend: BACKEND_URL ? 'checking...' : 'VITE_BACKEND_URL not set',
  bridgeStatus: 'waiting for bridge...',
  lastNote: '',                         // why the last brief came from where it did
  flash: '',                            // short note in the quiet line, e.g. "recap texted"; clears itself
  recStart: 0, recChars: 0, recChunks: 0, // conversation recording (consented)
  log: [] as LogLine[],
}

let bridge: EvenAppBridge | null = null
let mic: Mic | null = null
let active = true                        // false while hardware test mode owns the HUD
let lookupGen = 0                        // bump to cancel an in-flight lookup
let lookupAbort: AbortController | null = null
let pendingTalk = false                  // menu Talk: start listening after the menu closes
const timers: Record<string, number | undefined> = {}
const listeners: (() => void)[] = []

export const onChange = (fn: () => void) => { listeners.push(fn) }
const notify = () => listeners.forEach(fn => fn())

export function log(text: string) {
  const t = new Date().toLocaleTimeString([], { hour12: false })
  st.log.unshift({ t, text })
  st.log.length = Math.min(st.log.length, 200)
  console.log(`[cue] ${text}`)
  notify()
}
export function setBridgeStatus(s: string) { st.bridgeStatus = s; notify() }

function setTimer(name: string, ms: number, fn: () => void) {
  clearTimeout(timers[name])
  timers[name] = window.setTimeout(() => { timers[name] = undefined; fn() }, ms)
}
function clearTimer(name: string) { clearTimeout(timers[name]); clearInterval(timers[name]); timers[name] = undefined }
const delay = (ms: number) => new Promise(r => setTimeout(r, ms))

// ---- text limits (02 section 7) ---------------------------------------------

const SAFE = new Set([...'━─█▲▼●○■□★│╭╮╯╰'])
function clean(s: string): string {
  return s
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-').replace(/·/g, '|').replace(/…/g, '...')
    .replace(/\r/g, '')
    .split('').filter(c => c === '\n' || (c >= ' ' && c <= '~') || SAFE.has(c)).join('')
}
/** One line: at most `max` chars and never wider than the container (pixel-measured). */
export function fitLine(s: string, max = 40): string {
  let t = clean(s).replace(/\n+/g, ' ').trim()
  if (t.length > max) t = t.slice(0, max - 3).trimEnd() + '...'
  return pxTruncate(t, INNER_W)
}
const wrappedLines = (t: string) => t.split('\n').reduce((n, l) => n + Math.max(1, measureTextWrap(l, INNER_W).lineCount), 0)
/** Body: at most 200 chars and at most 5 rendered lines after firmware wrapping, so it never scrolls. */
export function fitBody(s: string, max = 200, lines = BODY_LINES): string {
  let t = clean(s).trim()
  if (t.length > max) t = t.slice(0, max - 3).trimEnd() + '...'
  if (!t || wrappedLines(t) <= lines) return t
  // Drop words from the end until it fits, then mark the cut.
  let words = t.split(/(?<=\s)/)
  while (words.length > 1 && wrappedLines(words.join('').trimEnd() + '...') > lines) words = words.slice(0, -1)
  let out = words.join('').trimEnd()
  while (out.length > 1 && wrappedLines(out + '...') > lines) out = out.slice(0, -1)   // one huge word
  return out + '...'
}

// ---- screens ----------------------------------------------------------------

const scr = (hdr: string, hdrLevel: Level, body: string, bodyLevel: Level, foot: string, footLevel: Level): Screen =>
  ({ hdr: fitLine(hdr), hdrLevel, body: fitBody(body), bodyLevel, foot: fitLine(foot), footLevel })

function readyHeader(): string {
  const tail = ` | goal: ${GOAL_LABEL[st.goal]}`
  const words = st.eventName.split(/\s+/)
  while (words.length > 1 && `Cue | ${words.join(' ')}${tail}`.length > 40) words.pop()
  return `Cue | ${words.join(' ')}${tail}`
}

const personName = (b: Brief): string => {
  const c = b.match.candidates.find(c => c.personId === b.match.personId)
  return c ? c.label.split(' | ')[0] : b.query.name.replace(/\b[a-z]/g, ch => ch.toUpperCase())
}
const isOrgOnly = (b: Brief) => b.match.confidence === 'low' || (b.cards.length === 1 && b.cards[0].kind === 'context')

function cardHeader(b: Brief, i: number, c: Card): string {
  const n = `${i + 1}/${b.cards.length}${st.briefIsMock ? ' SAMPLE' : ''}`
  if (c.kind === 'context' && isOrgOnly(b)) return `${n} CONTEXT | ${b.query.org} (org only)`
  if (c.kind === 'connect') return `${n} CONNECT | ${personName(b)}`
  if (c.kind === 'context') return `${n} CONTEXT | ${b.query.org}`
  return `${n} ANGLE | ${st.angleUpdating ? 'updating...' : `goal: ${GOAL_LABEL[st.goal]}`}`
}

const BAR = 16
function heardLine(q: Query | null, text: string): string {
  if (q && (q.name || q.org)) return [q.name, q.org, q.role].filter(Boolean).join(' | ')
  return text.split(/\s*[,|]\s*/).filter(Boolean).join(' | ')
}

const ERRORS: Record<ErrorKind, string> = {
  stt_empty: "Didn't catch that.\nHold and try again.",
  offline: "Can't reach Cue's server.\nCheck the phone connection,\nthen hold to try again.",
  timeout: 'Lookup timed out.\nHold and try again.',
  mic: 'Mic is off. Allow g2-microphone\nin the Even app, then reopen Cue.',
  failed: "Lookup failed.\nHold and try again.",
}

export function currentScreen(): Screen {
  const b = st.brief
  switch (st.state) {
    case 'ready':
      if (!st.setupSeen) {
        return scr(readyHeader(), 4,
          'Read a badge, then hold a temple\nand say: name, company, role.\nCards appear here. Tap to flip.', 4,
          'hold to ask | 2x tap to exit', 2)
      }
      return scr(readyHeader(), 2, '', 2, 'hold to ask | 2x tap to exit', 2)
    case 'listening': {
      const filled = Math.min(BAR, Math.round(((Date.now() - st.listenStart) / MAX_CLIP_MS) * BAR))
      // The first frame lands ~450 ms after the press; words spoken before it are lost.
      const open = !!mic?.stats.firstFrameAt
      return scr(open ? '● Listening' : '○ Mic opening...', 4,
        `${open ? 'Say' : 'Wait for ●, then say'}: name, company, role\nor what they said, or your goal\n${'━'.repeat(filled)}${'─'.repeat(BAR - filled)}`, 3,
        PTT_MODE === 'hold' && !st.listenByTap ? 'release to send' : 'tap to send', 2)
    }
    case 'thinking': {
      const heard = st.heard ? `Heard: ${st.heard}${st.heardIsMock ? ' (sample)' : ''}\n\n■ heard  □ cards` : '□ heard  □ cards'
      return scr('Working on it...', 3, heard, 4, st.thinkingSlow ? 'still working...' : '2x tap to exit', 2)
    }
    case 'card': {
      if (!b || !b.cards.length) return scr('Cue | problem', 3, 'No cards in this brief.', 4, 'hold to ask', 2)
      const i = Math.min(st.cardIndex, b.cards.length - 1)
      const c = b.cards[i]
      const src = c.source ? `src: ${c.source}` : 'tap: quiet   swipe up: back'
      return scr(cardHeader(b, i, c), 3, c.body, 4, st.updated ? `★ updated | ${src}` : src, 2)
    }
    case 'confirm': {
      if (!b) return scr('Cue | problem', 3, '', 4, '', 2)
      const opts = [...b.match.candidates.slice(0, 3).map(c => c.label), 'Neither (company only)']
      const body = opts.map((o, i) => `${i === st.confirmIndex ? '>' : ' '} ${fitLine(o, 36)}`).join('\n')
      return scr(`Which ${b.query.name}?`, 4, body, 4, 'swipe: move | tap: pick', 2)
    }
    case 'quiet': {
      // A flash ("★ note saved, recap texted", "coach is on it") is a readable two-line body for a
      // few seconds; the dim footer alone was invisible on hardware.
      if (st.flash) return scr('', 2, st.flash, 4, b ? `cue | ${personName(b)} | hold to ask` : 'cue | hold to ask', 2)
      const who = st.quietUpdates ? `${st.quietUpdates} update${st.quietUpdates > 1 ? 's' : ''}` : b ? personName(b) : ''
      return scr('', 2, '', 2, who ? `cue | ${who} | hold to ask` : 'cue | hold to ask', 2)
    }
    case 'consent':
      return scr('Before recording', 4, 'Ask them:\n"OK if my glasses take notes?"\n\nTap once they say yes.', 4, 'tap: start | swipe up: cancel', 2)
    case 'recording': {
      const s = Math.floor((Date.now() - st.recStart) / 1000)
      const t = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
      return scr(`● Recording ${t}`, 4, `Taking notes, with consent.\n~${Math.round(st.recChars / 6)} words saved so far\n\ntap to stop`, 3, b ? `cue | ${personName(b)}` : 'cue', 2)
    }
    case 'error':
      return scr('Cue | problem', 3, ERRORS[st.errorKind], 4, 'hold to retry | 2x tap to exit', 2)
  }
}

function show() {
  if (active) render(currentScreen())
  notify()
}

// ---- persistence (02 "Background and resume") ---------------------------------

const KEY = 'cue.state.v1'
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify({
      brief: st.brief, briefIsMock: st.briefIsMock, cardIndex: st.cardIndex, goal: st.goal,
    }))
    if (st.setupSeen) localStorage.setItem('cue.setupSeen', '1')
  } catch { /* storage unavailable */ }
}
function restore() {
  try {
    st.setupSeen = localStorage.getItem('cue.setupSeen') === '1'
    const raw = localStorage.getItem(KEY)
    if (!raw) return
    const s = JSON.parse(raw)
    if (s.goal in GOAL_LABEL) st.goal = s.goal
    const age = Date.now() - Date.parse(s.brief?.createdAt)
    if (s.brief?.cards && age < 2 * 3600_000) {      // rehearsal briefs expire after 2 h
      st.brief = s.brief; st.briefIsMock = !!s.briefIsMock; st.cardIndex = s.cardIndex ?? 0
      st.state = 'quiet'       // Listening/Thinking/Card all restore as Quiet
    }
  } catch { /* corrupt or unavailable */ }
}

// ---- transitions --------------------------------------------------------------

function go(next: StateName) {
  if (next !== st.state) log(`state ${st.state} -> ${next}`)
  if (st.state === 'listening' && next !== 'listening') { clearTimer('bar'); clearTimer('autoStop'); clearTimer('noFrame') }
  if (next !== 'thinking') { clearTimer('thinkSlow'); clearTimer('thinkTimeout'); st.thinkingSlow = false }
  if (next !== 'card') clearTimer('cardIdle')
  if (next !== 'confirm') clearTimer('confirmIdle')
  if (next !== 'error') clearTimer('errorBack')
  if (next !== 'recording') { clearTimer('recChunk'); clearTimer('recTick') }
  if (next !== 'quiet' && next !== 'listening') st.quietUpdates = 0
  st.state = next
  if (next === 'card') armCardIdle()
  if (next === 'confirm') setTimer('confirmIdle', CONFIRM_IDLE_MS, () => { log('confirm: 10 s idle -> Neither'); void pick(null) })
  save()
  show()
}

function armCardIdle() {
  setTimer('cardIdle', CARD_IDLE_MS, () => { if (st.state === 'card') { log('card: 25 s idle -> quiet'); go('quiet') } })
}

function fail(kind: ErrorKind, why: string) {
  log(`error ${kind}: ${why}`)
  st.errorKind = kind
  go('error')
  if (kind !== 'mic') setTimer('errorBack', ERROR_BACK_MS, () => { if (st.state === 'error') go('ready') })
}

function openBrief(card = 0) {
  if (!st.brief) return false
  st.cardIndex = Math.min(card, st.brief.cards.length - 1)
  st.updated = false
  go('card')
  return true
}

function showBrief(b: Brief, isMock: boolean) {
  st.brief = b
  st.briefIsMock = isMock
  st.cardIndex = 0
  st.confirmIndex = 0
  st.updated = false
  st.angleUpdating = false
  log(`brief ${b.id} v${b.version} ${b.match.confidence} cards=${b.cards.map(c => c.kind).join(',')}${isMock ? ' (MOCK)' : ''}`)
  if (b.match.confidence === 'medium' && b.match.candidates.length) go('confirm')
  // Decision gate (agents/decision-gate.md): a real person with nothing here for the wearer's goal
  // gets one quiet line, not three cards. The cards stay one menu tap away (Last brief).
  else if (b.decision && b.decision.goalFit < 0.5 && b.match.confidence !== 'low') {
    log(`decision: goal fit ${b.decision.goalFit.toFixed(2)} < 0.5 -> quiet line`)
    flash(`${personName(b)}: nothing for your goal`)
  }
  else go('card')
  if (isMock && b.slowPath.status === 'running') {
    const id = b.id
    setTimer('mockSlow', MOCK_SLOW_PATH_MS, () => {
      if (st.brief?.id === id) applyUpdate(mockSlowPath(st.brief), 'mock slow path')
    })
  }
}

/** A newer version of the open brief (slow path, confirm, goal). Never jumps cards. */
function applyUpdate(b: Brief, why: string) {
  if (!st.brief || b.id !== st.brief.id || b.version <= st.brief.version) return
  const changed = JSON.stringify(b.cards) !== JSON.stringify(st.brief.cards)
  st.brief = b
  st.cardIndex = Math.min(st.cardIndex, b.cards.length - 1)
  log(`brief ${b.id} -> v${b.version} (${why})${changed ? '' : ' no card change'}`)
  if (changed) {
    if (st.state === 'card') st.updated = true
    else if (st.state === 'quiet') st.quietUpdates++
  }
  save()
  show()
}

// ---- listening ----------------------------------------------------------------

async function startListening(reason: string) {
  if (st.state === 'listening') return
  if (!mic) { log(`listen (${reason}) ignored: no bridge/mic`); return }
  cancelLookup()
  st.prev = st.state === 'thinking' || st.state === 'error' ? 'ready' : st.state
  st.setupSeen = true
  st.peak = 0
  st.listenStart = Date.now()
  st.listenByTap = reason.startsWith('menu')
  log(`listen start (${reason})`)
  go('listening')
  timers.bar = window.setInterval(() => { if (st.state === 'listening') show() }, 1000)   // 1 s: keep BLE light
  setTimer('autoStop', MAX_CLIP_MS, () => void finishListening(`${MAX_CLIP_MS / 1000} s auto-stop`))
  if (MOCK !== 'on') {
    setTimer('noFrame', 2000, () => {
      if (st.state !== 'listening' || mic?.stats.frames) return
      clearTimer('autoStop')
      void mic?.stop({ tail: false, discard: true }).then(() => fail('mic', 'no audio frames after 2 s'))
    })
  }
  await mic.start()
  // undefined = the bridge call timed out (serial()), which is a failure too.
  if (mic.stats.openResult !== true && (st.state as StateName) === 'listening') {
    clearTimer('autoStop'); clearTimer('noFrame')
    await mic.stop({ tail: false, discard: true })
    fail('mic', `audioControl(true) returned ${mic.stats.openResult}`)
  }
}

async function finishListening(reason: string) {
  if (st.state !== 'listening' || !mic?.stats.recording) return
  clearTimer('autoStop')
  log(`listen stop (${reason})`)
  const clip = await mic.stop()
  if (st.state !== 'listening') return      // cancelled during the tail
  const s = mic.stats
  const ms = ((clip?.length ?? 0) / BYTES_PER_SEC) * 1000
  log(`clip ${(ms / 1000).toFixed(2)} s, ${s.frames} frames, first frame after ${s.firstFrameAt ? s.firstFrameAt - s.startedAt : '-'} ms, peak ${st.peak.toFixed(2)}${st.peak >= 0.99 ? ' (clipping?)' : ''}`)
  if (!clip || ms < MIN_CLIP_MS) {
    if (MOCK === 'on' && s.frames === 0) { log('no audio frames; MOCK=on so continuing with the sample'); return void lookup({}) }
    log(`clip under ${MIN_CLIP_MS} ms: discarded`)
    return go(st.prev)
  }
  void lookup({ clip })
}

async function cancelListening(reason: string) {
  if (st.state !== 'listening') return
  clearTimer('autoStop')
  await mic?.stop({ tail: false, discard: true })
  log(`listen cancelled (${reason})`)
  if (st.state === 'listening') go(st.prev)
}

// ---- lookup: POST /api/stt, then POST /api/briefs/text --------------------------

function cancelLookup() {
  lookupGen++
  lookupAbort?.abort()
  lookupAbort = null
}

const apiWhy = (r: ApiResult) => `${r.status || 'network'} ${r.error ?? ''}${r.message ? `: ${r.message}` : ''} (${r.ms} ms)`

/** Run a lookup from a clip, typed text, or nothing (mock). */
export async function lookup(src: { clip?: Clip; text?: string }) {
  cancelLookup()
  const gen = lookupGen
  const ctrl = new AbortController()
  lookupAbort = ctrl
  const stale = () => gen !== lookupGen
  st.heard = ''; st.heardIsMock = false; st.thinkingSlow = false
  go('thinking')
  setTimer('thinkSlow', THINK_SLOW_MS, () => { if (!stale() && st.state === 'thinking') { st.thinkingSlow = true; show() } })
  setTimer('thinkTimeout', THINK_TIMEOUT_MS, () => {
    if (stale() || st.state !== 'thinking') return
    cancelLookup()
    fail('timeout', '15 s')
  })

  // 1. transcript
  let text = src.text?.trim() ?? ''
  let query: Query | null = null
  let mockText = false
  if (!text) {
    if (MOCK === 'on' || !BACKEND_URL || !src.clip) {
      await delay(500)
      if (stale()) return
      text = MOCK_TRANSCRIPT; mockText = true
      log(`STT skipped (${MOCK === 'on' ? 'MOCK=on' : !BACKEND_URL ? 'no backend' : 'no clip'}): using sample transcript`)
    } else {
      const r = await postStt(src.clip, ctrl.signal)
      if (stale()) return
      log(`POST /api/stt -> ${r.ok ? `${r.status} "${r.data?.transcript}" (${r.ms} ms)` : apiWhy(r)}`)
      if (r.ok && r.data?.transcript) { text = r.data.transcript; query = r.data.query }
      else if (r.error === 'STT_EMPTY') return fail('stt_empty', 'STT_EMPTY')
      else if (MOCK === 'auto' && (r.error === 'STT_FAILED' || r.status === 0)) {
        text = MOCK_TRANSCRIPT; mockText = true
        log('STT unavailable: MOCK auto fallback to sample transcript')
      } else return fail(r.status === 0 ? 'offline' : 'stt_empty', apiWhy(r))
    }
  }
  st.transcript = text
  st.heard = heardLine(query, text)
  st.heardIsMock = mockText
  show()

  // 2. brief
  let brief: Brief | null = null
  let isMock = false
  if (MOCK === 'on' || !BACKEND_URL) {
    await delay(900)
    if (stale()) return
    brief = mockBrief(text, st.goal); isMock = true
    st.lastNote = MOCK === 'on' ? 'MOCK=on' : 'no backend URL'
  } else {
    // One call: the backend decides whether this was a lookup, a correction, a note about the
    // conversation (debrief -> recap texted), a goal, "text me", or nothing, and does it.
    const r = await postSay(text, st.brief?.id, ctrl.signal)
    if (stale()) return
    log(`POST /api/say -> ${r.ok ? `${r.status} ${r.data?.intent ?? '?'} ${r.data?.intentConfidence?.toFixed(2) ?? ''} ${r.data?.intentSource ?? ''}${r.fallback ? ' (template fallback)' : ''} (${r.ms} ms)` : apiWhy(r)}`)
    if (r.notes) log(`notes: ${r.notes}`)
    if (r.ok && r.data) {
      const d = r.data
      lookupAbort = null
      switch (d.intent) {
        case 'lookup':
        case 'correction':
          if (!d.brief) return fail('failed', 'no brief in the response')
          st.lastNote = `backend${r.fallback ? ' template fallback' : ''} (${r.ms} ms)`
          return showBrief(d.brief, false)
        case 'debrief':
          if (d.brief && st.brief?.id === d.brief.id) { st.brief = d.brief; save() }
          return flash(d.recap?.sent ? '★ note saved, recap texted' : 'note saved, not texted')
        case 'goal': {
          if (d.goal) { st.goal = d.goal; save() }
          if (d.brief) {
            st.brief = d.brief; st.briefIsMock = false
            const i = d.brief.cards.findIndex(c => c.kind === 'angle')
            if (i >= 0) { openBrief(i); st.updated = true; show(); return }
          }
          return flash(`goal: ${d.goal ? GOAL_LABEL[d.goal] : '?'}`)
        }
        case 'recap':
          return flash(d.recap?.sent ? '★ recap texted' : `recap: ${d.recap && !d.recap.sent ? d.recap.reason : 'not sent'}`)
        case 'quiet':
          return go(st.brief ? 'quiet' : 'ready')
        default:
          return flash(d.say ?? "didn't catch that")
      }
    }
    if (MOCK === 'auto' && (r.status === 0 || r.status >= 500 || r.error === 'NO_EVENT')) {
      brief = mockBrief(text, st.goal); isMock = true
      st.lastNote = `MOCK auto: backend ${apiWhy(r)}`
      log(st.lastNote)
    } else return fail(r.status === 0 ? 'offline' : 'failed', apiWhy(r))
  }
  if (stale()) return
  lookupAbort = null
  showBrief(brief, isMock)
}

// ---- confirm person -------------------------------------------------------------

async function pick(personId: string | null) {
  const b = st.brief
  if (!b || st.state !== 'confirm') return
  log(`confirm: ${personId ?? 'Neither'}`)
  const top = personId !== null && personId === b.match.candidates[0]?.personId
  if (st.briefIsMock) {
    if (!top) {
      st.heard = b.match.candidates.find(c => c.personId === personId)?.label ?? `${b.query.org} (company only)`
      st.heardIsMock = true
      cancelLookup()
      const gen = lookupGen
      go('thinking'); await delay(700)
      if (gen !== lookupGen || (st.state as StateName) !== 'thinking') return
    }
    st.brief = mockConfirm(b, personId)
    return openBrief(0)
  }
  if (top) {
    // Cards were already written for the top candidate: show them now, confirm in the background.
    st.brief = { ...b, match: { ...b.match, confidence: 'high' } }
    openBrief(0)
    const r = await postConfirm(b.id, personId)
    log(`POST confirm -> ${r.ok ? r.status : apiWhy(r)}`)
    if (r.ok && r.data?.brief) applyUpdate(r.data.brief, 'confirm')
    return
  }
  cancelLookup()
  const gen = lookupGen
  st.heard = b.match.candidates.find(c => c.personId === personId)?.label ?? `${b.query.org} (company only)`
  st.heardIsMock = false
  go('thinking')
  setTimer('thinkTimeout', THINK_TIMEOUT_MS, () => { if (gen === lookupGen && st.state === 'thinking') { cancelLookup(); fail('timeout', 'confirm 15 s') } })
  const r = await postConfirm(b.id, personId)
  if (gen !== lookupGen) return
  log(`POST confirm -> ${r.ok ? r.status : apiWhy(r)}`)
  if (r.ok && r.data?.brief) { st.brief = r.data.brief; openBrief(0) }
  else fail(r.status === 0 ? 'offline' : 'failed', apiWhy(r))
}

// ---- goal ----------------------------------------------------------------------

async function setGoal(goal: Goal) {
  if (goal === st.goal && !st.brief) return
  const prevGoal = st.goal
  st.goal = goal
  log(`goal -> ${goal}`)
  const b = st.brief
  const angleAt = b ? b.cards.findIndex(c => c.kind === 'angle') : -1
  const hasAngle = angleAt >= 0
  st.angleUpdating = hasAngle
  // Show the card that is changing (demo beat: switch goal, watch card 3 rewrite).
  if (hasAngle && ['ready', 'quiet', 'card'].includes(st.state)) { st.cardIndex = angleAt; st.updated = false; go('card') }
  save(); show()
  if (b && st.briefIsMock) {
    await delay(700)
    st.angleUpdating = false
    if (st.brief?.id === b.id) applyUpdate(mockGoal(st.brief, goal), 'goal')
    else show()
    return
  }
  if (!BACKEND_URL) { st.angleUpdating = false; show(); return }
  const r = await putGoal(goal, hasAngle ? b!.id : undefined)
  log(`PUT /api/goal -> ${r.ok ? `${r.status}${r.fallback ? ' (template fallback)' : ''} (${r.ms} ms)` : apiWhy(r)}`)
  st.angleUpdating = false
  if (r.ok && r.data?.brief) applyUpdate(r.data.brief, 'goal')
  else if (!r.ok) { st.goal = prevGoal; log(`goal change failed: back to ${prevGoal}`); save() }
  show()
}

// ---- polling (A9) ----------------------------------------------------------------

let polling = false
async function poll() {
  if (polling) return
  polling = true
  try { await pollOnce() } finally { polling = false }
}
async function pollOnce() {
  const b = st.brief
  if (!active || !b || st.briefIsMock || !BACKEND_URL) return
  if (!['card', 'quiet', 'confirm'].includes(st.state)) return
  if (b.slowPath.status === 'done' || b.slowPath.status === 'failed') return
  if (!(Date.now() - Date.parse(b.createdAt) <= POLL_MAX_AGE_MS)) return     // NaN counts as expired
  const r = await getBrief(b.id, b.version)
  if (r.ok && r.status === 200 && r.data?.brief) applyUpdate(r.data.brief, 'poll')
  else if (!r.ok) console.log('[cue] poll', apiWhy(r))
}

// ---- gestures ------------------------------------------------------------------

let lastAct = { name: '', at: 0 }

export function handleGestures(gs: Gesture[]) {
  for (const g of gs) log(`${label(g)} (eventType=${g.eventType ?? 'undefined'}${g.containerName ? `, ${g.containerName}` : ''})`)
  const g = gs[0]
  if (!g) return
  // Some firmware may send the same gesture in two envelopes; act once.
  const dup = g.name === lastAct.name && g.at - lastAct.at < 80
  lastAct = { name: g.name, at: g.at }
  if (dup) return
  act(g)
}

/** For the phone page buttons. */
export function inject(name: Gesture['name'], menuItemId?: number) {
  handleGestures([{ name, field: 'textEvent', menuItemId, at: Date.now() }])
}

let onTestMode: (() => void) | null = null
export function onHardwareTest(fn: () => void) { onTestMode = fn }

function act(g: Gesture) {
  const s = st.state
  if (s === 'card') armCardIdle()
  switch (g.name) {
    case 'double_click':
      void cancelListening('double tap')
      void serial('shutDownPageContainer(1)', () => bridge!.shutDownPageContainer(1))
      return
    case 'long_press':
      if (st.state === 'recording' || st.state === 'consent') return   // recording owns the mic
      if (PTT_MODE === 'hold') void startListening('long press')
      return
    case 'long_press_release':
      if (PTT_MODE === 'hold') void finishListening('release')
      return
    case 'click':
      return onTap()
    case 'swipe_down':
    case 'swipe_up':
      return onSwipe(g.name === 'swipe_down' ? 1 : -1)
    case 'foreground_enter':
      // The menu opening sends this too: never clear state; only drop a capture in progress.
      void cancelListening('foreground enter (menu opened?)')
      return
    case 'foreground_exit':
      if (pendingTalk) { pendingTalk = false; void startListening('menu Talk') }
      return
    case 'menu':
      return onMenu(g.menuItemId ?? 0)
    case 'system_exit':
    case 'abnormal_exit':
      void cancelListening(g.name)
      cancelLookup()
      return
  }
}

function onTap() {
  switch (st.state) {
    case 'ready': case 'quiet': case 'error':
      if (PTT_MODE === 'tapToggle') return void startListening('tap')
      if (st.brief) openBrief(0)
      return
    case 'listening':
      return void finishListening('tap')
    case 'thinking':
      return
    case 'consent':
      return void startRecording()
    case 'recording':
      return void stopRecording('tap')
    case 'card': {
      const n = st.brief?.cards.length ?? 0
      if (st.cardIndex + 1 >= n) return go('quiet')
      st.cardIndex++; st.updated = false
      return go('card')
    }
    case 'confirm': {
      const b = st.brief!
      const opts = b.match.candidates.slice(0, 3)
      return void pick(st.confirmIndex < opts.length ? opts[st.confirmIndex].personId : null)
    }
  }
}

function onSwipe(dir: 1 | -1) {
  switch (st.state) {
    case 'consent':
      return go(st.brief ? 'quiet' : 'ready')
    case 'recording':
      return
    case 'ready': case 'quiet':
      if (st.brief) openBrief(0)
      return
    case 'card': {
      const n = st.brief?.cards.length ?? 0
      const next = st.cardIndex + dir
      if (next >= n) return go('quiet')
      if (next < 0) return
      st.cardIndex = next; st.updated = false
      return go('card')
    }
    case 'confirm': {
      const n = Math.min(3, st.brief!.match.candidates.length) + 1
      st.confirmIndex = (st.confirmIndex + dir + n) % n
      setTimer('confirmIdle', CONFIRM_IDLE_MS, () => void pick(null))
      return show()
    }
  }
}

function onMenu(id: number) {
  if (MENU_GOAL[id]) return void setGoal(MENU_GOAL[id])
  switch (id) {
    case 1:
      if (st.state === 'listening') return void finishListening('menu Talk')
      return armMenuListen()
    case 7:
      if (!openBrief(0)) log('menu Last brief: no brief yet')
      return
    case 8:
      if (st.state === 'listening') void cancelListening('menu Go quiet')
      cancelLookup()
      return go('quiet')
    case 9:
      return onTestMode?.()
    case 10:
      return void sendRecap()
    case 12:
      if (st.state === 'recording') return void stopRecording('menu')
      if (!st.brief) return flash('look someone up first')
      if (st.briefIsMock) return flash('sample brief: no recording')
      return go('consent')
  }
}

// ---- conversation recording (consented) ------------------------------------------
// The HUD shows the consent line first; a tap starts. Audio goes to the backend in 20 s chunks and
// comes back as a running transcript on the brief (feeds the CREAO follow-up and coach agents).
// Nothing is kept on the glasses or the phone.

async function startRecording() {
  const b = st.brief
  if (!mic || !b) return flash('no mic or brief')
  cancelLookup()
  st.recStart = Date.now(); st.recChars = 0; st.recChunks = 0
  go('recording')
  await mic.start()
  if (mic.stats.openResult !== true || (st.state as StateName) !== 'recording') {
    await mic.stop({ tail: false, discard: true })
    if ((st.state as StateName) === 'recording') fail('mic', `audioControl(true) returned ${mic.stats.openResult}`)
    return
  }
  timers.recTick = window.setInterval(() => { if (st.state === 'recording') show() }, 1000)
  setTimer('recChunk', REC_CHUNK_MS, recChunkTick)
  log('recording started (consent given on the HUD)')
}

function recChunkTick() {
  if (st.state !== 'recording' || !mic) return
  const clip = mic.drain()
  if (clip.length >= BYTES_PER_SEC) void uploadChunk(clip)
  if (Date.now() - st.recStart >= REC_MAX_MS) return void stopRecording('15 min cap')
  setTimer('recChunk', REC_CHUNK_MS, recChunkTick)
}

async function uploadChunk(clip: Clip) {
  const b = st.brief
  if (!b) return
  st.recChunks++
  const r = await postTranscript(b.id, clip)
  log(`POST transcript chunk ${clip.length} B -> ${r.ok ? `${r.status} +${r.data?.added ?? 0} chars (${r.ms} ms)` : apiWhy(r)}`)
  if (r.ok && r.data) { st.recChars = r.data.chars; if (st.state === 'recording') show() }
}

async function stopRecording(reason: string) {
  if (st.state !== 'recording' || !mic) return
  log(`recording stop (${reason})`)
  clearTimer('recChunk'); clearTimer('recTick')
  const rest = await mic.stop({ tail: false })
  if (rest && rest.length >= BYTES_PER_SEC / 2) await uploadChunk(rest)
  flash(st.recChars ? `notes saved (~${Math.round(st.recChars / 6)} words)` : 'no speech heard')
}

/** Menu Talk: start only after the FOREGROUND_EXIT that follows the click (menu closing), 1.5 s fallback. */
function armMenuListen() {
  pendingTalk = true
  setTimeout(() => { if (pendingTalk) { pendingTalk = false; void startListening('menu Talk (no fg exit)') } }, 1500)
}

/** Show a short note in the quiet line for a few seconds (goes quiet first if needed). */
function flash(text: string) {
  st.flash = text
  if (st.state !== 'quiet') go('quiet'); else show()
  setTimer('flash', FLASH_MS, () => { st.flash = ''; show() })
}

/** Menu "Text me a recap": the backend texts the wearer over Photon. Never the person met. */
async function sendRecap() {
  if (!st.brief) return flash('no brief to recap yet')
  if (st.briefIsMock) return flash('sample brief, not sent')
  flash('sending recap...')
  const r = await postRecap(st.brief.id)
  if (r.ok && r.data?.sent) {
    log(`recap texted (${r.data.chars} chars)`)
    return flash('★ recap texted')
  }
  const why = r.data && !r.data.sent ? r.data.reason : r.error ?? 'unknown'
  log(`recap not sent: ${why}`)
  if (r.status === 0) return flash('recap: backend offline')
  flash(r.data && !r.data.sent && !r.data.configured ? 'recap: Photon not set up' : 'recap not sent')
}

export function handleAudio(pcm: Uint8Array) {
  if (!mic) return
  const first = mic.stats.recording && !mic.stats.firstFrameAt
  mic.onFrame(pcm)
  if (mic.stats.recording) st.peak = Math.max(st.peak, peak(pcm))
  if (first && mic.stats.firstFrameAt && st.state === 'listening') show()     // "○ Mic opening" -> "● Listening"
}

// ---- lifecycle -----------------------------------------------------------------

/** Hardware test mode takes over the HUD. */
export function suspend() {
  active = false
  void cancelListening('hardware test mode')
  if (st.state === 'recording') { clearTimer('recChunk'); clearTimer('recTick'); void mic?.stop({ tail: false, discard: true }) }
  cancelLookup()
  if (['thinking', 'listening', 'card', 'confirm', 'consent', 'recording'].includes(st.state)) st.state = st.brief ? 'quiet' : 'ready'
  ;['cardIdle', 'confirmIdle', 'thinkSlow', 'thinkTimeout', 'errorBack', 'bar', 'autoStop', 'noFrame', 'flash'].forEach(clearTimer)
}
export function resume() { active = true; show() }
export const isActive = () => active

/** Call once at page load (before the bridge, so the phone page works in a plain browser). */
export function initCue() {
  restore()
  log(`Cue start | PTT_MODE ${PTT_MODE} | MOCK ${MOCK} | backend ${BACKEND_URL || '(none)'}`)
  window.setInterval(() => void poll(), POLL_MS)
  if (BACKEND_URL) {
    void getState().then(r => {
      st.backend = `GET /api/state -> ${r.status || 'network error'} in ${r.ms} ms${r.error ? ` (${r.error})` : ''}`
      log(st.backend)
      if (r.ok && r.data) {
        st.goal = r.data.goal ?? st.goal
        if (r.data.event?.name) st.eventName = r.data.event.name
        show()
      }
    })
  }
  show()
}

export function attachBridge(b: EvenAppBridge) {
  bridge = b
  mic = new Mic(b)
}

export function snapshot() {
  return { ...st, screen: currentScreen(), pttMode: PTT_MODE, mock: MOCK, backendUrl: BACKEND_URL,
    recording: !!mic?.stats.recording, micSeconds: mic?.seconds ?? 0, hasMic: !!mic }
}
