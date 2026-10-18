# CREAO API notes

Status: researched Sat Oct 17 2026 from the official docs. Owner: backend. Readers: teammates and coding agents.
Every claim below is from the docs pages listed under "Sources" unless it is marked **Unverified**. Nothing here has been tested against the live API yet (no key at time of writing). Run `npm run creao:test` once keys exist and update this file.

## 1. Which API we use

CREAO has two ways to run an agent from a backend ([API Trigger], [API Paths]):

| | CREAO CLI / Developer API (we use this) | App-scoped API Trigger (fallback) |
|---|---|---|
| Key | Account API key `cr_sk_...`, made in Developer Console (developer.creao.ai, "API Keys"). Shown once. | `capi_...`, made on one agent's detail page in agent.creao.ai |
| Base | `https://developer.creao.ai/v1/*` | `https://agent.creao.ai/api/v1/apps/{appId}/runs` |
| Body | `{ agent_id, input, webhook_url? }` | `{ inputs, webhookUrl? }` |
| Run id field | `run_id` | `id` |

Do not mix the two shapes. Our code uses only the `cr_sk_` path.

Auth: `Authorization: Bearer cr_sk_...` ([Authentication]). A `creao-api-key` query parameter also works but leaks into logs; we do not use it. Missing/bad key returns `401 { "error": "AUTHENTICATION_REQUIRED" }`.

Scope ([Authentication]): a `cr_sk_` key runs **personal** agents owned by the same account. Team, shared, or foreign agents return `404 AGENT_NOT_FOUND` ([Errors], [Update Agent] spec). New accounts get an auto-created team (changelog, Oct 5 2026). **Unverified:** whether an agent created inside that team UI counts as "personal". If `creao:test` returns `AGENT_NOT_FOUND`, check the agent is private/personal, not published to the team.

**Unverified:** whether the Free plan can create `cr_sk_` keys. The docs do not say it is paid-only. If it is blocked, fall back to the `capi_` path (needs a small code change in `creao.ts`: URL, `inputs`, `id`).

## 2. Agent IDs

