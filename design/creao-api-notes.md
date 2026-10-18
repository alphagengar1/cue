# CREAO API notes (Developer Platform /v2)

Status: researched Sat Oct 17 2026 from the official `/v2` docs. Owner: backend. Readers: teammates and coding agents.
Every claim below is from the docs listed under "Sources" unless it is marked **Unverified**. Nothing here has been tested against the live API yet (no key, wallet at $0). The docs site is a JS app; the text and the full OpenAPI 3.1 spec are embedded in its bundle (`developer.creao.ai/docs/assets/index-*.js`), and `developer.creao.ai/docs/llms.txt` is the page index.

Run `npm run creao:test -- --me` once a key exists (free), then update this file.

## 1. Which API we use

Only **Developer Platform `/v2`**. Our code no longer calls `/v1`.

| | Developer Platform `/v2` (we use this) | CREAO CLI `/v1` (not used) |
|---|---|---|
| Console | developer.creao.ai | developer.creao.ai/cli (unlisted) |
| Key | **Project key** (Console -> API keys -> current project). Shown once. Max 10 active per project. Looks like `cr_sk_...` too. | Account key `cr_sk_...` |
| Money | **USD wallet**, billed per run from model usage | C-end credits |
| Agents | **Hosted agents on this project** | Personal agent.creao.ai agents |
| Docs | developer.creao.ai/docs | agent.docs.creao.ai (Developer API tab) |

Keys do not cross: a `/v1` key on `/v2` is `401`, and a `/v2` key on `/v1` is `401` ([Isolation], [Authentication]). App-scoped `capi_` keys on `agent.creao.ai/api/v1` are a third, separate product.

Auth: `Authorization: Bearer <project key>`, header only ([Authentication]). Base URL `https://developer.creao.ai`. Probe with `GET /v2/me` -> `{ projectId, keyId }`. Bad/missing/`/v1` key: `401 { "error": "AUTHENTICATION_REQUIRED" }`.

## 2. Agent IDs: agent.creao.ai agents do NOT run on /v2

This is the big change. `/v2` resolves `agent_id` only through **this project's hosted-agent map**. An agent built in the agent.creao.ai UI (C-end) or a CLI personal id returns `404 AGENT_NOT_FOUND` on `/v2` ([Hosted agents], [Errors]). Hosted agents are also hidden the other way: they do not show in agent.creao.ai or `/v1`, and `/v2` threads do not appear in C-end chat, inbox, or files ([Isolation]).

So the UUIDs of our agent.creao.ai agents (e.g. `7ed5ac12-...`) cannot go in `CREAO_*_ID` any more. Options:

1. **Create hosted agents through `/v2`** (what `creao:test -- --create <agent>` does): `POST /v2/agents { input: "<natural-language description>", model? , webhook_url? }` -> `202` with a creation `run_id` (and `agent_id`). Poll `GET /v2/agents/{agent_id}/edits/{run_id}` (status `queued | running | succeeded | failed | cancelled`); the finished run has the new id in `agent_id` and `result.agent_id`. Our script sends the agent's "Instructions (paste this)" block from `agents/*.md`, then prints the agent's `skill_content` check and the env line to paste. This is a model run, so it bills the wallet. Agent writes are limited to 30 per hour.
2. Fix up a hosted agent deterministically: `PATCH /v2/agents/{agent_id}` with `skill_content` (<= 256 KB), `config_content` (<= 128 KB), `name`, `description`, `write_autonomy`, etc. `POST /v2/agents/{agent_id}/edits { instructions }` is the NL edit. Not wired into our code.
3. **General agent:** omit `agent_id` on `POST /v2/runs` and put the instructions in `input`. Not wired into our code (`startRun` still needs an agent id per kind).

`GET /v2/agents` lists hosted agents (metadata; `limit` <= 100). `GET /v2/agents/{id}` adds `skill_content` and `config_content`. Agent ids are UUIDs.

**Unverified:** whether the Console's `/agents` page can create or import hosted agents without the API, and whether a C-end agent can be copied into a project.

## 3. Start a run

```
POST https://developer.creao.ai/v2/runs
Authorization: Bearer <project key>
Content-Type: application/json

{ "agent_id": "<hosted uuid>", "input": { ...any JSON... }, "webhook_url": "https://<backend>/webhooks/creao", "model": "openai/gpt-6-luna" }
```

