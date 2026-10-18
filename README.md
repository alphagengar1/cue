# Cue

Cue is an app for Even Realities G2 smart glasses that gives quiet networking help at in-person events. Hold the temple, say a name, an org and a role ("Priya, Anduril, recruiter"), and about three seconds later three short cards appear on the HUD: **Connect**, **Context** and **Your angle**. Then the display goes quiet so you can talk. After the conversation you hold the temple again and say what happened, and Cue texts you a recap, a follow-up email, three proposed meeting times with a tentative hold on your calendar, and, at the end of the day, coaching on how you did. Built by two UCLA freshmen at LA Hacks Fall 2026.

Public professional info only. No camera, no face recognition, no recording without on-screen consent. From LinkedIn Cue reads professional sections only (headline, role, experience, projects, publications), never contact info, connections, activity or the personal About. Nothing personal from any profile: family, relationships, home, health, religion, politics, age and appearance are dropped by a blocklist and by a decision-model predicate. No agent ever contacts the person you met. The design docs in [design/](design/README.md) are the source of truth; start with [design/README.md](design/README.md).

## How it works in one minute

- **Before the event**, the CREAO Event Loader builds the org store and seed people from the event's sponsor or employer list (setup page, `POST /api/events`).
- **The live moment** (about 3 s, on our backend): Deepgram STT with the event's names as keyterms, Exa search, the OpenAI Decisions API gate, one Claude Haiku call, three cards on the HUD. If the facts do not match the person, you get "No public info found" instead of cards about a stranger. If they match but offer nothing for your goal, one quiet line.
- **About 90 s later**, the CREAO Person Researcher and Brief Writer have rewritten the cards from sourced facts (a dim "★ updated" marker on the HUD, Brief v2 then v3).
- **Everything you say is spoken, not a menu**: a decision model routes it as a lookup, a correction, a debrief, a goal change, a recap request, a coach question or "never mind".
- **After a conversation**, your spoken debrief gets an instant Haiku recap by iMessage, then the CREAO Follow-up Writer (email, short message, next steps, optional Gmail draft) and the CREAO Meeting Scheduler (three times, scheduling message, one tentative hold on your own calendar), each texted as it completes.
- **Over the day**, the CREAO Networking Coach answers "how did I do today?" by voice or text, runs after every third debrief, and remembers earlier days.
- **Photon (Spectrum iMessage)** delivers all of it to the wearer only. The backend refuses any other number.

## Repo layout

```
cue/
  design/      design docs (product, architecture, glasses UX, agents, build plan, 05-agent-contracts.md, CREAO and Photon notes)
  shared/      types.ts: canonical data types used by app and backend
  app/         glasses app (Vite + TypeScript, Even Hub SDK), runs in the Even Realities phone app, holds no keys
  backend/     Node + Express + TypeScript API: speech-to-text, event store, search and safety filters, decision gate, intent router,
               fast brief writer, CREAO agent transport and apply functions, debrief chain, coach, Google Calendar, Photon recap and replies,
               texting voice, Sentry tracing
  agents/      paste-only prompts for the six CREAO agents, plus voice.md, fast-brief.md and decision-gate.md
  deploy/      AWS Lightsail + Caddy (automatic HTTPS) + systemd
  docs/        Devpost text, video script, table pitch
```

## Run the backend

Needs Node 20.12 or newer (the team uses `$HOME/.nvm/versions/node/v22.18.0/bin/node`).

```bash
cd backend
cp .env.example .env      # fill in keys; any missing key falls back gracefully
npm install
npm run dev               # http://localhost:8787 (tsx watch)
npm run smoke             # in a second terminal: calls /api/state and /api/briefs/text
npm test                  # unit tests, never touch the network or text anyone
```

Production: `npm run build && npm start`. The live backend runs on AWS Lightsail behind Caddy at `https://35.164.205.54.sslip.io` (see [deploy/README.md](deploy/README.md)).

## Run the glasses app

```bash
cd app
npm install
npm run dev               # Vite dev server on :5173
npm run simulate          # desktop simulator, or:
npx evenhub qr --url http://<your-laptop-ip>:5173   # scan with the Even Realities app
```

