// Phone-side page for the real Cue flow (the WebView DOM): current state, HUD
// mirror, last transcript, the open brief's cards as text, debug controls that
// inject gestures, a typed lookup, and the event log.

import type { Level, Screen } from './layout'
import { inject, lookup, onChange, snapshot } from './cue'

const OPACITY: Record<Level, number> = { 0: 0.12, 1: 0.35, 2: 0.55, 3: 0.8, 4: 1 }
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

let onTest: () => void = () => {}

export function mountCuePhone(openTest: () => void) {
  onTest = openTest
  document.querySelector('#app')!.innerHTML = `
    <main class="cue">
      <header><h1>Cue</h1><span id="cbridge" class="chip"></span></header>
      <section>
        <div class="row"><b id="cstate"></b><span id="cmode" class="muted"></span></div>
        <div class="hud" aria-label="HUD mirror">
          <pre id="chdr" class="c hdr"></pre><pre id="cbody" class="c body"></pre><pre id="cfoot" class="c foot"></pre>
        </div>
        <p class="muted">Glasses: hold = ask, release = send | tap / swipe = flip cards | 2x tap = exit | tap-then-hold = menu</p>
        <div class="row btns">
          <button data-g="long_press">Hold</button><button data-g="long_press_release">Release</button>
          <button data-g="click">Tap</button><button data-g="swipe_up">Swipe up</button><button data-g="swipe_down">Swipe down</button>
        </div>
        <form id="cform" class="row">
          <input id="ctext" placeholder="Typed lookup: Jordan, Sentry, developer advocate" autocomplete="off" />
          <button type="submit">Look up</button>
        </form>
        <div class="row btns">
          <button data-m="2">Goal: internship</button><button data-m="3">cofounder</button><button data-m="10">Text me a recap</button><button data-m="11">Debrief</button><button data-m="8">Go quiet</button>
          <button id="ctest">Hardware test mode</button>
        </div>
      </section>
      <section>
        <h2>Last lookup</h2>
        <pre id="cinfo" class="mono"></pre>
      </section>
      <section>
        <h2>Cards</h2>
        <div id="ccards"></div>
      </section>
      <section>
        <h2>Event log</h2>
        <pre id="clog" class="mono log"></pre>
      </section>
    </main>`
  injectStyles()
  document.querySelectorAll<HTMLButtonElement>('[data-g]').forEach(b => {
    b.onclick = () => inject(b.dataset.g as Parameters<typeof inject>[0])
  })
  document.querySelectorAll<HTMLButtonElement>('[data-m]').forEach(b => {
    b.onclick = () => inject('menu', Number(b.dataset.m))
  })
  $('ctest')!.onclick = () => onTest()
  $<HTMLFormElement>('cform')!.onsubmit = e => {
    e.preventDefault()
    const t = $<HTMLInputElement>('ctext')!.value.trim()
    void lookup({ text: t || 'Jordan, Sentry, developer advocate' })
  }
  onChange(schedule)
  schedule()
}

let queued = false
function schedule() {
  if (queued) return
  queued = true
  requestAnimationFrame(() => { queued = false; update() })
}

function setHud(s: Screen) {
  for (const k of ['hdr', 'body', 'foot'] as const) {
    const el = $(`c${k}`)!
    el.textContent = s[k]
    el.style.opacity = String(OPACITY[s[`${k}Level` as 'hdrLevel']])
  }
}

