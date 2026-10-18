# 05. CREAO agent contracts (backend side)

The `agents/*.md` files hold only what gets pasted into agent.creao.ai. This doc is the other half: when the backend starts each agent, what it sends, what it reads back, and what it does with it. Code: `backend/src/creao.ts` (transport, result extraction, apply functions), `backend/src/say.ts` (debrief chain), `backend/src/coach.ts`.

## Transport (all six agents)

- Per-agent app key (`capi_`, from the agent's API page): `POST https://agent.creao.ai/api/v1/apps/{agentId}/runs` with `{ "inputs": {...} }`, then `GET .../runs/{runId}` every 15 s until `completed | failed | cancelled` (15 min cap). A webhook is registered too when `PUBLIC_BASE_URL` is set.
- Output: the backend searches `result.chatText`, then `result.text`, then markdown/text artifacts (downloaded with the same key) for the first JSON object of the agent's shape (fenced ```json block or bare). No JSON: wearer-facing agents' prose is texted with a note; other agents are marked failed.
- Env per agent: `CREAO_<AGENT>_KEY` (required to run) and `CREAO_<AGENT>_ID` (defaults to the Cue agents listed in README.md for the first three). Runs bill CREAO credits.
- `creaoEnabled(agent)` is true with a key and an id. Without, the backend behaves as if the agent did not exist.

## 1. Event Loader

- Trigger: `POST /api/events` (setup page "Load event") → `startRun("event_loader")`.
- Sends: `{ eventId, eventName, orgs: string[], people: [{name, org, role}], sourceText }`.
- Reads: `{ organizations: [{ id, name, aliases, oneLiner, focusNow: [fact], eventRole, hiring, people }], people: [{ name, orgId, role }] }`. Facts need an http(s) `sourceUrl`; sensitive terms dropped; `oneLiner` ≤ 120, `hiring` ≤ 160, `focusNow` ≤ 5.
- Applies: `applyEventLoader` writes `Organization` and seed `Person` records; `event.loadStatus` becomes `ready` (or stays `ready` with hand-written orgs if the run fails).

## 2. Person Researcher

- Trigger: after a fast brief with a `high` match, or a confirmed person, at most once per person (`maybeStartResearch` in `brief.ts`). Skipped when the event file already carries hand-run facts.
- Sends: `{ name, org, role, orgAliases: string[] }`.
- Reads: `{ name, role?, headline?, facts: [{ text, sourceUrl, sourceKind, date? }], match: high|medium|low, matchReason? }`. Each kept fact needs an http(s) source, no sensitive terms, and must name the person (full, or first + last) and the org (text, alias, or URL host). Max 8, ≤ 140 chars. LinkedIn allowed unless `ALLOW_LINKEDIN=0`.
- Applies: `applyPersonResearcher` merges facts into the `Person`, writes Brief v2 with the fast LLM at once (the HUD shows "★ updated"), then starts the Brief Writer if enabled.
- Hand-run alternative: paste the JSON into the person's entry in `backend/data/<event>.json` (`headline`, `facts`, `match`, `research`).

## 3. Brief Writer

- Trigger: chained after a Person Researcher run with new facts.
- Sends: `{ person: { name, role, headline, facts, match }, organization | null, wearer, goal, eventName }`.
- Reads: `{ cards: [{ kind, title, body, source }], improvesOn? }`. `enforceCards`: title ≤ 20, body ≤ 200 and ≤ 5 lines of 40, source a bare host/path ≤ 34 from the facts given; connect/context need a source.
- Applies: `applyBriefWriter` → `applyCardsV2`: replaces the brief's cards (v3) only if the wearer is still on that brief and person.

## 4. Follow-up Writer

- Trigger: a spoken or texted debrief (`say.ts`, intent `debrief`), right after the instant Haiku recap.
- Sends: `{ brief: { person: { name, role, org }, cards }, debrief, goal, wearer: { name, school, major, summary, interests, projects, goalNote }, eventName }`. A consented transcript rides inside `debrief` as "Conversation transcript: ...".
- Reads: `{ email: { subject, body }, message, nextSteps: string[] }` (optional `draftLink` planned).
- Applies: `applyFollowUpWriter` stores it on `person.followUp`, texts the wearer (voice: `agents/voice.md`, formatting in `backend/src/voice.ts`), then starts the Meeting Scheduler. The iMessage replies "email" and "text" use this output first when it exists.

## 5. Meeting Scheduler

- Trigger: chained after the Follow-up Writer.
- Sends: `{ person, followUp, debrief, conversation, wearer: { name, school, availability, timezone }, eventName }`. `availability` is the setup page field; `timezone` is `WEARER_TIMEZONE`.
- Reads: `{ proposedTimes: string[3], inviteTitle, inviteDescription, schedulingMessage, calendarEventCreated, eventLink | null }`. A calendar hold needs the Google Calendar connector and Autonomy **Auto** on the agent (API runs under "Ask first" skip writes).
- Applies: `applyMeetingScheduler` stores `person.followUp.schedule`, texts the times and message (and the link); "book" in iMessage returns the message to send.

## 6. Networking Coach

- Trigger: intent `coach` ("how did I do today?", "who should I follow up with?") by voice or text; automatically after every third debrief of the day; optionally a nightly schedule on the agent (Pro Plus) using its memory.
- Sends: `{ wearer: { name, school, goal, goalNote, summary }, today, history: [{ date, person, cards, debrief, conversation, followUpSent, goal }], question }` (`coach.ts`).
- Reads: `{ summary, patterns[], priorities: [{ name, why, action }], coaching[], nextTime }`.
- Applies: `applyNetworkingCoach` keeps the last coaching in memory and texts it as a few bubbles. Extended memory on the agent is what makes "compared with yesterday" real.

## Backend-side Google Calendar (optional, `backend/src/calendar.ts`)

Moved here from the Meeting Scheduler agent file. 
Two ways the hold gets made, and they do not fight:

| | Agent connector (on the live agent now) | Backend (`GOOGLE_*` in `.env`) |
|---|---|---|
| Free times | the agent reads the calendar through the connector | free windows appended to `wearer.availability` before the run |
| Hold | the agent creates it, returns `calendarEventCreated: true` and `eventLink`; stored as `holdSource: "agent"` | placed only if the agent did not; `holdSource: "backend"` |
| Check | none beyond the agent | proposed times rechecked against free/busy, busy ones dropped |
| "book 2" | cannot move an agent hold; Cue says so and the wearer drags it in Google Calendar | moves the hold |

With both on, the agent proposes from real free time and makes the hold, and the backend double-checks the times. With only the connector, nothing in `.env` changes. The rest of this section is the backend path.

Code: `backend/src/calendar.ts`, tests in `backend/test/calendar.test.ts`. No SDK: OAuth refresh token plus two REST calls (`freeBusy`, `events.insert`). Off until the three `GOOGLE_*` vars are set, and every failure falls back to the agent's own output, so the calendar never blocks a text.

What happens around one scheduler run:

1. **Before the run** (`availabilityWithCalendar`): free/busy for the next 10 days on the wearer's calendar, cut to `WEARER_HOURS` (default `10-18`, weekdays unless `WEARER_WEEKENDS=1`) in `WEARER_TIMEZONE`, snapped to the half hour, 30 minutes minimum. The free windows are appended to `wearer.availability` in the agent's own slot format, so the agent picks from them and still applies the wearer's words ("not Tuesdays"). The input contract does not change.
2. **After the run** (`confirmSchedule`): each `proposedTimes` entry is checked against free/busy again; busy ones are dropped. If the agent did not create a hold, the backend inserts one tentative 30-minute event at the first remaining time on the wearer's own calendar, titled `inviteTitle`, with `inviteDescription`, **no attendees**. `followUp.schedule` gets `holdEventId` and `holdSource: "backend"`, and `eventLink` is the Google Calendar link.
3. **"book 2" / "book thursday"** over iMessage (`backend/src/recap.ts`, `moveHold`): deletes the backend's hold and creates one at the chosen time, then texts "moved your hold to thu oct 22 3-3:30pm 📅", the link, and the message to send. Plain "book" just hands over the message. A hold the agent made is never touched.

Setup, once, on the laptop:

1. console.cloud.google.com -> a project -> **APIs & Services -> Library -> Google Calendar API -> Enable**.
2. **OAuth consent screen**: External, Testing; add the wearer's Google account as a test user.
3. **Credentials -> Create credentials -> OAuth client ID -> Desktop app**. Copy the client ID and secret into `backend/.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
4. `cd backend && npm run google:auth` (or `$HOME/.nvm/versions/node/v22.18.0/bin/node node_modules/tsx/dist/cli.mjs scripts/google-auth.ts`). Open the printed URL signed in as the wearer, accept the two scopes (events, free/busy), and paste the printed `GOOGLE_REFRESH_TOKEN=` line into `backend/.env`. Restart the backend.
5. Optional: `GOOGLE_CALENDAR_ID` (default `primary`), `WEARER_HOURS`, `WEARER_WEEKENDS=1`.

Scopes are `calendar.events` and `calendar.freebusy` only: the backend can see when the wearer is busy, not what the events are. The wearer adds the other person to the hold themselves, in Google Calendar, once a time is agreed. Unverified until the first real run: that a Desktop-app client's loopback redirect works on this machine's port 8788 (set `GOOGLE_AUTH_PORT` otherwise), and the refresh token's lifetime while the consent screen is in Testing (Google expires them after 7 days in that state; publish the consent screen to keep one).


## The Cue Journal (shared store for long-horizon agents)

`backend/src/journal.ts`. Every stage appends an entry to `backend/data/journal.local.jsonl` (gitignored, the wearer's own data): `brief` (cards, confidence, decision), `research` (facts kept), `cards_updated`, `debrief`, `transcript` (consented chunks), `recap`, `follow_up`, `schedule`, `coaching`, `goal`. Served behind `JOURNAL_TOKEN` (separate from the device token, `?token=` or Bearer):

- `GET /journal.md?token=…`: Markdown, one `###` section per person (newest first) with cards, facts, debriefs, transcript, follow-up, times; then Coaching; then a Timeline. This is what scheduled CREAO agents read (they fetch URLs natively).
- `GET /api/journal.json`: `{ generatedAt, wearer, people[], entries[] }`. `GET /api/journal/people.json`: the per-person summaries.

Agents on top (specs in `agents/`): **Journal Sync** (hourly, Sheets connector: one row per person in "Cue Connections"), **Network Analyst** (nightly dashboard, trends across periods, open loops), and the **Networking Coach**'s scheduled run can read the same URL. None of them need the backend to start them.

## Three agents, not eight (decision Oct 18, 01:30)

Consolidated by *when they run*. The backend accepts the merged outputs and still accepts the split ones, so the old keys keep working until the new agents exist.

| Agent (spec) | Replaces | Runs when | Env |
|---|---|---|---|
| **Research** (`agents/research.md`) | Event Loader, Person Researcher, Brief Writer | EVENT request from the setup page; PERSON request after a lookup (returns facts + the final cards in one run, no Brief Writer chain) | `CREAO_RESEARCH_KEY`, `CREAO_RESEARCH_ID` |
| **Follow-up** (`agents/follow-up.md`) | Follow-up Writer, Meeting Scheduler | after a spoken debrief (returns email, message, next steps, times, hold, Gmail draft in one run) | `CREAO_FOLLOWUP_KEY`, `CREAO_FOLLOWUP_ID` |
| **Coach** (`agents/coach.md`) | Networking Coach, Network Analyst, Journal Sync | "how did I do today?", every third debrief, nightly schedule (reads the journal, syncs the sheet, dashboard, coaching) | `CREAO_COACH_KEY`, `CREAO_COACH_ID` |

When `CREAO_RESEARCH_*` is set, the Brief Writer chain is off (the Research agent returns cards); when `CREAO_FOLLOWUP_*` is set, the Scheduler chain is off (the Follow-up agent returns the schedule). The friend's "Connection Research" agent is retired; its sheet becomes the Coach's "Cue Connections".