The app talks only to the backend (`VITE_BACKEND_URL`, `VITE_DEVICE_TOKEN` in `app/.env.local`). It holds no API keys.

## On the glasses

The menu is five items: **Talk**, **Last brief**, **Text me a recap**, **Record conversation**, **Go quiet** (plus **Hardware test** with `?dev`). Everything else is spoken: hold the temple (up to 12 s), say anything, and the transcript goes to `POST /api/say`, where the OpenAI Decisions API picks the intent (a plain "name, company, role" is routed by rules without the call; rules are also the fallback). Push-to-talk audio is discarded after transcription.

| You say | Intent | What happens |
|---|---|---|
| "Priya Shah, Anduril, recruiter" | lookup | three cards in about 3 s, rewritten by the CREAO agents about 90 s later ("★ updated") |
| "Cramer with a C" / "no, it's Priya not Maya" | correction | the last lookup re-runs with the fixed name |
| "he said email him about Seer, they're hiring interns" | debrief | note saved on the brief, recap texted ("★ note saved, recap texted"), then Follow-up Writer and Meeting Scheduler text their results |
| "I'm looking for a cofounder" | goal | goal set, the angle card is rewritten and shown |
| "text me the recap" | recap | "★ recap texted" |
| "how did I do today?" / "who should I follow up with?" | coach | the Networking Coach runs and texts a few bubbles |
| "never mind" | quiet | back to quiet |
| anything else | unknown | one quiet line with a hint |

**Record conversation** needs a real brief on screen. The HUD first shows a consent screen: "Ask them: OK if my glasses take notes? Tap once they say yes." Swipe up cancels. A tap starts "● Recording m:ss" with a running word count; a tap stops (15 min cap). Audio streams in 20 s chunks to `POST /api/briefs/:id/transcript`. The transcript lives only on `brief.conversation` and rides into the Follow-up Writer (inside the debrief), the Meeting Scheduler and the Coach. Nothing is stored on the glasses or the phone, and it is never logged.

Misheard names snap to the event list: Deepgram gets the event's names and orgs as keyterms, and the backend accepts a listed attendee within 2 edits ("David Kramer" becomes David Cramer), so a near miss never needs a confirm screen. The "Which Priya?" confirm screen remains for a real ambiguity. If the decision gate says the facts match the person but offer nothing for your goal, you get one quiet line ("<name>: nothing for your goal") instead of cards; the cards stay under Last brief.

Unverified on hardware as of Oct 18 early: see "What is verified and what is not" below.

## CREAO agents

Six agents, all built on agent.creao.ai and all started from the backend. Prompts and test inputs are in [agents/](agents/); the backend contract is [design/05-agent-contracts.md](design/05-agent-contracts.md).

| # | Agent | Agent ID | Run share link | Started by | Returns |
|---|---|---|---|---|---|
| 1 | Event Loader | `7ed5ac12-fb85-4545-9e4e-abbeaa25db1a` | https://agent.creao.ai/share/aa9e8fec817ba50138997a79b610d5cc | `POST /api/events` from the setup page | organizations (one-liner, focus now, hiring, sourced) and seed people; builds the org store |
| 2 | Person Researcher | `e496e45b-c8eb-4079-9aff-876071501d67` | https://agent.creao.ai/share/21c460878c2ec3e4eed039a5a327e0e6 | the backend after a lookup with a high match or a confirmed pick, once per person | sourced facts, headline, match level; Brief v2 at once |
| 3 | Brief Writer | `d5ded73b-03b6-407d-be3e-5d332d6e869a` | https://agent.creao.ai/share/5922c0b96ff6085300d95090eeb4bc58 | the backend, chained after the Person Researcher | checked three-card Brief v3 with an `improvesOn` note |
| 4 | Follow-up Writer | [FOLLOW-UP WRITER AGENT ID] | [FOLLOW-UP WRITER SHARE LINK] | the backend on a spoken or texted debrief, right after the instant Haiku recap | email, message (300 chars or less), next steps; optional Gmail draft link (never sent); email, subject, next steps and draft link texted by Photon, "text" for the message |
| 5 | Meeting Scheduler | [MEETING SCHEDULER AGENT ID] | [MEETING SCHEDULER SHARE LINK] | the backend, chained after the Follow-up Writer | three half-hour times in the wearer's timezone, invite title and description, scheduling message, one tentative 30-minute hold on the wearer's own calendar with no guests; texted by Photon, "book" for the message, "book 2" to move a backend hold |
| 6 | Networking Coach | [NETWORKING COACH AGENT ID] | [NETWORKING COACH SHARE LINK] | intent `coach` by voice or iMessage, automatically after every third debrief of the day, optional nightly Schedule on the agent | summary, patterns, priorities (name, why, action), coaching, next time; texted as a few bubbles |

