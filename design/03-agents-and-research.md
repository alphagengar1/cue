# 03 - Agents and Research Pipeline

Status: draft, Sat Oct 17 2026. Owner: both teammates. Readers: teammates and coding agents.

## 1. Overview

Cue turns a whispered "Priya, Anduril, recruiter" into three cards. Three logical steps do the work:

| Step | Input | Output | Runs on |
|---|---|---|---|
| Event Loader | Event list (employers, speakers, Luma guests) | `Organization[]` (+ seed `Person[]`) | CREAO, night before |
| Person Researcher | name + org + role | `Person` with sourced facts | Fast: our backend. Slow: CREAO |
| Brief Writer | `Person`, `Organization`, `WearerProfile`, goal | `Brief` (3 cards) | Fast: one LLM call. Slow: CREAO |

There are two paths that run at the same time:

- **Fast path (seconds).** Our backend does STT, one or two Exa searches, a code filter, then one LLM call that writes the cards. This is what the wearer sees first.
- **Slow path (minutes).** Our backend starts CREAO runs (Person Researcher, then Brief Writer). When the webhook arrives, the backend may replace the cards with a better brief.

```mermaid
sequenceDiagram
  participant G as G2 app (WebView)
  participant B as Cue backend
  participant D as Deepgram
  participant X as Exa
  participant L as Fast LLM
  participant C as CREAO
  G->>B: POST /api/stt (raw PCM; backend adds WAV header)
  B->>D: transcribe (keyterms = event names)
  B-->>G: { transcript, query }
  G->>B: POST /api/briefs/text { text }
  B->>B: parse name/org/role, look up Organization
  B->>X: search "name org" (fast) x2 parallel
  B->>B: filter results (must mention name AND org)
  B->>L: one call -> Brief JSON
  B-->>G: Brief v1 (cards)
  B->>C: POST /v1/runs Person Researcher (webhook_url, high/confirmed only)
  C-->>B: webhook (Person JSON)
  B->>C: POST /v1/runs Brief Writer (webhook_url)
  C-->>B: webhook (Brief JSON)
  B-->>G: Brief v2 (if better), app shows "updated"
```

All API keys (Deepgram, Exa, LLM, CREAO) live on the backend only. The G2 app only talks to our backend origin, which is the single entry in the `app.json` network whitelist.

## 2. Data shapes

The canonical TypeScript types (`Fact`, `SourceKind`, `Organization`, `Person`, `WearerProfile`, `Goal`, `Card`, `Brief`) are defined once in 01 section 5 and in `shared/types.ts`. Do not redefine them here. The agent output schemas in the prompts below are subsets of those types; the backend adds `id`, `eventId`, `version`, `query`, `slowPath`, and timestamps.

Key fields this doc relies on:

- `Fact { text (<= 140 chars), sourceUrl, sourceKind, date? }`
- `Organization { id (slug), name, aliases, oneLiner, focusNow: Fact[], eventRole?, hiring?, people }`
- `Person { name, orgId, role?, headline?, facts: Fact[] (max 8), match, matchReason }`
- `Card { kind: "connect" | "context" | "angle", title (<= 20), body (<= 200, <= 5 lines of <= 40), source: string | null }`
- `Brief.match { personId, confidence, candidates }`. Medium confidence means the app shows the Confirm screen.

Card limits come from the display: a full-screen text container holds about 400-500 characters, and the font drops unsupported glyphs. The body container is 5 lines of about 40 characters (02 section 2), so 200 characters is the hard cap.

## 3. Event Loader

**When:** the night before, or when the wearer clicks "Load event" on the setup page (`POST /api/events`). Runs on CREAO (it can take minutes).

**Input:**
```json
{ "eventId": "lahacks-f26", "eventName": "LA Hacks Fall 2026",
  "orgs": ["Anduril", "Even Realities", "CREAO"],
  "people": [{"name": "Priya Shah", "org": "Anduril", "role": "recruiter"}],
  "sourceText": "<pasted employer list / speaker list / Luma guest export>" }
```

**Output:** JSON `{ "organizations": Organization[], "people": Person[] }`. The backend stores this in its small event store (exact lookup by org id and alias). People entries are seeds for the Person Researcher.

**Draft CREAO agent instructions (Event Loader):**

