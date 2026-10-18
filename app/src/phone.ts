// Phone-side companion page (the WebView DOM). Shows a mirror of the HUD,
// the event log, counters, mic stats, and what to check on each test page.

import type { Level, Screen } from './layout'
import { onChange, phoneNextPage, phoneToggleMic, resultsText, snapshot } from './testmode'

const HELP: Record<string, string> = {
  gestures: 'Try every gesture on both temples (and the ring if you have one): tap, double tap (then cancel), swipe up, swipe down, long press and release, tap-then-hold (menu). Note which ones show up below and in which field (textEvent or sysEvent).',
  ruler: 'Swipe to change ruler. On "digits x6" and "tens marks", write down how many characters fit on line 1 before it wraps. Do the same for "wide W" and "mixed". On "glyphs", note which symbols are missing or garbled.',
  lines: 'Count how many numbered body lines are visible (8-line variant, then 12-line). Does "hdr line 2" or "foot line 2" show? Swipe on the 12-line variant: does the firmware scroll the text, and do swipe events still arrive?',
  brightness: 'Swipe up/down to step the body textColor 0-4. Note which levels you can read indoors and under bright light, and whether level 0 is invisible. The footer is at level 1 (the planned dim status line).',
  cards: 'Swipe to step through the worked card examples from 02-glasses-ux.md. Check every line fits without wrapping or clipping and the footer source line fits on one line.',
  mic: 'Hold a temple, say "Priya, Northwind, recruiter", release. If nothing happens, set PTT_MODE to tapToggle or use the menu item Talk. Play the clip below to check audio quality. With VITE_BACKEND_URL set, the clip is posted to /api/stt.',
}

const OPACITY: Record<Level, number> = { 0: 0.12, 1: 0.35, 2: 0.55, 3: 0.8, 4: 1 }

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

let onBack: () => void = () => {}

export function mountPhone(backToCue: () => void) {
  onBack = backToCue
  document.querySelector('#app')!.innerHTML = `
    <main>
      <header><h1>Cue hardware test</h1><span id="bridge" class="chip"></span></header>
      <section>
        <div class="row"><b id="page"></b><span id="variant" class="muted"></span></div>
        <div class="hud" aria-label="HUD mirror">
          <pre id="hdr" class="c hdr"></pre><pre id="body" class="c body"></pre><pre id="foot" class="c foot"></pre>
        </div>
        <p id="help" class="help"></p>
        <div class="row">
          <button id="next">Next page</button>
          <button id="mic">Start/stop mic</button>
          <button id="copy">Copy results</button>
          <button id="back">Back to Cue</button>
        </div>
      </section>
      <section>
        <h2>Gestures</h2>
        <p class="muted">tap: next page | swipe: variant | long press: record (<span id="ptt"></span>) | 2x tap: exit | menu: Talk = mic, Last brief = next page, Go quiet = reset counters, Hardware test = back to Cue</p>
        <table id="counts"></table>
      </section>
      <section>
        <h2>Mic</h2>
        <pre id="micstats" class="mono"></pre>
        <audio id="clip" controls></audio>
      </section>
      <section>
        <h2>Results (copy into the design docs)</h2>
        <textarea id="results" readonly rows="10"></textarea>
      </section>
      <section>
        <h2>Event log</h2>
        <pre id="log" class="mono log"></pre>
      </section>
    </main>`
  if (!styled) { styled = true; injectStyles() }
  $('back').onclick = () => onBack()
  $('next').onclick = phoneNextPage
  $('mic').onclick = phoneToggleMic
  $('copy').onclick = async () => {
    const ta = $<HTMLTextAreaElement>('results')
    ta.select()
    try { await navigator.clipboard.writeText(ta.value) } catch { document.execCommand?.('copy') }
  }
  if (!subscribed) { subscribed = true; onChange(schedule) }
  schedule()
}

let styled = false
let subscribed = false
let queued = false
function schedule() {
  if (queued) return
  queued = true
  requestAnimationFrame(() => { queued = false; update() })
}

function setHud(s: Screen) {
  for (const k of ['hdr', 'body', 'foot'] as const) {
    const el = $(k)
    el.textContent = s[k]
    el.style.opacity = String(OPACITY[s[`${k}Level` as 'hdrLevel']])
  }
}