**Paste-only convention.** `agents/<name>.md` holds only what is pasted into agent.creao.ai, in the order given at the top of each file: block 1 is the first message (plus a test input), block 2 goes into the Create Agent instructions box, block 3 is the `.env` lines, then the test inputs. The backend contract (what is sent, what is read back, what is applied) is [design/05-agent-contracts.md](design/05-agent-contracts.md). The texting voice every agent and every backend text follows is [agents/voice.md](agents/voice.md). [agents/fast-brief.md](agents/fast-brief.md) is the backend Haiku prompt and [agents/decision-gate.md](agents/decision-gate.md) is the OpenAI gate; neither is a CREAO agent.

## How CREAO is used

- **Six agents built in the agent.creao.ai UI**, started from the backend over CREAO's per-agent App API: each agent has its own `capi_` key from its API page, kept in `backend/.env` as `CREAO_<AGENT>_KEY`. `backend/src/creao.ts` POSTs the agent's declared inputs to `agent.creao.ai/api/v1/apps/{agentId}/runs`. It registers a **webhook** when `PUBLIC_BASE_URL` is set and **polls** `GET .../runs/{runId}` every 15 s (15 min cap). It then extracts the first JSON block from `result.chatText`, `result.text` or artifacts, validates it with zod and applies it. Keys never leave the server.
- **Three backend-orchestrated chains**: Person Researcher -> Brief Writer rewrites the cards about 90 s after a lookup (Brief v2 when the facts land, v3 when the Brief Writer finishes); Follow-up Writer -> Meeting Scheduler runs after each spoken debrief, each result texted as it completes; the Networking Coach runs over the day, on request and after every third debrief.
- **Extended memory** on the Person Researcher, Follow-up Writer, Meeting Scheduler and Networking Coach. The Coach's memory is what makes "compared with yesterday" real.
- **Google Calendar connector** on the Meeting Scheduler: with Autonomy Auto it reads the wearer's free time and creates one tentative 30-minute hold on the wearer's own calendar, no guests (`calendarEventCreated`, `eventLink`). The backend can also prepend Google Calendar free windows to `wearer.availability`, double-checks the proposed times against free/busy and places the hold itself only if the agent did not.
- **Gmail connector** on the Follow-up Writer, draft only: the email is saved as a Gmail draft (`draftLink`) and never sent.
- **Browser Use** (optional) on the Person Researcher so it can read professional LinkedIn sections and pages, not just snippets.
- **Autonomy Auto** on every agent; API runs under "Ask first" cannot write to a connector.
- **Schedule tab**: an optional nightly run of the Networking Coach that reviews the day from memory.
- **Output format Markdown** on every agent (the Coach can use **Dashboard** for a KPI view per run); the JSON block still ends the chat reply.
- **Run share links** for each agent (table above) and the **Sessions tab**, which shows the live runs the backend starts during a demo.
- **CREAO Pro Plus** plan on the team account.
- **Consented conversation transcript**: when the wearer records a conversation after on-screen consent, the transcript rides into the Follow-up Writer, the Meeting Scheduler and the Coach, and nowhere else.
- **No agent contacts the other person.** Agents produce drafts and holds for the wearer; the wearer sends them. Photon texts only the wearer.
- Hand-run JSON pasted into `backend/data/<event>.json` is still supported as a pre-event path and lands in the same store.

## Setup

