# CREAO agent 1: Cue Event Loader

**Why it matters:** this agent builds the event's organization store, and the live glasses path reads from that store. When the wearer says "Priya, Anduril", the fast path looks up `anduril` in it to get the org one-liner, what the org is focused on now, its hiring programs, and the known attendees. Without this agent's output there is no Context card, no low-confidence fallback card, and no full-name expansion ("Priya" -> "Priya Shah"). The fast path never calls the web for orgs. It only uses what this agent loaded the night before.

- Trigger: `POST /api/events` on our backend (setup page "Load event"), so `startRun("event_loader", ...)` in `backend/src/creao.ts`.
- Applied by: `applyEventLoader()` in `backend/src/creao.ts`, which validates the JSON, drops facts with no source, LinkedIn sources or sensitive terms, and writes `Organization` + seed `Person` records.
- Env var: `CREAO_EVENT_LOADER_ID` = this agent's `agent_id`.

## How to create this agent (agent.creao.ai)

1. Go to https://agent.creao.ai, sign in, and open a **new chat**. Use your personal space. Do not publish the agent to a team: the API key can only run personal agents.
2. No connectors are needed. Built-in web search and page reading are enough. Leave Browser Use off (it is for logged-in sites and we never want LinkedIn).
3. Paste the whole **Instructions** block below as your first message. Then paste **Test input 1** in the same message, under the line `INPUT:`. Send it.
4. Check the reply. It should end with one ```json block that matches the **Output format**, with a source URL on every fact. If not, reply "Follow the output format exactly: end with one ```json block and nothing after it." until it does.
5. Click **Create Agent** in the chat input bar. Set **Output format: Markdown**. In the **Instructions** box paste:
   > Inputs are exactly these fields: eventId (text), eventName (text), orgs (list of text), people (list of objects with name, org, role), sourceText (long text). Keep every rule from the first message word for word in the skill. The final reply must always end with one ```json block in the output format, and nothing after it.
   Click **Start building**.
6. When it is built, open the agent and go to **Config**. Check that `skill.md` still contains the source rules and the JSON format. If something is missing, send a follow-up in the agent's chat: "Update the agent: add this rule word for word: ...". Each follow-up makes a new version.
7. Set **Default model** in the agent sidebar: the default is fine. If you are short on credits, pick the cheapest tier.
8. Run it once from the agent's **Run** button with **Test input 2**. Open that session's thread, click the **share** icon, and copy the public link. That is the "run share link" for the Devpost README.
9. Copy the `agent_id`: Developer Console (https://developer.creao.ai) -> **Agents**, or run `npm run creao:test -- --list` in `backend/`. Put it in `backend/.env` as `CREAO_EVENT_LOADER_ID`.
10. Optional: in the version history click **Share** to copy the install link for the README.

## Instructions (paste this)

```text
You are the Event Loader for Cue, a smart-glasses app that helps a student at an in-person networking event (for example a hackathon or career fair). You build the event's organization briefing pack the night before. A fast app reads your output during the event, so it must be accurate, short, sourced, and valid JSON.

