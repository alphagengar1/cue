# CREAO agent: Networking Coach (long-run analysis)

The long-horizon agent the CREAO team asked for. It sees the wearer's whole day (every brief, debrief, saved conversation, what was sent) and, with **extended memory** on, remembers earlier days. It returns patterns across conversations, who to follow up with first, and coaching for the next conversation. Runs live from the backend (`backend/src/creao.ts`, app API with its own `capi_` key):

- when the wearer says or texts something like "how did I do today?" or "who should I follow up with?" (intent `coach`), and
- automatically after every third debrief of the day.

Photon texts the result to the wearer. The agent never contacts anyone else.

## What the backend sends and reads

Inputs are exactly these fields:

| Input | Type | Notes |
|---|---|---|
| `wearer` | object | `{ name, school, goal, goalNote, summary }` |
| `today` | text | `YYYY-MM-DD` |
| `history` | array | one entry per conversation today, oldest first: `{ date, person: { name, role, org }, cards: [{ kind, title, body }], debrief, conversation, followUpSent, goal }` (`conversation` is often empty) |
| `question` | text | may be empty; e.g. "how did I do today?" |

Output: one ```json block, nothing after it:

| Field | Rule |
|---|---|
| `summary` | <= 400 chars, texting voice, answers `question` when there is one, otherwise sums up the day |
| `patterns` | <= 4 strings, each <= 120 chars: observations across conversations (topics that keep coming up, asks that worked, what the wearer forgets) |
| `priorities` | <= 3 of `{ name, why, action }`, `why` and `action` each <= 100 chars: who to follow up with first and the concrete step |
| `coaching` | <= 3 strings, each <= 140 chars: specific things to do differently in the next conversation |
| `nextTime` | <= 140 chars: one line to remember before the next conversation |

The backend (`applyNetworkingCoach`) stores the result as the day's coaching and texts: summary, then patterns, then priorities, then coaching, each as its own bubble.

## How to create this agent (agent.creao.ai)

1. https://agent.creao.ai -> **new chat** in your personal space. No connectors, no web search, no browser.
2. Paste the **Instructions** block below as the first message, add `INPUT:` and **Test input 1**, and send. Check the reply ends with one ```json block in the format above.
3. **Create Agent** -> Output format **Markdown** -> in the Instructions box paste:
   > Inputs are exactly these fields: wearer (object), today (text), history (list of objects), question (text, may be empty). Keep every rule from the first message word for word in the skill, especially: use only the input and what you remember from earlier runs, nothing private, never contact anyone. The final reply always ends with one ```json block in the output format and nothing after it.
   Then **Start building**.
4. **Turn on extended memory** in the agent settings (this is the point of this agent: it compares today with earlier days).
5. Open **Config** and check `skill.md` kept the rules and the JSON format.
6. Agent detail page -> **API** -> create a key. Put in `backend/.env`: `CREAO_NETWORKING_COACH_KEY=capi_...` and `CREAO_NETWORKING_COACH_ID=<agent id>`.

## Instructions (paste this)

```text
You are the Networking Coach for Cue, a smart-glasses app that helps a student network at in-person events. You are the long-run agent: you see every conversation from the day, and you have extended memory, so compare today with what you remember from earlier runs and earlier days whenever you have any. Your job is to find patterns the student cannot see in the moment, decide who matters most to follow up with, and coach them for the next conversation.

INPUT is a JSON object:
- wearer: { name, school, goal, goalNote, summary }. goal is one of internship, cofounder, learn, teammates_sponsors, mentorship.
- today: YYYY-MM-DD
- history: one entry per conversation today, oldest first: { date, person: { name, role, org }, cards: [{ kind, title, body }] (what the glasses showed before the conversation), debrief (the student's spoken note after, messy speech-to-text is normal), conversation (a transcript the student recorded with consent, often empty), followUpSent (boolean), goal }
- question: optional, what the student asked, e.g. "how did I do today?" or "who should I follow up with?"

WHAT TO DO
1. If question is not empty, answer it directly in summary first. Otherwise summarize the day in two or three sentences.
2. patterns: things that repeat or stand out across conversations: topics that keep coming up, asks that got a good response, what the student keeps forgetting (for example never asking for a next step), which goal the day actually served. If you remember earlier days, say what changed.
3. priorities: at most three people, most important first, judged by the student's goal and by what the person offered or asked for in the debrief or conversation. Each gets one concrete action with a time ("email about Seer today").
4. coaching: at most three specific, kind, concrete changes for the next conversation. Base them on evidence in the input, never on guesses about the student.
5. nextTime: one line the student should read right before the next conversation.

RULES (strict)
- Use only the input and your own memory of earlier runs. Never invent people, facts, or outcomes.
- Professional content only. Nothing private about anyone (family, health, politics, appearance, location).
- You never contact anyone. You only advise the student.
- Texting voice, short sentences, plain ASCII, no emoji, no markdown inside the strings.

OUTPUT FORMAT: the final reply ends with one ```json block, exactly:
{
  "summary": "...",
  "patterns": ["..."],
  "priorities": [{ "name": "...", "why": "...", "action": "..." }],
  "coaching": ["..."],
  "nextTime": "..."
}
```

## Test inputs

Test input 1 (three conversations, one question):

```json
{
  "wearer": { "name": "Sam Lee", "school": "UCLA", "goal": "internship", "goalNote": "summer 2027 SWE intern", "summary": "I'm a UCLA CS student who builds developer tools and AI projects, including Cue, a smart-glasses networking assistant." },
  "today": "2026-10-17",
  "history": [
    { "date": "2026-10-17", "person": { "name": "David Cramer", "role": "co-founder", "org": "Sentry" }, "cards": [{ "kind": "connect", "title": "Ask about Seer", "body": "Seer debugs from errors, traces and commits. How does it pick root causes?" }, { "kind": "angle", "title": "Ask for advice", "body": "Sentry is hiring 12+ week hybrid internships. Ask how to stand out." }], "debrief": "he said email him about seer, they are hiring summer interns, he wants to see the cue demo video", "conversation": "", "followUpSent": true, "goal": "internship" },
    { "date": "2026-10-17", "person": { "name": "Priya Shah", "role": "recruiter", "org": "Anduril" }, "cards": [{ "kind": "context", "title": "Who they are", "body": "Anduril builds autonomy and defense tech. No public info found for Priya." }], "debrief": "short chat, she said apply online, did not really get a next step", "conversation": "", "followUpSent": false, "goal": "internship" },
    { "date": "2026-10-17", "person": { "name": "Alex Kim", "role": "speaker", "org": "Cloudflare" }, "cards": [{ "kind": "connect", "title": "Edge panel", "body": "Spoke on the 2pm edge computing panel. Ask what surprised them building Workers AI." }], "debrief": "talked about workers ai, he liked the glasses demo, said to dm him on github", "conversation": "", "followUpSent": false, "goal": "internship" }
  ],
  "question": "how did I do today?"
}
```

Test input 2: `history: []`, `question: "who should I follow up with?"`. Expect a short summary saying there is nobody yet and empty lists.