1. **Clone** the repo and install: `cd backend && npm install`, `cd app && npm install`.
2. **Backend `.env`**: `cp backend/.env.example backend/.env` and fill it in, in the file's order. Every group is optional except the first for a real device; a missing key falls back as noted.
   - `PORT` (8787) and `DEVICE_TOKEN`: the bearer token the glasses app and setup page send. Empty only for local dev (auth off). The same value becomes `VITE_DEVICE_TOKEN`.
   - `DEEPGRAM_API_KEY`: speech-to-text (nova-3). Without it `/api/stt` returns `STT_FAILED` and the typed path on the setup page still works.
   - `EXA_API_KEY`: web search for the live path. Without it the cards come from the event store only.
   - `ANTHROPIC_API_KEY`, optional `ANTHROPIC_WORKSPACE_ID`, `BRIEF_MODEL` (default `claude-haiku-5-5`, effort low): the 3-second cards and the instant texts. Without it, template cards and template texts.
   - Optional `/v2` developer transport: `CREAO_API_KEY` (`cr_sk_`). The `CREAO_<AGENT>_ID` vars override the agent id on either transport; the first three (`CREAO_EVENT_LOADER_ID`, `CREAO_PERSON_RESEARCHER_ID`, `CREAO_BRIEF_WRITER_ID`) default to the Cue agents in the table above. The per-agent `capi_` keys below are what the live system uses; the `/v2` key is only an alternative.
   - `PUBLIC_BASE_URL`: public https origin of the backend, for the CREAO webhook. Leave empty locally (CREAO rejects localhost webhooks; the backend polls every 15 s instead). `deploy/setup.sh` sets it on the server.
   - `SENTRY_DSN` (optional `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE`): tracing and logs on the live path, spans `stt`, `store lookup` (inside `lookup total`), `search` and `llm`; the decision gate's time rides on the trace as the attribute `cue.ms.decide`. Off when empty.
   - Tuning: `STT_TIMEOUT_MS`, `SEARCH_TIMEOUT_MS`, `LLM_TIMEOUT_MS`, `LOOKUPS_PER_MINUTE`.
   - Photon: `PHOTON_PROJECT_ID`, `PHOTON_PROJECT_SECRET`, `WEARER_PHONE` (E.164). Texting is skipped until all three are set. The backend refuses to text any number but `WEARER_PHONE`.
   - `OPENAI_API_KEY` and `DECIDE_TIMEOUT_MS` (default 1200; the design target is 700): intent routing and the cue gate on the OpenAI Decisions API (`gpt-6-luna`). Without the key, the rules classifier and the code filters run alone.
   - `SAMPLE_EVENT_FILE`: the event file loaded at boot (the setup page can switch events at runtime).
   - The six per-agent pairs: `CREAO_EVENT_LOADER_KEY`, `CREAO_PERSON_RESEARCHER_KEY`, `CREAO_BRIEF_WRITER_KEY`, `CREAO_FOLLOW_UP_WRITER_KEY` + `CREAO_FOLLOW_UP_WRITER_ID`, `CREAO_MEETING_SCHEDULER_KEY` + `CREAO_MEETING_SCHEDULER_ID`, `CREAO_NETWORKING_COACH_KEY` + `CREAO_NETWORKING_COACH_ID`. The first three IDs default to the Cue agents in the table above. An agent with no key simply does not run; the fast cards and the recap still work.
   - `WEARER_TIMEZONE` (default `America/Los_Angeles`): the timezone meeting times are proposed in.
   - Optional backend-side Google Calendar: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, then `npm run google:auth` signed in as the wearer to get `GOOGLE_REFRESH_TOKEN`; optional `GOOGLE_CALENDAR_ID` (default `primary`). Off until all three are set; the agent's own connector hold works without it.
   - `WEARER_HOURS` (default `10-18`) and `WEARER_WEEKENDS=1` to allow weekend slots.