- Body is closed (`additionalProperties: false`): `agent_id?`, `input` (required, <= 256 KB serialized), `conversation_id?`, `webhook_url?` (<= 2048 chars), `model?` (<= 100 chars). No `workspace_id`, no `should_notify`.
- Response `202`: the Run object `{ run_id, status: "pending", agent_id, conversation_id, model, ... }`.
- `conversation_id` must belong to this project; with `agent_id` it must match or `400 AGENT_MISMATCH`.
- Errors ([Errors]): `400 INVALID_INPUT | INPUT_TOO_LARGE | MODEL_NOT_SUPPORTED | AGENT_MISMATCH`, `401 AUTHENTICATION_REQUIRED`, `404 AGENT_NOT_FOUND | CONVERSATION_NOT_FOUND | RUN_NOT_FOUND`, `429 RATE_LIMITED` (+ `Retry-After`), `503 SERVICE_UNAVAILABLE` (dispatch failed, nothing billed). The docs say "`/v2` does not return credit-balance or insufficient-funds errors". **Unverified:** what a run does with a $0 wallet (the docs say to top up before running workloads).
- `POST /v2/realtime/runs` streams NDJSON (same body minus `webhook_url`). Not used.

## 4. Completion: polling (what we rely on)

```
GET https://developer.creao.ai/v2/runs/{run_id}[?raw_output=true]
```

- `status`: `pending | running | completed | failed | cancelled`. Terminal: `completed`, `failed`, `cancelled` ([Quickstart], OpenAPI `RunStatus`).
- Run object: `run_id, status, agent_id, conversation_id, model, result{...}, usage{models[]}, error{code}, created_at, started_at, completed_at, webhook_delivered_at`. Artifact URLs in `result` are hydrated (signed) on this GET.
- `result` is an open object; `raw_output=true` "prefers the full assistant transcript in `result`". The OpenAPI does not spell out `result` keys. **Unverified:** whether it still has `text`, `chat_text`, `blocks[]`, `artifacts[]` as on `/v1` (the webhook example shows `result.text`). `creao.ts` keeps its search-everywhere extraction (text, `raw_output=true`, blocks, any nested string, JSON/markdown artifacts), so it works either way.
- `GET /v2/runs?status=&limit=&offset=` lists runs. A create/edit run id is `RUN_NOT_FOUND` here.

Our backend polls every 15 s and gives up after 15 min.

## 5. Completion: webhook (optional, needs a public URL)

Set `webhook_url` on `POST /v2/runs` (or `POST /v2/agents`). Payload ([Webhooks]), camelCase unlike the run object:

```json
{ "runId": "...", "status": "completed", "threadId": "...", "conversationId": "...",
  "model": "anthropic/claude-haiku-4-5", "result": { "text": "Done." } }
```

- Failed: `error { code, message }` instead of `result`. Artifact `url`s are empty in the webhook; fetch the run.
- Header `X-Creao-Delivery-Id` (same UUID on every attempt). **No signature** documented. Our handler accepts only `runId`s we started and re-fetches the run with our key.
- Up to 3 attempts; non-2xx, connection error, or > 10 s retries; 3xx counts as failure. At-least-once: dedupe on the delivery id.
- `webhook_url` must be public. Localhost, private, link-local, and metadata targets are rejected at create or skipped at delivery. Local dev relies on polling (we leave `PUBLIC_BASE_URL` unset).

## 6. Money, models, limits

