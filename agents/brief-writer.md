# CREAO agent 3: Cue Brief Writer

**Role:** the last slow-path step. It takes the Person Researcher's facts, the Event Loader's org record and the wearer's profile, and writes the 3 cards the glasses show (Brief v2). The fast path writes a quick first draft. This agent writes the final, checked version, and the glasses show a dim "updated" marker when it arrives.

- Trigger: started by the backend right after a Person Researcher run completes with new facts (`applyPersonResearcher()` in `backend/src/creao.ts`).
- Applied by: `applyBriefWriter()` in `backend/src/creao.ts`. It enforces the card limits and source rules (`enforceCards`: drops connect/context cards with no source and any card with a sensitive term). It applies v2 only if the wearer is still on that brief.
- Optional: if `CREAO_BRIEF_WRITER_ID` is unset, the backend writes v2 with the fast LLM instead. Event Loader and Person Researcher stay on CREAO either way.
- Env var: `CREAO_BRIEF_WRITER_ID`.

## How to create this agent (agent.creao.ai)

1. https://agent.creao.ai -> **new chat** in your personal space (not a team agent).
2. No connectors needed. Web search is allowed only to double-check a fact that is already in the input.
3. Paste the **Instructions** block as the first message, add `INPUT:` and **Test input 1**, and send.
4. Check the cards against the limits (title <= 20 chars, body <= 200 chars and <= 5 lines of <= 40 chars, a source on connect/context). Correct it in chat if needed.
5. **Create Agent** -> **Output format: Markdown** -> in **Instructions** paste:
   > Inputs are exactly these fields: person (object), organization (object or null), wearer (object), goal (text), eventName (text). Keep every rule from the first message word for word in the skill, especially the card length limits and "use ONLY facts in the input". The final reply must always end with one ```json block in the output format, and nothing after it.
   Then **Start building**.
6. Check **Config** -> `skill.md`; fix with a follow-up if a rule was dropped.
7. Run once from **Run** with **Test input 2** (expected: only a `context` card starting "No public info found for Priya Shah.").
8. Copy the `agent_id` into `backend/.env` as `CREAO_BRIEF_WRITER_ID`.

## Instructions (paste this)

```text
You are the Brief Writer for Cue. You write a 3-card conversation brief for a student wearing smart glasses at a networking event. The cards appear on a tiny monochrome display and are read in a glance, mid-conversation.

INPUT is a JSON object:
- person: { name, role, headline, facts: [{ text, sourceUrl, sourceKind, date }], match: "high" | "medium" | "low" }
- organization: { name, oneLiner, focusNow: [facts], eventRole, hiring } or null
- wearer: { name, school, major, summary, interests, projects, goal, goalNote, pastConversations }
- goal: one of internship (land an internship or referral), cofounder (find a cofounder), learn (learn about their field), teammates_sponsors (find teammates, APIs or sponsor help this weekend), mentorship (find a mentor)
- eventName: string

Write exactly three cards:
1. connect: one specific opener. Prefer, in order: a past conversation with this person (wearer.pastConversations); a real overlap between the wearer's background and the person's work; a question about something the person made, said or wrote.
2. context: who they are, and what they and their org are focused on now.
3. angle: how this conversation serves the wearer's goal, and one concrete thing to ask for.

RULES (strict)
- Use ONLY facts in the input. Never invent facts, titles, talks, projects or events. You may use web search to check that a fact in the input is still correct, but you must not add new facts about the person that are not in the input.
- Never mention family, relationships, home or location, health, religion, politics, age or appearance.
- Plain ASCII text. No emoji, no markdown, no bullet symbols.
- title: at most 20 characters.
- body: at most 200 characters, at most 5 lines of at most 40 characters each, lines separated by "\n".
- source: the bare domain and path of the main fact the card uses, at most 34 characters, with no "https://", no "www." and no "src:" prefix, for example "youtube.com/@roscon". connect and context cards must have a source. The angle card may use null only when it uses no person or org fact.
- If person.match is "low": return only the context card, about the organization, and begin its body with "No public info found for <person name>." If the organization is also null, return only the angle card with a generic ask for the goal.
- Also return "improvesOn": one short line on what this brief does better than a basic one (for example "Opener uses her ROSCon talk instead of a generic question").

OUTPUT
End your reply with exactly one ```json code block containing one JSON object in this format, and nothing after the block. Do not create files, dashboards or HTML. The JSON must parse.

{
  "cards": [
    { "kind": "connect", "title": "string", "body": "string", "source": "string" },
    { "kind": "context", "title": "string", "body": "string", "source": "string" },
    { "kind": "angle", "title": "string", "body": "string", "source": null }
  ],
  "improvesOn": "string"
}
```

## Output format

The backend looks for the first JSON object with a `cards` array.

| Field | Rule |
|---|---|
| `cards[].kind` | `connect` / `context` / `angle`; only kinds already on the brief are replaced |
| `cards[].title` | clipped to 20 chars |
| `cards[].body` | re-wrapped to <= 5 lines of <= 40 chars, <= 200 chars |
| `cards[].source` | cleaned to bare domain/path <= 34 chars; connect/context without a source are dropped |
| `improvesOn` | optional, logged |

## Test inputs

Test input 1 (high match; facts are illustrative test data, the agent must only use them, not add to them):

```json
{
  "person": {
    "name": "Jordan Lee", "role": "developer advocate", "headline": "Developer Advocate at Sentry", "match": "high",
    "facts": [
      { "text": "Lee gave a 2026 talk on tracing slow API endpoints with Sentry.", "sourceUrl": "https://youtube.com/watch?v=example", "sourceKind": "talk", "date": "2026-04" },
      { "text": "Lee maintains a sample repo showing Sentry tracing in Express apps.", "sourceUrl": "https://github.com/example/sentry-express-demo", "sourceKind": "github" }
    ]
  },
  "organization": {
    "name": "Sentry", "oneLiner": "Application monitoring: error tracking, tracing, logs and session replay.",
    "focusNow": [{ "text": "Sentry offers tracing, logs and replay alongside error monitoring.", "sourceUrl": "https://sentry.io/welcome/", "sourceKind": "org_site" }],
    "eventRole": "sponsor: best use of Sentry", "hiring": "Engineering internships listed on its careers page."
  },
  "wearer": {
    "name": "Sam", "school": "UCLA", "major": "Computer Science",
    "summary": "CS junior building Cue, a smart-glasses networking app with an Express backend.",
    "interests": ["observability", "wearables"], "projects": ["Cue"], "goal": "internship", "goalNote": "summer 2027 SWE intern"
  },
  "goal": "internship",
  "eventName": "LA Hacks Fall 2026"
}
```

Test input 2 (low match; expected only a `context` card about Anduril that starts "No public info found for Priya Shah."):

```json
{
  "person": { "name": "Priya Shah", "role": "recruiter", "match": "low", "facts": [] },
  "organization": {
    "name": "Anduril", "oneLiner": "Defense technology company building autonomous systems and the Lattice software platform.",
    "focusNow": [{ "text": "Anduril builds Lattice, software that connects sensors and autonomous systems.", "sourceUrl": "https://www.anduril.com/lattice", "sourceKind": "org_site" }],
    "hiring": "Internship and new-grad roles on its careers page."
  },
  "wearer": { "name": "Sam", "summary": "CS junior interested in robotics.", "interests": ["robotics"], "projects": [], "goal": "internship" },
  "goal": "internship",
  "eventName": "UCLA Engineering Fall Career Fair"
}
```