INPUT is a JSON object:
- eventId: string
- eventName: string
- orgs: list of organization names (sponsors, employers, speakers' companies)
- people: optional list of { name, org, role } already known to attend
- sourceText: optional raw text pasted from an employer list, speaker list, schedule or guest export

WHAT TO DO
1. Build the organization list: every name in orgs, plus any organization clearly named as a sponsor, employer or speaker's company in sourceText. Do not drop an input org even if you find little about it.
2. For each organization, use web search and read pages to find:
   - oneLiner: what the organization does, in plain words, at most 120 characters.
   - focusNow: 1 to 5 facts about what it is focused on NOW: recent products, launches, research areas, programs, or hiring programs from the last 12 months. Prefer, in this order: the org's own site, blog, docs, press releases or changelog; then reputable news or tech press.
   - hiring: public internship, new-grad or job programs, in at most 160 characters, only if you found a source. Otherwise leave it out.
   - eventRole: its role at this event if sourceText says (for example "sponsor: agents track", "speaker: 2pm panel"). Otherwise leave it out.
   - aliases: other names people use for it (for example "Anduril Industries" for "Anduril"). Do not repeat the main name.
   - people: names from the input people list or sourceText who belong to this org.
3. Extract every person named in sourceText or the input people list into the top-level people list with name, orgId and role. Do NOT research people. Only copy what the event list says.

SOURCE AND SAFETY RULES (strict)
- Every fact needs a real, working sourceUrl that you opened or saw in search results and that supports the fact. No source, no fact.
- Public, professional information about organizations only.
- Never open or cite linkedin.com pages.
- Never include anything about anyone's family, relationships, home or location, health, religion, politics, age or appearance.
- Do not guess. If you cannot find something, leave the field out or use an empty list. An empty focusNow is better than a wrong one.
- Each fact is one neutral sentence of at most 140 characters, plain ASCII, no emoji, no markdown.
- sourceKind is one of: org_site (the org's own site, blog, docs or press page), article (news or third-party article), talk, podcast, own_post, personal_site, github, school_page, team_page, search_snippet.
- date is an ISO date (YYYY-MM-DD or YYYY-MM) when the source shows one. Otherwise leave it out.

IDS
- Each organization id is its main name in lowercase with every run of non-letters and non-digits replaced by a single "-", and no leading or trailing "-". Examples: "Even Realities" -> "even-realities", "CREAO" -> "creao", "Sentry.io" -> "sentry-io". Use the name as given in the input orgs list when there is one.
- Each person's orgId must be one of your organization ids.

OUTPUT
Write at most 3 short lines of summary, then end your reply with exactly one ```json code block containing one JSON object in the format below, and nothing after the block. Do not create files, dashboards or HTML. The JSON must parse: double quotes, no comments, no trailing commas.

{
  "organizations": [
    {
      "id": "string",
      "name": "string",
      "aliases": ["string"],
      "oneLiner": "string",
      "focusNow": [
        { "text": "string", "sourceUrl": "https://...", "sourceKind": "org_site", "date": "2026-09" }
      ],
      "eventRole": "string",
      "hiring": "string",
      "people": ["string"]
    }
  ],
  "people": [
    { "name": "string", "orgId": "string", "role": "string" }
  ]
}
```

## Output format

The backend accepts this object (zod in `backend/src/creao.ts`). It searches the reply for the first JSON object with an `organizations` array, inside a ```json block or not.

| Field | Rule |
|---|---|
| `organizations[].id` | slug of the name; matched against existing org ids, names and aliases |
| `organizations[].name` | required |
| `organizations[].oneLiner` | <= 120 chars (clipped) |
| `organizations[].focusNow[]` | <= 5; each needs `text` and an `http(s)` `sourceUrl`; LinkedIn and sensitive facts are dropped |
| `organizations[].hiring` | optional, <= 160 chars |
| `organizations[].eventRole`, `aliases`, `people` | optional |
| `people[]` | `{ name, orgId, role }`; `orgId` must match an org, or the person is dropped |

```json
{
  "organizations": [
    {
      "id": "sentry",
      "name": "Sentry",
      "aliases": ["Sentry.io", "Getsentry"],
      "oneLiner": "Application monitoring: error tracking, tracing, logs and session replay for developers.",
      "focusNow": [
        { "text": "Sentry ships an AI debugging agent that suggests root causes and fixes for errors.", "sourceUrl": "https://sentry.io/...", "sourceKind": "org_site", "date": "2026-06" }
      ],
      "eventRole": "sponsor: best use of Sentry",
      "hiring": "Public internship and new-grad engineering roles on its careers page.",
      "people": ["Jordan Lee"]
    }
  ],
  "people": [{ "name": "Jordan Lee", "orgId": "sentry", "role": "developer advocate" }]
}
```

(The values above show the shape only. The agent must find and source its own facts.)

## Test inputs

Test input 1:

```json
{
  "eventId": "lahacks-f26",
  "eventName": "LA Hacks Fall 2026",
  "orgs": ["Even Realities", "CREAO", "Sentry"],
  "people": [],
  "sourceText": "Sponsors and tracks: Even Realities (G2 smart glasses track), CREAO (best use of CREAO agents), Sentry (best use of Sentry)."
}
```

Test input 2 (people come only from sourceText; the agent must not research them):

```json
{
  "eventId": "ucla-fall-career-fair",
  "eventName": "UCLA Engineering Fall Career Fair",
  "orgs": ["Anduril", "Cloudflare"],
  "people": [{ "name": "Priya Shah", "org": "Anduril", "role": "recruiter" }],
  "sourceText": "Employer list: Anduril Industries (table 12, hiring SWE interns), Cloudflare (table 4), Vercel (table 9). Speaker: Alex Kim, Cloudflare, 2pm panel on edge computing."
}
```

Expected for input 2: three organizations (`anduril`, `cloudflare`, `vercel`), each with sourced facts, `eventRole` from the table numbers, and people `Priya Shah -> anduril` and `Alex Kim -> cloudflare` with no researched facts about them. (The two people are made-up test names.)