- Copy from Developer Console -> **Agents** (the `agent_id`, a UUID), or list them: `GET /v1/agents` (metadata only) ([List Agents]). `npm run creao:test -- --list` calls this.
- `GET /v1/agents/{agent_id}` returns `skill_content` (the agent's SKILL.md), `config_content` (config.yaml with the input form) ([Get Agent] in OpenAPI).
- `PATCH /v1/agents/{agent_id}` can replace `skill_content` / `config_content` directly; `POST /v1/agents` creates an agent from a natural-language description ([Create Agent]). We create agents in the UI instead (sponsor asked for agents "built on agent.creao.ai").

## 3. Start a run

```
POST https://developer.creao.ai/v1/runs
Authorization: Bearer cr_sk_...
Content-Type: application/json

{ "agent_id": "<uuid>", "input": { ...any JSON... }, "webhook_url": "https://<backend>/webhooks/creao" }
```

- `input` is any JSON, serialized size <= 256 KB. Over that: `400 INVALID_INPUT` ([Create Async Run]).
- Optional: `model` (default `anthropic/claude-sonnet-5-5`; paid-only ids return `403 MODEL_NOT_ALLOWED`), `conversation_id` (continue a thread), `workspace_id`, `should_notify`. `additionalProperties: false`, so unknown fields are `400 INVALID_INPUT`.
- Response `202`: `{ run_id, status: "pending", agent_id, conversation_id, model }`.
- Errors: `400 INVALID_INPUT | MODEL_NOT_SUPPORTED`, `401 AUTHENTICATION_REQUIRED`, `402 INSUFFICIENT_CREDITS` (with `available`, `required`), `403 ACCOUNT_BLOCKED | MODEL_NOT_ALLOWED`, `404 AGENT_NOT_FOUND | CONVERSATION_NOT_FOUND`, `429 RATE_LIMITED` (+ `Retry-After`), `503 SERVICE_UNAVAILABLE` ([Errors]).
- Agent instructions see `input` as the run's structured input. **Unverified:** exactly how the JSON is shown to the agent (as the form fields from config.yaml, or as raw JSON in the first message). Our agent instructions say "the input is a JSON object with these keys" so either form works.

## 4. Completion: polling

```
GET https://developer.creao.ai/v1/runs/{run_id}[?raw_output=true]
```

- `status`: `pending | running | completed | failed | cancelled`. Terminal: `completed`, `failed`, `cancelled` ([Get Run Status]).
- Completed run: `result.text`, optional `result.chat_text`, `result.blocks[]` (render snapshot, `{type:"text", content}` among others), `result.artifacts[]`, `usage.credits`, `error.code` when failed, timestamps, `webhook_delivered_at`.
- **Important:** `result.text` is "the session summary JSON" when the agent recorded one, otherwise the full assistant transcript. `raw_output=true` swaps in `chat_text` (full transcript). So our JSON may not be in `result.text`. `creao.ts` searches `text`, then `?raw_output=true`, then text blocks, then JSON/markdown artifacts, and accepts the first JSON object with the expected top-level key.
- `GET /v1/runs?status=&limit=&offset=` lists runs ([List Runs]).
- Realtime NDJSON streaming exists (`POST /v1/realtime/runs`) but we do not need it.

## 5. Completion: webhook

Payload for `cr_sk_` runs ([Webhooks]):

```json
{ "runId": "...", "status": "completed", "threadId": "...", "conversationId": "...",
  "model": "anthropic/claude-haiku-4-5", "result": { "text": "Done." } }
```

Failed: same with `"status": "failed", "error": { "code": "EXECUTION_FAILED", "message": "..." }`.

- Headers: `Content-Type: application/json`, `X-Creao-Delivery-Id` (same UUID on every retry).
- **No signature.** Our handler accepts only `runId`s we started, and then re-fetches the run with our key (`GET /v1/runs/{id}`) instead of trusting the body.
- Up to 3 attempts; non-2xx, connection error, or > 10 s counts as failure; redirects are not followed. At-least-once: dedupe on `X-Creao-Delivery-Id` or `runId`.
- `webhook_url` must be a public http(s) URL. Localhost and private IPs are rejected or skipped. Local dev therefore relies on polling.
- A run that fails before it starts (for example out of credits) ends with no webhook ([API Trigger]). Polling covers this.

## 6. Limits and credits

- 30 requests per minute per account across `/v1/*` (polls count), plus 30 writes per hour for agent/workspace/secret/skill writes. IP-level limit too. `429` with `Retry-After` ([Rate Limits]).
- Plans ([llms.txt]): Free = 30 one-time credits + 5 daily bonus credits. Pro $20/mo = 200 credits. Extra credits $0.15 each.
- Per-run cost: not documented. Read `usage.credits` from the first runs (`creao:test` prints it). The docs example shows 2.5 and 12 credits. With ~35 credits on Free, expect only a handful of runs: budget them for the demo.

## 7. Structured output

There is **no** `response_format` / output-schema field on `POST /v1/runs` (OpenAPI `CreateAsyncRunRequest` is closed). Structured output comes only from the agent's instructions. Agents have an output format chosen at creation (Dashboard, Markdown, Html) ([Agents]); pick **Markdown**. Our instructions make the agent end its final reply with one fenced ```json block, and the backend extracts and validates it (zod).

## 8. Share links (for the Devpost README)

- **Thread share link:** any conversation can be shared as a read-only public link from the share icon in the thread header; viewers need no account ([Chat], "Thread sharing"). An agent's **Sessions** tab links to the full chat thread for each run ([Agents]). **Unverified:** whether runs started through `/v1/runs` appear in the Sessions tab with an openable thread. If they do, share that thread; if not, run the agent once from its Run button in the UI and share that thread.
- **Agent install link:** agent version history (or the Share icon on the agent card) -> **Share** copies an install link ([Agents], changelog).
- The sponsor asked for "the agent ID and a run share link". Use the thread share link of a real run as the run link, and list the agent_id. Add the install link too.

## 9. Creating agents in the UI

From [Agents] and the changelog:

1. agent.creao.ai -> new chat. Run the task once successfully (paste instructions + a test input).
2. Click **Create Agent** in the chat input bar. Choose output format **Markdown**. Optionally add instructions. **Start building**.
3. The agent appears on the Agents page with an auto-generated input form, a Config tab (config.yaml + skill.md), a Sessions tab, a Default model picker, and a write-autonomy toggle. Follow-up chat messages create new versions.
4. The changelog mentions a Create Agent button on the empty chat page and a "describe new agent" flow; either path works.

Built-in web search is on every plan ([llms.txt]). Our agents need no connectors.

## Sources

- [llms.txt]: https://docs.creao.ai/llms.txt
- [CLI Quickstart]: https://docs.creao.ai/developer-api/quickstart
- [Authentication]: https://docs.creao.ai/developer-api/authentication
- [Create Async Run]: https://docs.creao.ai/developer-api/runs/create-async-run
- [Get Run Status]: https://docs.creao.ai/developer-api/runs/get-run-status
- [List Runs]: https://docs.creao.ai/developer-api/runs/list-runs
- [Webhooks]: https://docs.creao.ai/developer-api/webhooks
- [Errors]: https://docs.creao.ai/developer-api/errors
- [Rate Limits]: https://docs.creao.ai/developer-api/rate-limits
- [API Paths]: https://docs.creao.ai/developer-api/api-paths
- [API Trigger]: https://docs.creao.ai/pro/api-trigger
- [List Agents]: https://docs.creao.ai/developer-api/agents/list-agents
- [Get Agent] / [Update Agent] / [Create Agent]: https://docs.creao.ai/developer-api/developer-v1.openapi.yaml
- [Agents]: https://docs.creao.ai/features/agents
- [Chat]: https://docs.creao.ai/features/chat
- Changelog: https://docs.creao.ai/community-and-updates/changelog
