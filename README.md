# Cue

Cue is an app for Even Realities G2 smart glasses that gives quiet networking help at in-person events. Hold to talk, say a name, an org and a role ("Priya, Anduril, recruiter"), and three short cards appear on the HUD: **Connect**, **Context** and **Your angle**. Built at LA Hacks Fall 2026.

Public professional info only. No camera, no face recognition, no recording, no LinkedIn scraping.

The design docs in [design/](design/README.md) are the source of truth. Start with [design/README.md](design/README.md).

## Repo layout

```
cue/
  design/      design docs (product, architecture, glasses UX, agents, build plan)
  shared/      types.ts: canonical data types used by app and backend
  app/         glasses app (Vite + TypeScript, Even Hub SDK), runs in the Even Realities phone app
  backend/     Node + Express + TypeScript API: STT, store, search, brief writer, Photon recap
  agents/      prompts for the fast brief writer and the six CREAO agents (Event Loader, Person Researcher, Brief Writer, Follow-up Writer, Meeting Scheduler, Networking Coach)
```

## Run the backend

Needs Node 20.12 or newer.

```bash
cd backend
cp .env.example .env      # fill in keys; any missing key falls back gracefully
npm install
npm run dev               # http://localhost:8787 (tsx watch)
npm run smoke             # in a second terminal: calls /api/state and /api/briefs/text
```

Production: `npm run build && npm start`.

Without keys the backend still works: `/api/briefs/text` returns a template card built from the sample event (`backend/data/sample-event.json`), and `/api/stt` returns `STT_FAILED` saying `DEEPGRAM_API_KEY` is not set.

The fast brief model is Claude Haiku 5.5 (`claude-haiku-5-5`, effort `low`), configurable with `BRIEF_MODEL`.

`OPENAI_API_KEY` enables the two decision-model uses (OpenAI Decisions API, `gpt-6-luna`): intent routing for spoken transcripts (`backend/src/intent.ts`) and the cue gate that checks match, goal fit, lead card and sensitive facts before cards are written (`backend/src/decide.ts`). Both are optional; when the key is unset the rules classifier and code filters run alone.

## Run the glasses app

```bash
cd app
npm install
npm run dev               # Vite dev server on :5173
npm run simulate          # desktop simulator, or:
npx evenhub qr --url http://<your-laptop-ip>:5173   # scan with the Even Realities app
```

The app talks only to the backend (`VITE_BACKEND_URL`, `VITE_DEVICE_TOKEN` in `app/.env`). It holds no API keys.

## On the glasses

The menu is four items: **Talk**, **Last brief**, **Text me a recap**, **Go quiet** (plus **Hardware test** with `?dev`). Everything else is spoken: hold the temple (up to 12 s), say anything, and the transcript goes to `POST /api/say`, where a decision model picks the intent (a plain "name, company, role" is routed by rules without the call; rules are also the fallback).

| You say | What happens |
|---|---|
| "Priya Shah, Anduril, recruiter" | lookup: three cards |
| "Cramer with a C" / "no, it's Priya not Maya" | correction: the last lookup re-runs with the fixed name |
| "he said email him about Seer, they're hiring interns" | debrief: note saved on the brief, recap texted ("★ note saved, recap texted") |
| "I'm looking for a cofounder" | goal: goal set, the angle card is rewritten and shown |
| "text me the recap" | recap: "★ recap texted" |
| "never mind" | back to quiet |
| anything else | one quiet line with a hint |

Misheard names snap to the event list: Deepgram gets the event's names and orgs as keyterms, and the backend accepts a listed attendee within 2 edits ("David Kramer" becomes David Cramer), so a near miss never needs a confirm screen. If the facts match the person but offer nothing for your goal, you get one quiet line instead of cards; the cards stay under Last brief.

Unverified: the spoken intents and the goal-gate quiet line were built Oct 17 late and have not been tested on the glasses yet.

## Sponsors

CREAO agents do the deep work before and after. Before the event, Event Loader -> Person Researcher -> Brief Writer build the org store and the researched facts the glasses' cards are built from. After each conversation, the Follow-up Writer turns the wearer's own 10-second spoken debrief into a follow-up email, a short message and next steps. Claude Haiku 5.5 on our backend handles the two seconds in between (Deepgram STT, Exa search, one Haiku call), and Photon delivers the follow-up to the wearer by iMessage.

Cue uses six CREAO agents, all built on agent.creao.ai. Prompts, inputs, outputs and test inputs are in [agents/](agents/).