function update() {
  if (!$('cstate')) return       // hardware test page is mounted
  const s = snapshot()
  $('cbridge')!.textContent = s.bridgeStatus
  $('cstate')!.textContent = `State: ${s.state.toUpperCase()}${s.state === 'card' && s.brief ? ` ${s.cardIndex + 1}/${s.brief.cards.length}` : ''}`
  $('cmode')!.textContent = `PTT ${s.pttMode} | MOCK ${s.mock}${s.recording ? ` | rec ${s.micSeconds.toFixed(1)} s peak ${s.peak.toFixed(2)}` : ''}`
  setHud(s.screen)
  const b = s.brief
  $('cinfo')!.textContent =
    `transcript: ${s.transcript || '(none)'}${s.heardIsMock ? '  [sample]' : ''}\n` +
    `goal: ${s.goal} | event: ${s.eventName}\n` +
    `backend: ${s.backendUrl || '(none)'} | ${s.backend}\n` +
    (b ? `brief: ${b.id} v${b.version} | match ${b.match.confidence} | slow path ${b.slowPath.status}${s.briefIsMock ? ' | MOCK' : ''}\n` : 'brief: (none)\n') +
    `source: ${s.lastNote || '-'}`
  $('ccards')!.innerHTML = b
    ? b.cards.map((c, i) => `<div class="card${s.state === 'card' && i === s.cardIndex ? ' on' : ''}">` +
        `<div class="k">${i + 1}/${b.cards.length} ${esc(c.kind.toUpperCase())}</div>` +
        `<pre class="mono">${esc(c.body)}</pre><div class="muted">src: ${esc(c.source ?? '(none)')}</div></div>`).join('') +
      (b.match.candidates.length ? `<div class="muted">candidates: ${b.match.candidates.map(c => esc(c.label)).join(' / ')}</div>` : '')
    : '<p class="muted">No brief yet. Hold a temple (or press Hold then Release, or use the typed lookup).</p>'
  $('clog')!.textContent = s.log.map(l => `${l.t}  ${l.text}`).join('\n')
}

let styled = false
function injectStyles() {
  if (styled) return
  styled = true
  const css = `
    :root { color-scheme: dark; --bg:#1c1c1c; --card:#262626; --line:#3a3a3a; --text:#e6e6e6; --muted:#9a9a9a; --green:#3CFA44; }
    html, body { margin:0; background:var(--bg); color:var(--text);
      font:15px/1.45 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      touch-action:manipulation; -webkit-text-size-adjust:100%; overscroll-behavior:none; }
    main.cue { max-width:640px; margin:0 auto; padding:16px; display:flex; flex-direction:column; gap:14px; }
    .cue header { display:flex; justify-content:space-between; align-items:center; gap:8px; }
    .cue h1 { font-size:18px; margin:0; } .cue h2 { font-size:14px; margin:0 0 6px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); }
    .cue section { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px; }
    .cue .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; justify-content:space-between; margin-top:8px; }
    .cue .btns { justify-content:flex-start; }
    .cue .chip { font-size:12px; border:1px solid var(--line); border-radius:999px; padding:2px 10px; color:var(--muted); }
    .cue .muted { color:var(--muted); font-size:13px; }
    .cue .hud { position:relative; width:100%; aspect-ratio:2/1; background:#000; border-radius:8px; margin-top:8px; overflow:hidden; container-type:inline-size; }
    .cue .c { position:absolute; left:0; right:0; margin:0; padding:0.7%; color:var(--green); white-space:pre-wrap; word-break:break-word;
      font:3.6cqw/4.69cqw -apple-system, system-ui, sans-serif; overflow:hidden; box-sizing:border-box; }
    .cue .hdr { top:0; height:12.15%; } .cue .body { top:15.28%; height:49.65%; } .cue .foot { top:87.85%; height:12.15%; }
    .cue button { background:#333; color:var(--text); border:1px solid var(--line); border-radius:8px; padding:8px 12px; font-size:14px; }
    .cue input { flex:1; min-width:0; background:#111; color:var(--text); border:1px solid var(--line); border-radius:8px; padding:8px; font-size:14px; }
    .cue .mono { font:12px/1.4 ui-monospace, Menlo, monospace; white-space:pre-wrap; margin:0; }
    .cue .log { max-height:300px; overflow:auto; }
    .cue .card { border:1px solid var(--line); border-radius:8px; padding:8px; margin-bottom:8px; }
    .cue .card.on { border-color:var(--green); }
    .cue .k { font-size:12px; color:var(--muted); margin-bottom:4px; }`
  const el = document.createElement('style')
  el.textContent = css
  document.head.appendChild(el)
}
