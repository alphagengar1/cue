# Cue

Cue is an app for Even Realities G2 smart glasses that gives quiet networking help at in-person events. Hold the temple, say a name, an org and a role ("Priya, Anduril, recruiter"), and about three seconds later three short cards appear on the HUD: **Connect**, **Context** and **Your angle**. Then the display goes quiet so you can talk. After the conversation you hold the temple again and say what happened, and Cue texts you a recap, a follow-up email, three proposed meeting times with a tentative hold on your calendar, and, at the end of the day, coaching on how you did. Built by two UCLA freshmen at LA Hacks Fall 2026.

Public professional info only. No camera, no face recognition, no recording without on-screen consent. From LinkedIn Cue reads professional sections only (headline, role, experience, projects, publications), never contact info, connections, activity or the personal About. Nothing personal from any profile: family, relationships, home, health, religion, politics, age and appearance are dropped by a blocklist and by a decision-model predicate. No agent ever contacts the person you met. The design docs in [design/](design/README.md) are the source of truth; start with [design/README.md](design/README.md).

## How it works in one minute

- **Before the event**, the CREAO **Research** agent builds the org store and seed people from the event's sponsor or employer list (setup page, `POST /api/events`).
- **The live moment** (about 3 s, on our backend): Deepgram STT with the event's names as keyterms, Exa search, the OpenAI Decisions API gate, one Claude Haiku call, three cards on the HUD. If the facts do not match the person, you get "No public info found" instead of cards about a stranger. If they match but offer nothing for your goal, one quiet line.
- **Everything you say is spoken, not a menu**: a decision model routes it as a lookup, a correction, a debrief, a goal change, a recap request, a coach question or "never mind".
- **After a conversation**, your spoken debrief gets an instant Haiku recap by iMessage, then the CREAO **Follow-up** agent texts the email, a short message, next steps, three proposed times, a tentative hold on your own calendar and a Gmail draft, in one run.
- **Over the day and the weeks**, the CREAO **Coach** agent reads the Cue Journal, keeps the "Cue Connections" sheet, renders a dashboard, answers "how did I do today?" by voice or text, runs after every third debrief and every night, and remembers earlier days.
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
  agents/      three CREAO agents, each file the exact message for the CREAO chat (research, follow-up, coach), plus voice.md, fast-brief.md and decision-gate.md
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
| "Priya Shah, Anduril, recruiter" | lookup | three cards in about 3 s |
| "Cook with a C" / "no, it's Priya not Maya" | correction | the last lookup re-runs with the fixed name |
| "he said email him about Seer, they're hiring interns" | debrief | note saved on the brief, recap texted ("★ note saved, recap texted"), then Follow-up Writer and Meeting Scheduler text their results |
| "I'm looking for a cofounder" | goal | goal set, the angle card is rewritten and shown |
| "text me the recap" | recap | "★ recap texted" |
| "how did I do today?" / "who should I follow up with?" | coach | the Networking Coach runs and texts a few bubbles |
| "never mind" | quiet | back to quiet |
| anything else | unknown | one quiet line with a hint |

**Record conversation** needs a real brief on screen. The HUD first shows a consent screen: "Ask them: OK if my glasses take notes? Tap once they say yes." Swipe up cancels. A tap starts "● Recording m:ss" with a running word count; a tap stops (15 min cap). Audio streams in 20 s chunks to `POST /api/briefs/:id/transcript`. The transcript lives only on `brief.conversation` and rides into the Follow-up Writer (inside the debrief), the Meeting Scheduler and the Coach. Nothing is stored on the glasses or the phone, and it is never logged.

Misheard names snap to the event list: Deepgram gets the event's names and orgs as keyterms, and the backend accepts a listed attendee within 2 edits ("Tim Cooke" becomes Tim Cook), so a near miss never needs a confirm screen. The "Which Priya?" confirm screen remains for a real ambiguity. If the decision gate says the facts match the person but offer nothing for your goal, you get one quiet line ("<name>: nothing for your goal") instead of cards; the cards stay under Last brief.

Verified on the G2 on Oct 18 (spoken lookup, debrief, coach, goal change, Record conversation); see "What is verified and what is not" below.

## CREAO agents

Three agents, split by when they run, all built on agent.creao.ai and all started from the backend. Each file in [agents/](agents/) is the complete message for the CREAO chat (`cat agents/follow-up.md | pbcopy`, paste): it creates the agent, applies every setting, runs a test, creates the API key and replies with the id and key. The backend contract is [design/05-agent-contracts.md](design/05-agent-contracts.md).