| # | Agent | ID | Run share link | Started by | Output |
|---|---|---|---|---|---|
| 1 | Event Loader | `7ed5ac12-fb85-4545-9e4e-abbeaa25db1a` | https://agent.creao.ai/share/aa9e8fec817ba50138997a79b610d5cc | `POST /api/events` from the setup page (and run in the UI before the event) | organizations and known people; `backend/data/creao-career-fair.json`, `backend/data/creao-lahacks-sponsors.json` |
| 2 | Person Researcher | `e496e45b-c8eb-4079-9aff-876071501d67` | https://agent.creao.ai/share/21c460878c2ec3e4eed039a5a327e0e6 | the backend, after a lookup with a `high` match or a confirmed pick | person facts and headline; Brief v2 |
| 3 | Brief Writer | `d5ded73b-03b6-407d-be3e-5d332d6e869a` | https://agent.creao.ai/share/5922c0b96ff6085300d95090eeb4bc58 | the backend, when the Person Researcher run completes | checked three-card Brief v3 with an `improvesOn` note |
| 4 | Follow-up Writer | [FOLLOW-UP WRITER AGENT ID] | [FOLLOW-UP WRITER SHARE LINK] | the backend, when the wearer speaks a debrief | follow-up email, short message, next steps; texted by Photon |
| 5 | Meeting Scheduler | [MEETING SCHEDULER AGENT ID] | [MEETING SCHEDULER SHARE LINK] | the backend, when the Follow-up Writer run completes | three proposed times, a scheduling message, and a tentative 30-minute calendar hold when the agent has a calendar connector; texted by Photon, "reply book to send" |
| 6 | Networking Coach | [NETWORKING COACH AGENT ID] | [NETWORKING COACH SHARE LINK] | the backend, when the wearer asks "how did I do today?" (spoken or texted, intent `coach`) and automatically after every third debrief of the day | day summary, patterns, follow-up priorities, coaching; texted by Photon |

**How CREAO is used.** Every agent is started by the backend over CREAO's per-agent app API: each agent has its own `capi_` key (agent detail page, API tab) in `backend/.env` as `CREAO_<AGENT>_KEY`, and `backend/src/creao.ts` posts the agent's declared inputs to `agent.creao.ai/api/v1/apps/{agentId}/runs`, then takes the result by webhook or polling, validates the JSON block and applies it. Keys never leave the server. The agents are orchestrated in three chains: Person Researcher -> Brief Writer before and during the event (research, then a checked brief); Follow-up Writer -> Meeting Scheduler after each conversation (a draft, then a concrete next step); and the Networking Coach over the whole day, with **extended memory** turned on so it compares today with earlier runs and earlier days. The Meeting Scheduler uses a **calendar connector** (Google Calendar) to place the tentative hold on the wearer's own calendar, with no other attendees. The Follow-up Writer, the Scheduler and the Coach also receive the **conversation transcript** when there is one: the HUD first shows a consent line ("ok if my glasses take notes?"), the wearer taps to confirm, and only then are 20-second chunks transcribed and appended to `brief.conversation`, never logged. The debrief is always the wearer's own voice. No agent ever contacts the other person; Photon texts only the wearer.

Unverified (Oct 17 late): agents 4 to 6 are wired in `backend/src/creao.ts` (`applyFollowUpWriter`, `applyMeetingScheduler`, `applyNetworkingCoach`) but have not yet been run live from the deployed backend; their IDs and share links above are placeholders until the first live run. The Scheduler's calendar hold depends on the connector being available on the agent (`calendarEventCreated` is `false` without it), and the Coach's cross-day memory depends on extended memory being switched on in its settings. The Person Researcher -> Brief Writer chain was run live from the backend on Oct 17 (lookup -> fast cards in 3.4 s -> 6 facts kept -> Brief v2 -> Brief v3). The Event Loader output for this event came from runs in the CREAO UI (the share link above); starting it from the setup page is wired but not yet exercised live.
- Photon (Spectrum iMessage): texts the wearer a recap after a conversation, then the Follow-up Writer's email and message, the Meeting Scheduler's proposed times, and the Networking Coach's summary as each run completes (`backend/src/photon.ts`, `backend/src/recap.ts`, `backend/src/creao.ts`). The debrief is spoken: hold the temple, say what happened, the decision model classifies it as a debrief, the note is saved (`POST /api/briefs/:id/debrief`) and the recap is texted. Haiku writes the texts in a texting voice (`backend/src/compose.ts`), templates are the fallback, and replies "email", "text" and "who did I meet" are answered in the same thread. It only ever messages the wearer, never the person they met: the backend refuses any other number and the Photon project allowlist enforces the same rule. Real end-to-end sends are verified (David Cramer brief, 4 bubbles, 205 chars; see `design/photon-notes.md`). Unverified: the glasses-side debrief has not been tested on hardware yet.