> You prepare an event briefing pack for a student attending an in-person networking event. Input is JSON with an event name, a list of organizations, an optional list of people, and optional raw text from an employer or guest list.
> For each organization: use web search to find its official site and 1-5 recent public facts about what it is focused on now (products, launches, research areas, hiring programs). Prefer the org's own site, blog, press releases, and reputable news from the last 12 months.
> Extract any people named in the raw text into the people list with name, org and role. Do not research people in depth.
> Rules: public professional information only. Every fact must have a source URL. LinkedIn professional sections are allowed as sources. If you cannot find something, leave the field empty rather than guess.
> Output ONLY a JSON object matching this schema: `{ organizations: [{ id, name, aliases, oneLiner, focusNow: [{text, sourceUrl, sourceKind, date}], eventRole, hiring, people }], people: [{ name, orgId, role }] }`. `id` is a lowercase slug of the name.

The backend validates the result against the schema (e.g. with zod) and drops invalid entries.

## 4. Person Researcher

**Input:** `{ name, org, role?, orgAliases[] }`.

**Source priority** (highest first). Facts are sorted by this order, and the cards prefer the highest available:

1. Talks and podcasts they appeared on
2. Their own posts and blogs
3. Personal site or GitHub
4. Articles about them
5. School or team pages (e.g. org team page, lab page)

LinkedIn headline, role, experience, projects and publications may be used (Oct 18 decision); nothing personal, never contact info or connections. `ALLOW_LINKEDIN=0` restores the old block.

**Disambiguation rule (enforced in code, not only in the prompt):** a result is kept only if its title or text mentions the person's name AND the org name (or an alias). Match level:

| Kept results | `match` | App behavior |
|---|---|---|
| Stored Person matches name and org, or 2 or more results about one person | `high` | Show 3 cards |
| Exactly 1, or results naming 2+ different full names (fill `candidates`, max 3) | `medium` | Confirm screen first (02 "Confirm person"), then 3 cards |
| 0 | `low` | Show the org Context card only; its body starts "No public info found for <name>." |

If the wearer said only a first name and the store cannot expand it to one full name, `match` is at most `medium` (01 section 5).

### Fast-path implementation (backend, seconds)

- Exa search A: `type: "fast"`, `query: "<name> <org>"`, `numResults: 8`, `contents.highlights` with `maxCharacters` about 500, `excludeDomains: ["linkedin.com"]`.
- Exa search B in parallel: same query and `excludeDomains`, with `category: "personal site"`.
- Exa returns contents inline in the same call, so the only way to avoid pulling LinkedIn page text is `excludeDomains` at search time. Do not use `category: "people"`: it rejects `excludeDomains` and is LinkedIn-heavy. The fast path therefore has no LinkedIn headline; that is fine.
- Apply the disambiguation filter, classify `sourceKind` by URL pattern (youtube/podcast hosts -> talk/podcast, github.com -> github, own domain -> personal_site, etc.), and build `Person`.
- Fallback if Exa fails: Tavily `search_depth: "fast"`, `exclude_domains: ["linkedin.com"]`, `include_raw_content: false`.

Unverified: real Exa `fast` latency on venue wifi. Measure 5 calls of `fast` vs `instant` before choosing.

### Slow-path implementation (CREAO)

**Draft CREAO agent instructions (Person Researcher):**

> You research one professional the user is about to meet at an in-person event. Input JSON: name, org, role, orgAliases.
> Use web search and page fetching to find PUBLIC PROFESSIONAL information that this person published or that was published about their work. Search in this priority order: (1) talks and podcast appearances, (2) their own blog posts or articles, (3) personal website or GitHub, (4) articles or interviews about them, (5) school, lab or company team pages.
> Disambiguation: only use a page if it mentions BOTH the person's name AND the org (or an alias). If pages may be about a different person with the same name, discard them.
> Never include: family, relationships, home address or location, health, religion, political views, or anything not about their professional work. LinkedIn professional sections are allowed; nothing personal from any profile.
> Write each fact as one neutral sentence of at most 140 characters, with its source URL.
> Output ONLY JSON: `{ name, orgId, role, headline, facts: [{text, sourceUrl, sourceKind, date}], match: "high"|"medium"|"low", matchReason }`. At most 8 facts, highest-priority sources first. If you find nothing reliable, return an empty facts array and match "low".

The backend re-runs the disambiguation filter and the safety filter (section 6) on CREAO output. We do not trust the agent alone.

## 5. Brief Writer

**Input:** `{ person: Person, organization: Organization, wearer: WearerProfile, goal: Goal, eventName }`.

**Output:** `{ cards: Card[] }`, which the backend wraps into a `Brief` (01 section 5).

What each card must do:

| Card | Purpose | Example |
|---|---|---|
| Connect | Shared background or interest, a question about their own work, or a past conversation | "Ask about her talk on autonomy testing at ROSCon" |
| Context | Who they are, what they and the org focus on now | "Recruiter, Anduril. Org is hiring for Lattice and hardware intern roles" |
| Your angle | How this conversation serves the wearer's goal, and what to ask for | internship: "Ask if referrals go through her for summer 2027" |

