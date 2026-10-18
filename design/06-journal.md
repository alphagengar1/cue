# 06. The Cue Journal: the record every long-term agent reads

Everything Cue observes about the wearer's networking is appended to one journal. Long-horizon CREAO agents (coaching, speech, skills over time, relationship patterns) read it on their own schedule; they do not need the backend to start them, and they never need a key other than the journal token. This page is the schema. A real sample is in `docs/journal-sample.md`.

## Where

| Form | URL | For |
|---|---|---|
| Markdown | `https://35.164.205.54.sslip.io/journal.md?token=<JOURNAL_TOKEN>` | agents: one `###` section per person, then speech, messages, coaching, timeline |
| JSON | `https://35.164.205.54.sslip.io/api/journal.json?token=<JOURNAL_TOKEN>` | `{ generatedAt, wearer, people[], entries[] }`, every entry below in order |
| People only | `https://35.164.205.54.sslip.io/api/journal/people.json?token=<JOURNAL_TOKEN>` | per-person summaries |

`JOURNAL_TOKEN` is in `backend/.env`. It is read-only and separate from the device token. The file behind it is `backend/data/journal.local.jsonl` (one JSON entry per line, gitignored). Replace the host with `http://localhost:8787` for the laptop backend.

## Entry shape

```json
{ "at": "2026-10-18T08:52:10.113Z", "type": "debrief", "briefId": "brf_…", "person": { "name": "Steve Jobs", "org": "Sentry", "role": "co-founder" }, "data": { … } }
```

`person` is present on everything tied to a conversation. `data` depends on `type`:

| type | when | data |
|---|---|---|
| `say` | every utterance the wearer speaks into the glasses (or types on the setup page), before anything else happens | `text` (verbatim speech-to-text), `intent` (lookup, correction, debrief, goal, recap, coach, quiet, unknown), `confidence` 0-1, `source` ("decisions" model or "rules"), `hadBrief` |
| `brief` | a lookup produced cards | `confidence` (high/medium/low), `eventId`, `goal`, `fallback` (template cards), `cards[]` {kind, title, body}, `decision` {match, goalFit, lead} when the gate ran |
| `research` | the Research agent returned facts | `agent`, `runId`, `kept`, `match`, `facts[]` {text, sourceUrl} |
| `cards_updated` | cards were rewritten from research | `why`, `runId`, `cards[]` |
| `debrief` | the wearer's own spoken note after the conversation | `text` (verbatim) |
| `transcript` | a 20 s chunk of a conversation recorded after on-screen consent | `text` (that chunk), `chars`, `chunk` (1-based index for the brief) |
| `recap` | the instant iMessage recap | `sent`, `chars`, `bubbles[]` (exact texts sent), or `reason` |
| `follow_up` | the Follow-up agent returned | `subject`, `body`, `message`, `nextSteps[]`, `draftLink`, `runId`, `texted` |
| `schedule` | proposed times and the hold | `proposedTimes[]`, `inviteTitle`, `inviteDescription`, `schedulingMessage`, `calendarEventCreated`, `eventLink`, `holdSource`, `runId`, `texted` |
| `coaching` | a Coach run returned | `summary`, `patterns[]`, `priorities[]` {name, why, action}, `coaching[]`, `nextTime`, `runId`, `texted` |
| `goal` | the wearer's goal changed | `goal`, `via` ("spoken" or "setup"), `said` |
| `reply` | the wearer texted Cue on iMessage | `text` (what they sent), `answer[]` (what Cue replied) |

Times are ISO UTC. The wearer's goal vocabulary: `internship`, `cofounder`, `learn`, `teammates_sponsors`, `mentorship`.

## What each long-term agent can get from it

- **Speech and delivery**: every `say` and `debrief` entry is the wearer's verbatim speech with a timestamp. Filler words, length, how often a lookup had to be corrected (`say` with intent `correction`), how debriefs evolve across days.
- **Conversation content** (only when they consented): `transcript` chunks per brief, in order, 20 s each, so pace and talk ratio can be estimated by chunk length and timing.
- **Networking skills over time**: per person, the arc `brief` → `debrief` → `recap` → `follow_up` → `schedule` with timestamps (did they debrief, how fast did the follow-up go out, did they propose times), and `coaching` entries to see whether the advice was taken next time.
- **Patterns about the wearer**: which goals the days serve (`brief.goal`, `goal` entries), which openers (`cards[].title`) preceded a follow-up, which orgs cluster, what the wearer keeps saying in debriefs.
- **Relationship state**: the per-person summary in `/api/journal/people.json` (first met, last activity, follow-up, times, transcript length), plus whatever the agent keeps in its own memory or the Connections sheet (outreach status is a human-set column there).

## Rules for agents reading it

- The journal is the wearer's own data. It may contain other people's names and what they said in a consented conversation; keep everything professional and never write anything private (family, health, politics, home, appearance) into a sheet, a dashboard or a text.
- Never contact anyone from it. The wearer sends things.
- Treat the file as append-only; nothing is ever deleted, so compare by `at`.