- **Billing** ([Models and pricing]): USD wallet, separate from agent.creao.ai chat credits. "Usage is billed in USD when a run finishes. A failed or cancelled run can still incur a charge if it used models." Rates are on the Console Dashboard only. `usage.models[]` per model: `model, kind (chat | image_analysis | ...), input_tokens, output_tokens, cache_read_tokens, cache_write_tokens`. There is no `credits` field and no USD amount on the run.
- **Model choice:** optional `model` on runs and on agent create/edit, exact catalog id (`claude-sonnet-5-5` without the provider prefix is `MODEL_NOT_SUPPORTED`). If omitted: general agent -> developer default `anthropic/claude-sonnet-5-5`; hosted agent -> the agent's saved default, else the developer default. Our code sends `CREAO_MODEL` when set (read directly from the env in `creao.ts`; not in `config.ts`).
- Current catalog ids (cheap ones first, rates from the Dashboard as of Oct 17 2026, USD per 1M in/out): `openai/gpt-6-luna` ($0.13 / $0.65), `deepseek/deepseek-v4-flash` ($0.286 / $0.858), `anthropic/claude-sonnet-5-5` ($2.60 / $13, default). Also current: `anthropic/claude-haiku-4-5`, `anthropic/claude-fable-5-1`, `anthropic/claude-opus-5-5`, `google/gemini-3.1-pro`, `google/gemini-3.8-flash`, `openai/gpt-6-astra`, `openai/gpt-6.1-sol`, `sakana/fugu-ultra`, `moonshotai/kimi-k3`. `creao.ts` has a 3-entry rate table only to log a USD estimate.
- **Rate limits** ([Rate limits]): reads 30/min, `POST /v2/runs` + realtime 30/min, agent writes (create, patch, NL edit) 30/hour, IP 120/min across the host. `429` with `Retry-After`. Our 15 s poll per pending run counts against reads.
- **Minimum top-up:** not documented. **Unverified.**
- **Web search cost:** the docs do not price tool calls separately; `usage.kind` has no search kind. **Unverified** whether search/page reads cost anything beyond model tokens.

### Rough cost per Person Researcher run (estimate, not measured)

A few searches + page reads is about 8-12 model turns with the context growing as pages are read: roughly 150k-400k input tokens total (less with cache reads) and 5k-10k output.

| Model | Estimate per run |
|---|---|
| `anthropic/claude-sonnet-5-5` (default) | about $0.45-1.20 |
| `deepseek/deepseek-v4-flash` | about $0.05-0.12 |
| `openai/gpt-6-luna` | about $0.02-0.06 |

Replace with real numbers from `creao:test` (it prints tokens and a USD estimate).

## 7. Structured output

No output-schema field on `POST /v2/runs`. Structured output comes from the agent's instructions: the final reply ends with one fenced ```json block, and the backend extracts and validates it (zod). Cheap models may follow the format less reliably; check with `creao:test`.

## 8. Share links

`/v2` runs have no documented share link, and `/v2` threads do not appear in agent.creao.ai chat ([Isolation]). For the Devpost README, a thread share link still has to come from running the same instructions in the agent.creao.ai UI (thread header share icon), which bills chat credits, not the wallet. List the hosted `agent_id`s and `run_id`s from `/v2` separately. **Unverified:** whether the Console shows runs with a link.

## 9. Setup steps (once there is a key and wallet balance)

1. Console -> API keys -> create a project key -> `CREAO_API_KEY` in `backend/.env`. `npm run creao:test -- --me`.
2. Top up the wallet. Optionally set `CREAO_MODEL=openai/gpt-6-luna` (or `deepseek/deepseek-v4-flash`).
3. `npm run creao:test -- --create person_researcher` (and `event_loader`, `brief_writer`). Paste the printed `CREAO_*_ID` lines. Check `skill_content` with `GET /v2/agents/{id}` if the script reports missing output markers.
4. `npm run creao:test -- person_researcher` for one real run; record tokens and USD here.

## Sources

- [llms.txt] (index of /v2 pages): https://developer.creao.ai/docs/llms.txt
- [Home]: https://developer.creao.ai/docs
- [Quickstart]: https://developer.creao.ai/docs/get-started/quickstart
- [Authentication]: https://developer.creao.ai/docs/get-started/authentication
- [Hosted agents]: https://developer.creao.ai/docs/hosted-agents
- [Models and pricing]: https://developer.creao.ai/docs/models-and-pricing
- [Webhooks]: https://developer.creao.ai/docs/operate/webhooks
- [Errors]: https://developer.creao.ai/docs/operate/errors
- [Rate limits]: https://developer.creao.ai/docs/operate/rate-limits
- [Isolation]: https://developer.creao.ai/docs/operate/isolation
- API reference pages: https://developer.creao.ai/docs/v2/me, /docs/v2/runs/create, /docs/v2/runs/get, /docs/v2/agents/create, /docs/v2/agents/edit-get (OpenAPI 3.1 "CREAO Developer Platform" 2.0.0, embedded in the docs bundle)
- `/v1` (CLI) docs, for comparison only: https://docs.creao.ai/llms.txt