Goal changes card 3 only. Switching goal (`PUT /api/goal`) re-runs the fast LLM call with the same `Person` and `Organization` (no new search), asks for the `angle` card only, and keeps cards 1-2 byte-for-byte, so it is quick and the demo shows only card 3 changing.

### Fast brief LLM call: draft system prompt

> You write a 3-card conversation brief for a student wearing smart glasses at a networking event. The cards appear on a tiny monochrome display and are read in a glance.
> You get JSON with: person (name, role, headline, facts with sources, match), organization (oneLiner, focusNow), wearer (summary, interests, projects, pastConversations), goal, eventName.
> Write exactly three cards:
> 1. connect: one specific opener. Prefer, in order: a past conversation with this person; a real overlap between the wearer's background and the person's work; a question about something the person made, said or wrote.
> 2. context: who they are and what they and their org are focused on now.
> 3. angle: how this conversation serves the wearer's goal ("{goal}") and one concrete thing to ask for.
> Rules: use ONLY facts in the input. Never invent facts, titles or events. Never mention family, home, health, religion or politics. Plain text, no emoji, no markdown. title at most 20 characters. body at most 200 characters, at most 5 lines of at most 40 characters, separated by "\n". source is the bare domain and path of the main fact used, at most 34 characters, with no "src:" prefix, e.g. "youtube.com/@roscon"; it may be null only for the angle card when it uses no person fact. If person.match is "low", return only the context card about the organization and begin its body with "No public info found for {name}." If the organization is also unknown, return only the angle card with a generic ask for the goal.
> Output ONLY JSON: `{ "cards": [{ "kind", "title", "body", "source" }] }`.

The backend wraps the LLM output into a `Brief` (adds `id`, `version`, `query`, `match`, `slowPath`), truncates over-length fields, and strips characters outside ASCII plus the safe glyph list (02 section 2) that the G2 font may drop.

Model: Claude Haiku 5.5 (`claude-haiku-5-5`), set by env `BRIEF_MODEL`, called with the Anthropic TypeScript SDK, `output_config.effort: "low"`, and JSON via structured outputs (`output_config.format`). Adaptive thinking is on by default on this model; no assistant prefill. Unverified: its latency on venue wifi; measure it. The prompt itself is provider-neutral.

### CREAO Brief Writer: draft instructions

Same text as the fast prompt above, with two additions:

> You may use web search to check a fact before using it, but you must not add new facts about the person that are not in the input.
> Also return `"improvesOn": "<one short line on what is better than a basic brief>"`.

The backend sends `Brief v2` to the app only if it validates, passes the safety filter, and the wearer has not already moved on to a new person. The app shows a dim "updated" marker instead of jumping cards mid-conversation.

## 6. Source and safety rules

These rules apply to every path. They are enforced in the prompts AND in backend code.

- **Allowed:** professional and self-published information (talks, posts, sites, GitHub, articles about their work, team pages, org sites).
- **Never:** family, relationships, home or location, health, religion, politics, age, appearance.
- **LinkedIn:** no fetching or scraping. A headline visible in a search result title or snippet is allowed.
- **No face recognition, no recording.** Audio is push-to-talk only and discarded after transcription. The transcript text is stored only as part of its brief (01 section 6) and deleted after the event.
- **Source line:** every `connect` and `context` card carries `source`; such a card with no source is dropped. The `angle` card may have `source: null` when it uses only the wearer's profile and goal.
- **Code filter (backend):** drop any `Fact` whose text matches a blocklist of sensitive terms (e.g. wife, husband, kids, married, address, diagnosis, church, democrat, republican), and drop any fact whose `sourceUrl` host is `linkedin.com`.
- **Low confidence is honest:** with `match: "low"`, the app shows only the org card and says so.

## 7. CREAO integration and requirements

**Triggering.** We create three personal agents in the CREAO UI (chat session, then Create Agent, output format Markdown, paste the instructions above). Then the backend calls the developer API:

```bash
curl -X POST https://developer.creao.ai/v1/runs \
  -H "Authorization: Bearer $CREAO_API_KEY" -H "Content-Type: application/json" \
  -d '{"agent_id":"<PERSON_RESEARCHER_ID>","input":{...},"webhook_url":"https://<backend>/webhooks/creao"}'
```