function update() {
  if (!document.getElementById('micstats')) return   // Cue page is mounted
  const s = snapshot()
  $('bridge').textContent = s.bridgeStatus
  $('page').textContent = `Page ${s.pageNum}/${s.pageCount}: ${s.pageId}`
  $('variant').textContent = s.variantName
  $('help').textContent = HELP[s.pageId]
  $('ptt').textContent = s.pttMode
  setHud(s.screen)

  const rows = Object.entries(s.counts).sort()
  $('counts').innerHTML = '<tr><th>event @ field</th><th>count</th></tr>' +
    (rows.length ? rows.map(([k, n]) => `<tr><td>${k}</td><td>${n}</td></tr>`).join('')
      : '<tr><td colspan="2" class="muted">no events yet</td></tr>')

  const m = s.mic
  $('micstats').textContent = m
    ? `recording: ${m.recording}  audioControl(true): ${m.openResult}\n` +
      `frames: ${m.frames}  bytes: ${m.bytes}  last frame: ${m.lastFrameBytes} B\n` +
      `audio: ${(m.bytes / 32000).toFixed(2)} s  first frame after: ${m.firstFrameAt ? m.firstFrameAt - m.startedAt : '-'} ms\n` +
      `late frames after stop: ${m.lateFrames}  peak: ${s.peak.toFixed(2)}\n` +
      `last clip: ${s.clipInfo || '(none)'}\nSTT: ${s.micMsg}\nbackend: ${s.backend}`
    : 'mic not ready'
  const audio = $<HTMLAudioElement>('clip')
  if (s.clipUrl && audio.src !== s.clipUrl) audio.src = s.clipUrl

  const ta = $<HTMLTextAreaElement>('results')
  if (document.activeElement !== ta) ta.value = resultsText()
  $('log').textContent = s.log.map(l => `${l.t}  ${l.text}`).join('\n')
}

function injectStyles() {
  const css = `
    :root { color-scheme: dark; --bg:#1c1c1c; --card:#262626; --line:#3a3a3a; --text:#e6e6e6; --muted:#9a9a9a; --green:#3CFA44; }
    html, body { margin:0; background:var(--bg); color:var(--text);
      font:15px/1.45 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      touch-action:manipulation; -webkit-text-size-adjust:100%; overscroll-behavior:none; }
    main { max-width:640px; margin:0 auto; padding:16px; display:flex; flex-direction:column; gap:14px; }
    header { display:flex; justify-content:space-between; align-items:center; gap:8px; }
    h1 { font-size:18px; margin:0; } h2 { font-size:14px; margin:0 0 6px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); }
    section { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px; }
    .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; justify-content:space-between; }
    .chip { font-size:12px; border:1px solid var(--line); border-radius:999px; padding:2px 10px; color:var(--muted); }
    .muted { color:var(--muted); font-size:13px; }
    .help { font-size:13px; margin:8px 0; }
    .hud { position:relative; width:100%; aspect-ratio:2/1; background:#000; border-radius:8px; margin-top:8px; overflow:hidden;
      container-type:inline-size; }
    .c { position:absolute; left:0; right:0; margin:0; padding:0.7%; color:var(--green); white-space:pre-wrap; word-break:break-all;
      font:3.6cqw/4.69cqw ui-monospace, Menlo, monospace; overflow:hidden; box-sizing:border-box; }
    .hdr { top:0; height:12.15%; } .body { top:15.28%; height:49.65%; } .foot { top:87.85%; height:12.15%; }
    button { background:#333; color:var(--text); border:1px solid var(--line); border-radius:8px; padding:8px 12px; font-size:14px; }
    table { width:100%; border-collapse:collapse; font-size:13px; } td, th { text-align:left; padding:3px 4px; border-bottom:1px solid var(--line); }
    .mono { font:12px/1.4 ui-monospace, Menlo, monospace; white-space:pre-wrap; margin:0; }
    .log { max-height:300px; overflow:auto; }
    textarea { width:100%; box-sizing:border-box; background:#111; color:var(--text); border:1px solid var(--line); border-radius:8px; font:12px ui-monospace, Menlo, monospace; }
    audio { width:100%; margin-top:8px; }`
  const el = document.createElement('style')
  el.textContent = css
  document.head.appendChild(el)
}