| # | Agent | Agent ID | Link | Started by | Returns |
|---|---|---|---|---|---|
| 1 | Research | `5283bd7f-cc11-4b29-902b-2debe558b46f` | https://agent.creao.ai/install/5283bd7f-cc11-4b29-902b-2debe558b46f?version=4c8c119a-7514-4dca-9e6b-64798d859bbd | `POST /api/events` from the setup page (EVENT request); optionally after a lookup (PERSON request, `RESEARCH_AFTER_LOOKUP=1`, off by default) | organizations and seed people; or sourced facts, headline, match level and the final three cards with an `improvesOn` note |
| 2 | Follow-up | `7a639acb-b15a-4d88-b66d-c76831b92ddf` | https://agent.creao.ai/install/7a639acb-b15a-4d88-b66d-c76831b92ddf?version=e2188ecf-8212-4b00-a590-4396a046cc07 | the backend on a spoken or texted debrief, right after the instant Haiku recap | email, message (300 chars or less), next steps, Gmail draft link (never sent), three half-hour times, scheduling message, one tentative 30-minute hold on the wearer's own calendar with no guests; texted by Photon, "book" for the message |
| 3 | Coach | `b095ddf1-cccc-42ae-a381-ccc7906b14a4` | https://agent.creao.ai/install/b095ddf1-cccc-42ae-a381-ccc7906b14a4?version=58dfa39f-5361-4cb3-9e04-e92d421dda4f | intent `coach` by voice or iMessage, automatically after every third debrief, and a nightly Schedule on the agent | summary, patterns, priorities, coaching, next time, 7-day metrics and trend, open loops; syncs the "Cue Connections" sheet and renders a dashboard; texted as a few bubbles |

The earlier six single-purpose agents (Event Loader `7ed5ac12…`, Person Researcher `e496e45b…`, Brief Writer `d5ded73b…`, Follow-up Writer, Meeting Scheduler, Networking Coach) were merged into these three on Oct 18; the backend still accepts their outputs. [agents/voice.md](agents/voice.md) is the texting voice every agent and every backend text follows. [agents/fast-brief.md](agents/fast-brief.md) is the backend Haiku prompt and [agents/decision-gate.md](agents/decision-gate.md) is the OpenAI gate; neither is a CREAO agent.

## How CREAO is used

**What stops without the agents.** Remove the CREAO keys and Cue degrades to the 3-second cards and nothing else: no event pack from a text message (the setup page can only load a hand-written file), no follow-up email, message, times or calendar hold ("email" and "book" answer that the follow-up agent is not connected), no coaching, no nightly analysis, no Connections sheet. The fast writer covers a follow-up only when an agent run has actually failed. The 3-second path stays on Haiku on purpose: a CREAO run is a sandboxed, memory-backed job that takes one to several minutes, which is the right tool for everything before and after a conversation and the wrong one for the two seconds inside it.

- **Three agents built from the CREAO chat** (one paste each), started from the backend over CREAO's per-agent App API: each agent has its own `capi_` key, kept in `backend/.env`. `backend/src/creao.ts` POSTs the inputs to `agent.creao.ai/api/v1/apps/{agentId}/runs`, registers a **webhook** (`PUBLIC_BASE_URL`) and **polls** as a fallback, then extracts the first JSON block from the reply or its artifacts, validates it with zod and applies it. Keys never leave the server.
- **The Cue Journal** (`backend/src/journal.ts`): every stage of every conversation (brief, research, cards, debrief, consented transcript, recap, follow-up, times, coaching, goal) is appended to a persistent journal and served as Markdown at `/journal.md` behind its own `JOURNAL_TOKEN`. The Coach reads it on its own schedule; nothing has to start it.
- **Long-running, memory-backed agent**: the Coach runs nightly from the Schedule tab with extended memory, compares weeks, keeps the "Cue Connections" Google Sheet (Sheets connector) as a CRM and renders a Dashboard per run. That is the pattern the CREAO team asked for.
- **Extended memory** on all three agents.
- **Connectors**: Google Calendar and Gmail on Follow-up (one tentative hold with no guests, one draft that is never sent), Google Sheets on Coach.
- **Browser Use** on Research, for professional LinkedIn sections and pages, not just snippets.
- **Autonomy Auto** on every agent; API runs under "Ask first" cannot write to a connector.
- **Output format** Markdown on Research and Follow-up, Dashboard on Coach; the JSON block still ends every chat reply.
- **Share links** for each agent (table above) and the **Sessions tab**, which shows the live runs the backend starts during a demo.
- **CREAO Pro Plus** plan on the team account.
- **Consented conversation transcript**: when the wearer records a conversation after on-screen consent, the transcript rides into the Follow-up and Coach agents, and nowhere else.
- **No agent contacts the other person.** Agents produce drafts and holds for the wearer; the wearer sends them. Photon texts only the wearer.
- Hand-run JSON pasted into `backend/data/<event>.json` is still supported as a pre-event path and lands in the same store.

## For the long-term agents (teammate track)

The post-conversation, long-horizon side is a separate track: agents that live on CREAO, read the Cue Journal on their own schedule with extended memory, and help the wearer get better over time (speech and delivery, networking skills across weeks, patterns about the wearer, relationship state, dashboards). Full freedom on design. The backend's only job here is to record everything, in a readable form, which it does.

What you need:

1. **Clone the repo** and read, in this order: `design/06-journal.md` (the schema of every entry the backend records and what each agent can derive), `docs/journal-sample.md` (a real journal from the server), `agents/voice.md` (the texting voice if an agent ever texts the wearer).
2. **The data**: `https://35.164.205.54.sslip.io/journal.md?token=<JOURNAL_TOKEN>` (Markdown, what an agent reads) and `/api/journal.json?token=…` (JSON). The token is the `JOURNAL_TOKEN` line in `backend/.env`; ask the team for it, never commit it. The journal is append-only and holds: every utterance the wearer spoke (verbatim, with how it was understood), cards shown, research facts, debriefs, consented transcript chunks, the recap texts, iMessage replies, follow-ups, proposed times and holds, coaching, goal changes.
3. **Build agents on CREAO** with the chat: `cat agents/coach.md | pbcopy` is the starting point (reads the journal nightly, keeps the "Cue Connections" Google Sheet, renders a dashboard, coaches with memory). Replace `JOURNAL_URL` in the text before pasting. New agents of your own: same pattern, one paste file per agent in `agents/`, give it the journal URL, a schedule, extended memory, and whichever connectors it needs (Sheets, Calendar, Gmail drafts).
4. **If an agent should be reachable from the backend** (for example "how did I do today?" from the glasses), send the agent id and key to the backend owner for `backend/.env` (`CREAO_COACH_KEY`, `CREAO_COACH_ID`); the backend starts it and texts its result. Scheduled runs need nothing from the backend.
5. **Rules that do not bend**: professional content only, never write anything private about anyone into a sheet, dashboard or text; never contact the other person, only the wearer; the journal is the wearer's own data.
6. **Need a field the journal does not record?** Say which entry type and which fields; the backend owner adds it.

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
7. **CREAO agents**: for each of `agents/research.md`, `agents/follow-up.md`, `agents/coach.md`: `cat` the file, paste it into a new chat on agent.creao.ai, follow the sign-in prompts for connectors, and put the `AGENT_ID` and `AGENT_KEY` it replies with into `backend/.env` as the two lines named in [agents/README.md](agents/README.md). Set `JOURNAL_TOKEN` in `.env` and replace `JOURNAL_URL` in `coach.md` before pasting it.
8. **Deploy**: [deploy/README.md](deploy/README.md). One Lightsail instance, `deploy/setup.sh`, Caddy for HTTPS, systemd for the service; copy `backend/.env` to the server; `deploy/check.sh` verifies it from your laptop.

What works with missing keys: the setup page and `/api/briefs/text` always answer (template cards from the sample event); no Deepgram means typed lookups only; no Anthropic key means template cards and texts; no OpenAI key means rules and blocklist only; no CREAO key for an agent means that agent is skipped and the chain continues without it; no Photon means nothing is texted and the HUD says "recap: Photon not set up"; no Google vars means the agent's connector handles the calendar alone.

## Sponsors

- **Even Realities**: the G2 glasses and Even Hub SDK. The app lives in the Even Realities phone app, with push-to-talk on the temple and a 576x288 monochrome HUD.
- **CREAO**: three agents (Research, Follow-up, Coach), per-agent App API, the Cue Journal, extended memory, connectors, Browser Use, Schedule, Dashboard, Sessions. See "How CREAO is used".
- **Photon**: Spectrum iMessage SDK with a project allowlist. Delivers recaps, follow-ups, times and coaching to the wearer only.
- **Sentry**: tracing and logs on the live path (spans `stt`, `store lookup` inside `lookup total`, `search`, `llm`; the gate's timing as the attribute `cue.ms.decide`), sizes and timings only, never audio or transcripts.
- **Hosting**: AWS Lightsail behind Caddy with automatic HTTPS.

## What is verified and what is not

Verified live from the backend and on the AWS server (Oct 18, early), with the six single-purpose agents the three merged ones replace:

- Lookup -> Haiku cards in about 3 s (Exa + LinkedIn + Haiku). The background CREAO rewrite (Research agent, v2 at 100 s) also works on the server but is off by default (`RESEARCH_AFTER_LOOKUP=1` to enable): nobody waits two minutes mid-conversation.
- Typed or texted debrief -> instant Haiku recap -> Follow-up Writer -> Meeting Scheduler, each texted by Photon as it completes.
- Networking Coach on a texted or typed "how did I do today?" and after every third debrief, texted as bubbles.
- Real Photon sends to the wearer, and the replies "email", "text", "who did I meet", "book" and coach questions in the thread.
- The OpenAI Decisions API intent router and cue gate, Sentry tracing, the AWS deployment with HTTPS, the Even Hub package (0.1.1) with speech-to-text working from the hub build.

Not yet verified:

- The three merged agents (Research, Follow-up, Coach) as such: created Oct 18 from the paste-only specs; the backend accepts their merged outputs (tests) but no live run yet.
- On the physical G2: the correction and "never mind" intents and the goal-gate quiet line (exercised from the typed path and in tests). Verified on the physical G2 on Oct 18 (about 10:00): spoken lookup with a misheard name resolved, spoken debrief with the recap texted in seconds, "how did I do today?" starting the coach, a spoken goal change (even "cofinder"), and Record conversation (consent screen, two 20-second chunks transcribed).
- The backend-side Google Calendar OAuth path (`GOOGLE_*`) is wired and tested with stubs; the agent's own connector hold is the verified path.
- Known caveats: `DECIDE_TIMEOUT_MS` defaults to 1.2 s against the 700 ms design target.
