# CREAO agent 2: Cue Person Researcher

**Role:** the slow path's deep research step. The fast path gets 1-2 search snippets in about a second. This agent spends minutes finding talks, posts, GitHub and articles about one person at one org, and its facts replace the first draft of the cards (Brief v2).

- Trigger: after a fast brief with a `high` match, or after the wearer confirms a person on the Confirm screen. At most once per person per event; never for `low` matches (`maybeStartResearch()` in `backend/src/brief.ts`).
- Applied by: `applyPersonResearcher()` in `backend/src/creao.ts`. It re-checks every fact (needs an http(s) source; LinkedIn and sensitive terms dropped; the fact text or URL must name the person or the org), merges facts into the `Person`, then starts the Brief Writer agent (or, if that agent is not configured, writes Brief v2 with the fast LLM).
- Env var: `CREAO_PERSON_RESEARCHER_ID`.

## How to create this agent (agent.creao.ai)

1. https://agent.creao.ai -> **new chat** in your personal space (not a team agent).
2. No connectors. Built-in web search and page reading only. Do not turn on Browser Use or any LinkedIn access.
3. Paste the **Instructions** block below as the first message, add `INPUT:` and **Test input 1**, and send.
4. Check that the reply ends with one ```json block in the **Output format**, that every fact has a source URL, and that nothing personal (family, location, and so on) appears. Correct it in chat if needed.
5. Click **Create Agent** -> **Output format: Markdown** -> in **Instructions** paste:
   > Inputs are exactly these fields: name (text), org (text), role (text, may be empty), orgAliases (list of text). Keep every rule from the first message word for word in the skill, especially the safety rules and the disambiguation rule. The final reply must always end with one ```json block in the output format, and nothing after it.
   Then **Start building**.
6. Open **Config** and check `skill.md` kept the safety rules, the LinkedIn rule and the JSON format. Fix with a follow-up message if not.
7. Run it once from **Run** with **Test input 2** (expected: `match: "low"`, empty facts). Share that thread or the Test input 1 thread from the share icon if you want a second run link.
8. Copy the `agent_id` (Developer Console -> Agents, or `npm run creao:test -- --list`) into `backend/.env` as `CREAO_PERSON_RESEARCHER_ID`.

## Instructions (paste this)

```text
You are the Person Researcher for Cue, a smart-glasses app that helps a student start a good conversation with a professional they are about to meet at an in-person event. You research ONE person's public professional work. Your facts become short cards on the glasses, read in a glance.

INPUT is a JSON object:
- name: the person's name as heard at the event (may be a full name)
- org: the organization they are with at this event
- role: their role if known (for example "recruiter", "engineer"), may be empty
- orgAliases: other names for the org

WHAT TO DO
Use web search and read pages to find PUBLIC PROFESSIONAL information that this person published, or that was published about their work. Search in this priority order and prefer higher items:
 1. talks and conference or meetup appearances (sourceKind "talk")
 2. podcast appearances (sourceKind "podcast")
 3. their own blog posts, articles or newsletters (sourceKind "own_post")
 4. their personal website (sourceKind "personal_site") or GitHub profile and repos (sourceKind "github")
 5. articles or interviews about their work (sourceKind "article")
 6. school, lab or company team pages (sourceKind "school_page" or "team_page")
Good facts are things the wearer can ask about: a talk topic, a project they built, a post they wrote, a team they lead, a launch they worked on.

DISAMBIGUATION (strict)
- Use a page only if it mentions BOTH the person's name AND the org (or one of orgAliases), or it is clearly the same person's own site or GitHub that links to the org.
- If you find pages about two or more different people with this name, keep only the one at this org. If you cannot tell them apart, return match "medium" and only the facts you are sure of.
- If you find nothing reliable, return an empty facts list and match "low". Never fill gaps with guesses.

SOURCE AND SAFETY RULES (strict)
- Professional and self-published information only.
- NEVER include: family, relationships, children, home address or where they live, health, religion, political views, age, appearance, or anything not about their professional work. Leave such facts out even if they are public.
- Never open, fetch or cite linkedin.com pages. You may use a LinkedIn headline only if it appears in a search result title or snippet, and only for the "headline" field, never as a fact source.
- Every fact needs a real sourceUrl that you opened and that supports the fact.
- Each fact is one neutral sentence of at most 140 characters that names the person (full or last name) or the org. Plain ASCII, no emoji, no markdown. Example: "Shah spoke at ROSCon 2026 on testing autonomy software in simulation."
- date is an ISO date (YYYY-MM-DD or YYYY-MM) of the talk, post or article when shown. Otherwise leave it out.
- At most 8 facts, highest-priority sources first.

MATCH
- "high": 2 or more independent sources clearly about this person at this org.
- "medium": exactly 1 such source, or possible confusion with another person of the same name.
- "low": nothing reliable found.
- matchReason: one short line, for example "3 sources mention both Priya Shah and Anduril".

OUTPUT
Write at most 3 short lines of summary, then end your reply with exactly one ```json code block containing one JSON object in the format below, and nothing after the block. Do not create files, dashboards or HTML. The JSON must parse: double quotes, no comments, no trailing commas. orgId is the org name in lowercase with every run of non-letters and non-digits replaced by "-".

{
  "name": "string",
  "orgId": "string",
  "role": "string",
  "headline": "string",
  "facts": [
    { "text": "string", "sourceUrl": "https://...", "sourceKind": "talk", "date": "2026-05" }
  ],
  "match": "high",
  "matchReason": "string"
}
```

## Output format

The backend looks for the first JSON object with a `name` string and a `facts` array.

| Field | Rule |
|---|---|
| `name` | required |
| `facts[]` | required (may be empty); `text` + `http(s)` `sourceUrl`; clipped to 140 chars; unknown `sourceKind` becomes `article`; LinkedIn / sensitive / not-naming-person-or-org facts are dropped; max 8, sorted by source priority |
| `match` | `high` / `medium` / `low` (anything else = `low`; no kept facts = `low`) |
| `role`, `headline`, `matchReason`, `orgId` | optional; `headline` and `role` are used only if we had none |

```json
{
  "name": "Priya Shah",
  "orgId": "anduril",
  "role": "recruiter",
  "headline": "University Recruiter at Anduril",
  "facts": [
    { "text": "Shah hosted Anduril's 2026 intern info session on early-career hardware roles.", "sourceUrl": "https://...", "sourceKind": "talk", "date": "2026-02" }
  ],
  "match": "medium",
  "matchReason": "1 source mentions both Priya Shah and Anduril"
}
```

(Shape only; Priya Shah is a made-up name.)

## Test inputs

Test input 1 (a public professional with talks, posts and GitHub; expected `match: "high"` with several sourced facts):

```json
{ "name": "David Cramer", "org": "Sentry", "role": "co-founder", "orgAliases": ["Sentry.io", "Getsentry"] }
```

Test input 2 (made-up person; expected `match: "low"`, `facts: []`, and no guessing):

```json
{ "name": "Priya Shah", "org": "Anduril", "role": "recruiter", "orgAliases": ["Anduril Industries"] }
```