3. **Run the backend**: `npm run dev` (watch), `npm run smoke` (hits `/api/state` and `/api/briefs/text`), `npm test` (unit tests, no network), `npm run creao:test` (starts one agent run from the CLI, `-- --list` lists agents on the `/v2` transport), `npm run google:auth` (one-time OAuth for the backend calendar path). Production: `npm run build && npm start`.
4. **App `.env.local`**: `cp app/.env.example app/.env.local`; set `VITE_BACKEND_URL` (your laptop's LAN IP for a phone, or the deployed https URL), `VITE_DEVICE_TOKEN` (same as `DEVICE_TOKEN`), and `VITE_MOCK` (empty = fall back to a sample brief when the backend has no keys, `1` = always mock, `0` = never).
5. **Even Hub**: `cd app && npm run dev`, then `npx evenhub qr --url http://<your-laptop-ip>:5173` and scan the QR with the Even Realities app while wearing the G2. `npm run simulate` runs the desktop simulator instead.
6. **Photon**: create a project at app.photon.codes, add the wearer's phone as a user, copy the project ID and secret into `.env`, then send one "hi" text from the wearer's phone to the project's line before the demo so links are clickable and no junk banner appears.
7. **CREAO agents**: for each file in `agents/` (event-loader, person-researcher, brief-writer, follow-up-writer, meeting-scheduler, networking-coach), follow the paste order at the top of the file on agent.creao.ai: paste block 1 with a test input, check the JSON block, Create Agent, Output format Markdown, paste block 2 into the instructions box, set **Autonomy Auto**, turn on extended memory and the connector the file names, then create the agent's **API key** and add block 3 to `backend/.env`.
8. **Deploy**: [deploy/README.md](deploy/README.md). One Lightsail instance, `deploy/setup.sh`, Caddy for HTTPS, systemd for the service; copy `backend/.env` to the server; `deploy/check.sh` verifies it from your laptop.

What works with missing keys: the setup page and `/api/briefs/text` always answer (template cards from the sample event); no Deepgram means typed lookups only; no Anthropic key means template cards and texts; no OpenAI key means rules and blocklist only; no CREAO key for an agent means that agent is skipped and the chain continues without it; no Photon means nothing is texted and the HUD says "recap: Photon not set up"; no Google vars means the agent's connector handles the calendar alone.

## Sponsors

- **Even Realities**: the G2 glasses and Even Hub SDK. The app lives in the Even Realities phone app, with push-to-talk on the temple and a 576x288 monochrome HUD.
- **CREAO**: six agents, per-agent App API, extended memory, connectors, Browser Use, Schedule, Sessions. See "How CREAO is used".
- **Photon**: Spectrum iMessage SDK with a project allowlist. Delivers recaps, follow-ups, times and coaching to the wearer only.
- **Sentry**: tracing and logs on the live path (spans `stt`, `store lookup` inside `lookup total`, `search`, `llm`; the gate's timing as the attribute `cue.ms.decide`), sizes and timings only, never audio or transcripts.
- **Hosting**: AWS Lightsail behind Caddy with automatic HTTPS.

## What is verified and what is not

Verified live from the backend (Oct 18, early):

- Lookup -> Haiku cards in about 3 s -> Person Researcher -> Brief Writer rewrite about 90 s later (Brief v2 then v3 with an `improvesOn` note).
- Typed or texted debrief -> instant Haiku recap -> Follow-up Writer -> Meeting Scheduler, each texted by Photon as it completes; the Scheduler's connector hold on the wearer's calendar.
- Networking Coach on a texted or typed "how did I do today?" and after every third debrief, texted as bubbles.
- Event Loader started from the setup page.
- Real Photon sends to the wearer, and the replies "email", "text", "who did I meet", "book", "book 2" and coach questions in the thread.
- The OpenAI Decisions API intent router and cue gate, Sentry tracing, and the AWS deployment.

Unverified on the physical G2 as of Oct 18, early:

- The spoken intents (correction, debrief, goal, recap, coach, never mind) and the goal-gate quiet line, built Oct 17 late; verified from the setup page and the typed path.
- Record conversation (consent screen, chunked streaming), built Oct 18 early; verified against the backend only.
- The backend-side Google Calendar OAuth path (`GOOGLE_*`, `npm run google:auth`) is wired and tested with stubs; the agent's own connector hold is the verified path.
- Known caveats: Brief Writer cards are not loaded from a hand-run event file (only the live chain writes v3); `DECIDE_TIMEOUT_MS` defaults to 1.2 s against the 700 ms design target.