- Response `202` gives `run_id`. The backend stores `run_id -> {briefRequestId, step}`.
- **Webhook handler:** accept only `runId`s we started (the payload has no signature). Dedupe on `X-Creao-Delivery-Id` or `runId`. Reply 2xx within 10 seconds, then process. Parse `result.text` as JSON (strip code fences if present).
- **Polling fallback:** `GET /v1/runs/{run_id}` every 15 s while the run is pending (covers a lost webhook and local dev without a public URL). Give up after 15 minutes and mark `slowPath.status: "failed"`.
- **Chaining:** Person Researcher completes, then the backend starts Brief Writer with the result.
- **Rate and credits:** 30 requests per minute per account. Free plan is 30 one-time credits plus 5 per day. Per-run cost is not documented, so we read `usage.credits` from the first runs and budget from there. For the demo, run Event Loader once and Person Researcher only for preloaded demo people and confirmed matches, at most once per person per event (01 section 8).

Unverified: whether a developer API key (`cr_sk_`) is available on the free plan. Fallback is the app-scoped trigger (`capi_` key, `inputs` field, `webhookUrl`).

**Why the product needs the agents ("remove the agent and it stops working"):**

- Event Loader builds the org store. Without it, the fast path has no `Organization` record, no Context card, and no low-confidence fallback.
- Person Researcher and Brief Writer produce the deeper, verified brief that replaces the first draft. The fast path is a quick preview of the agents' work.

**README requirements:**

- List each agent with its `agent_id` (copied from the Developer Console Agents page).
- Include a share link: a public read-only chat-thread share link of a real run, and the agent install link from the Share button in version history. Unverified: which format CREAO judges expect. Ask a CREAO mentor.
- Demo: show a CREAO run in progress on the laptop. CREAO runs take minutes and Person Researcher plus Brief Writer is two chained runs, so the `★ updated` marker will usually not land inside a 2-minute demo; also show a completed run from earlier (04 section 9).

## 8. Open questions

1. Which share link format the CREAO judges want (thread link vs agent install link).
2. Credits per CREAO run, and whether the free plan allows developer API keys.
3. End-to-end latency with `claude-haiku-5-5` (target: cards within about 5 s of release).
4. Whether `excludeDomains: ["linkedin.com"]` leaves enough kept results for our demo people (check each with a saved Exa fixture).
5. Whether CREAO `result.text` reliably returns bare JSON, or we need to extract it from Markdown.

## 9. Decision gate (optional)

Status: draft, Sat Oct 17 2026. Code: `backend/src/decide.ts`. Devpost write-up: `agents/decision-gate.md`.

One extra call per brief, between the search filter and the Brief Writer, to the OpenAI Decisions API (`POST /v1/decisions`, model `gpt-6-luna`, public beta). It asks fixed questions over the kept facts and gets calibrated numbers back, which the fast path thresholds in code. The Brief Writer is good at writing cards and bad at saying "no"; this gate is where "no" comes from.

| Question | Type | Returns | Threshold and effect |
|---|---|---|---|
| `match` | predicate | 0-1: facts describe the named person (same name, same org) | below 0.6: treat as `match: "low"`, the "No public info found for <name>." line instead of cards about a stranger |
| `goal_fit` | score, levels 0-2 | 0 not useful, 1 somewhat, 2 strongly useful for the goal | below 0.5: one quiet line instead of three cards |
| `lead` | choice | `connect`, `context` or `angle` | that card shows first |
| `sensitive_<i>` | predicate per fact | 0-1: fact i mentions health, family, religion, politics, legal, home, age or appearance | above 0.5: fact dropped before the Brief Writer sees it |

Rules:

- Optional. Env `OPENAI_API_KEY`; when it is missing the gate returns `null` and the pipeline behaves exactly as in sections 4-6.
- Never throws. Timeout 700 ms (`AbortController`), non-200, unparseable body, missing answer, or a `{type: "refusal"}` answer all return `null`.
- Budget: one request per brief, at most 12 facts, each truncated to 140 characters, so the input stays under about 3k tokens. Input is billed at about $0.10 per 1M tokens.
- Raw `fetch`, no SDK. Tests stub `fetch` and never hit the network (`backend/test/decide.test.ts`).
- It adds to the code filters in section 6, it does not replace them. The blocklist still runs on every fact.

Exported from `backend/src/decide.ts`:

```ts
decide(input: DecideInput, opts?: DecideOptions): Promise<Decision | null>
DecideInput = { query: { name; org; role? }, goal: string, goalNote?: string, facts: { text; sourceUrl }[] }
Decision = { match: number, goalFit: number, lead: "connect" | "context" | "angle", sensitive: number[] }
buildRequest(input): DecisionsRequest      // pure, unit-tested against literal JSON
parseResponse(body, factCount): Decision | null
factsForDecision(facts)                     // the capped, truncated facts; sensitive[i] aligns with this list
```

Unverified: `gpt-6-luna` latency on venue wifi against the 700 ms budget. Measure 5 calls before relying on it in the demo.
