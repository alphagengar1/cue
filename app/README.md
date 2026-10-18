# Cue glasses app (`app/`)

Even Hub app for the G2. Vite + vanilla TypeScript + `@evenrealities/even_hub_sdk` 0.0.16.
It boots into the **Cue flow** (`src/cue.ts`, states from `design/02-glasses-ux.md`).
**Hardware test mode** is still there: open the page with `?test=1`, pick the menu item
`Hardware test`, or press "Hardware test mode" on the phone page (menu `Hardware test` again
or "Back to Cue" returns).

## Cue flow

| Gesture | Ready / Quiet | Listening | Thinking | Card | Confirm |
|---|---|---|---|---|---|
| Long press | start Listening | - | cancel, listen again | new lookup | new lookup |
| Release | - | send (300 ms tail) | - | - | - |
| Tap | open last brief | send | ignored | next card (last -> Quiet) | pick |
| Swipe down / up | open last brief | - | ignored | next / previous card | move cursor |
| Double tap | exit dialog | exit dialog | exit dialog | exit dialog | exit dialog |

Menu (tap-then-hold): Talk, five goals (card 3 regenerates), Last brief, Go quiet, Hardware test.
Cards go Quiet after 25 s idle; Confirm picks Neither after 10 s. While a real brief is open,
the app polls `GET /api/briefs/:id?since=` every 5 s and shows `★ updated` in place.

### Mock mode (`VITE_MOCK`, or `?mock=` in the URL, which wins)

| Value | Behavior |
|---|---|
| unset / `auto` (default) | Real calls. Falls back to the sample brief (Jordan, Sentry, developer advocate) when `/api/stt` returns `STT_FAILED` or the network fails, or `/api/briefs/text` returns a template fallback (`X-Cue-Fallback`) or fails. The HUD marks a substituted transcript with `(sample)`. |
| `1` | Always mock; no network for lookups. |
| `0` | Never mock; show what the backend returns. |

Typing `marcus` in the phone page's typed lookup (in mock) gives an ambiguous match to demo the
Confirm screen. Mock briefs get a simulated slow-path update after 15 s.

## Commands

Run everything from `cue/app`.

```bash
npm install
cp .env.example .env.local        # optional: set VITE_BACKEND_URL / VITE_DEVICE_TOKEN
npm run dev                       # Vite dev server on http://0.0.0.0:5173 (Ctrl+C to stop)
```

On real glasses (phone and laptop on the same wifi or the same phone hotspot):

```bash
ipconfig getifaddr en0                              # your laptop's LAN IP (macOS)
npx evenhub qr --url http://<laptop-ip>:5173        # scan with the Even app on the phone
```

Desktop simulator (with `npm run dev` running in another terminal):

```bash
npm run simulate                  # = evenhub-simulator http://localhost:5173
```

Other:

```bash
npm run typecheck                 # tsc --noEmit
npm run build                     # typecheck + vite build to dist/
npm run pack                      # build + evenhub pack -> .ehpk (needs the final backend host in app.json first)
```

If the glasses never load the page: check that the phone and laptop are on the same network,
that the macOS firewall allows `node`, and try a phone hotspot (venue wifi often isolates clients).

## Hardware test mode

Layout: the three containers from 02 section 2 (`hdr` 0-35, `body` 44-187 with event capture, `foot` 253-288; inner heights are exact multiples of the 27 px line height).

| Gesture | What it does |
|---|---|
| Tap | Next test page (on the Mic page in `tapToggle` mode: start/stop recording) |
| Swipe up / down | Previous / next variant on Ruler, Lines, Brightness, Cards. On Mic: swipe down = next page |
| Long press / release | (`PTT_MODE = 'hold'`) jump to the Mic page, record, stop on release |
| Double tap | Stop the mic and open the system exit dialog (`shutDownPageContainer(1)`) |
| Menu (tap-then-hold) | `Talk` (start/stop mic, starts after the menu closes), `Next test page`, `Reset counters` |

Every event is counted as `name@field` (for example `click@sysEvent`), shown in the footer
as `#12 click @sysEvent R`, and logged with `console.log` (raw JSON, PCM bytes elided).

| Page | What to record |
|---|---|
| 1 Gestures | Which gestures arrive, and in `textEvent` or `sysEvent`. Try left temple, right temple, ring. |
| 2 Ruler | Variants: `1234567890` x6, tens marks, `W` x60, mixed 60, glyphs, prose. Count chars on line 1 before the wrap. Glyphs: which symbols show. |
| 3 Lines | 8 and 12 numbered lines in `body`: how many are visible? Do `hdr line 2` / `foot line 2` show (does 44 px fit 1 or 2 lines)? Do swipes still arrive when the body overflows? |
| 4 Brightness | Swipe steps body `textColor` 0-4. Which levels are readable, is 0 invisible? Footer is at level 1. |
| 5 Cards | The worked examples from 02 section 6 (A cards 1-3, A card 3 cofounder, B org only), exactly as designed. |
| 6 Mic | Frames, bytes, seconds, KB/s (real time is 31.3), peak level, late frames after stop. With `VITE_BACKEND_URL` set, the clip is POSTed to `/api/stt`. |

The phone screen (the WebView) shows a HUD mirror, the help text for the current page,
counters, mic stats, a player for the last clip, a copyable results block, and the event log.

To switch push-to-talk mode, change `PTT_MODE` at the top of `src/testmode.ts`.

## Files

| File | Purpose |
|---|---|
| `src/main.ts` | Bridge init, create the 3-container page and menu, route events |
| `src/layout.ts` | Containers, `Screen` render contract, `render()` diffing, serial bridge queue with timeouts |
| `src/input.ts` | Parse `EvenHubEvent` into named gestures with their envelope field and side |
| `src/audio.ts` | Glasses mic capture, 300 ms tail, 0.4 s minimum, 8 s cap, WAV wrapper |
| `src/api.ts` | `GET /api/state`, `POST /api/stt` (01 section 4), bearer token |
| `src/testmode.ts` | Hardware test pages and gesture actions |
| `src/phone.ts` | Phone-side companion page |

## Config

- `app.json`: `com.cuehq.cue`, permissions `network` and `g2-microphone`. The `network` whitelist
  holds a placeholder (`https://api.cue.example.com`) plus `http://localhost:8787`. Replace the
  placeholder with the final backend origin before `npm run pack` (04 task A12).
- `.env.local`: `VITE_BACKEND_URL`, `VITE_DEVICE_TOKEN`. No third-party API keys go in this app.
  On the phone, `localhost` means the phone, so for dev use `http://<laptop-ip>:8787`.
