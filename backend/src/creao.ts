// CREAO slow path (01 section 8, 03 section 7, design/creao-api-notes.md).
// Developer Platform /v2 only (project key, USD wallet). /v1 (CLI Account keys, credits) is not used.
// - startRun(): POST /v2/runs when CREAO_API_KEY (a /v2 project key) and the hosted agent id are set,
//   else a no-op (returns null). Agent ids must be /v2 hosted agents on this project; agent.creao.ai
//   (C-end) agent ids are AGENT_NOT_FOUND on /v2.
// - Completion: webhook (creaoRouter) or the 15 s poller. Both end in finalize(), which re-fetches the
//   run with our key (the webhook has no signature), extracts the JSON, validates it, and applies it.
// - Never on the fast path: callers fire-and-forget, every network call has a timeout, all errors are caught.
import express, { Router } from "express";
import { z } from "zod";
import type { Brief, Card, Organization, Person } from "../../shared/types.js";
import { config } from "./config.js";
import { writeCards, type BriefInput } from "./llm.js";
import { cleanFacts, enforceCards, factAboutPerson, hostOf, sanitize, sortFacts } from "./safety.js";
import { journal } from "./journal.js";
import { sendText } from "./photon.js";
import { availabilityWithCalendar, confirmSchedule } from "./calendar.js";
import { coachBubbles, firstName, followUpBubbles, followUpWave, scheduleBubbles } from "./voice.js";
import { newId, norm, slug, store, type RunRecord } from "./store.js";

export type AgentKind = RunRecord["agent"];

const BASE = (process.env.CREAO_BASE_URL?.trim() || "https://developer.creao.ai").replace(/\/$/, "");
/** Optional exact /v2 catalog id (e.g. "openai/gpt-6-luna"). Unset: the hosted agent's saved default. */
const MODEL = process.env.CREAO_MODEL?.trim() || undefined;
const POLL_EVERY_MS = 15_000;
const GIVE_UP_MS = 15 * 60_000;
const HTTP_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

export interface CreaoRun {
  run_id: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  agent_id: string | null;
  conversation_id: string | null;
  model?: string | null;
  result?: {
    text?: string;
    chat_text?: string;
    blocks?: { type: string; content?: string }[];
    artifacts?: { id?: string; title?: string; type?: string; url?: string }[];
    [k: string]: unknown;
  };
  usage?: { models?: UsageModel[] };   // no credits on /v2; billed in USD from tokens
  error?: { code: string; message?: string };
  created_at?: string;
  started_at?: string | null;
  completed_at?: string | null;
  webhook_delivered_at?: string | null;
}

export interface UsageModel {
  model: string;
  kind: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

/** NL create/edit run (GET /v2/agents/{agent_id}/edits/{run_id}). */
export interface CreaoAgentEdit {
  run_id: string;
  agent_id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  result?: Record<string, unknown>;
  usage?: { models?: UsageModel[] };
  error?: { code: string; message?: string };
}

// USD per 1M tokens [input, output], copied from the Console Dashboard on 2026-10-17. Rates change;
// this is only for logging an estimate. Unknown models -> no estimate.
const USD_PER_MTOK: Record<string, [number, number]> = {
  "anthropic/claude-sonnet-5-5": [2.6, 13],
  "openai/gpt-6-luna": [0.13, 0.65],
  "deepseek/deepseek-v4-flash": [0.286, 0.858],
};

export function usageSummary(run: { usage?: { models?: UsageModel[] } }): { inTok: number; outTok: number; usd: number | null } {
  let inTok = 0, outTok = 0, usd: number | null = 0;
  for (const m of run.usage?.models ?? []) {
    const i = (m.input_tokens ?? 0) + (m.cache_read_tokens ?? 0) + (m.cache_write_tokens ?? 0);
    const o = m.output_tokens ?? 0;
    inTok += i; outTok += o;
    const rate = USD_PER_MTOK[m.model];
    usd = rate && usd !== null ? usd + (i * rate[0] + o * rate[1]) / 1e6 : null;
  }
  return { inTok, outTok, usd };
}

export class CreaoHttpError extends Error {
  constructor(public status: number, public code: string, public retryAfterSec?: number) {
    super(`CREAO ${status} ${code}`);
  }
}

export function agentIdFor(agent: AgentKind): string | undefined {
  const ids = config.creaoAgents;
  return agent === "event_loader" ? ids.eventLoader
    : agent === "person_researcher" ? ids.personResearcher
    : agent === "follow_up_writer" ? ids.followUpWriter
    : agent === "meeting_scheduler" ? ids.meetingScheduler
    : agent === "networking_coach" ? ids.networkingCoach : ids.briefWriter;
}

/** Per-agent app key (capi_). With one, the agent runs through agent.creao.ai's app API. */
export function appKeyFor(agent: AgentKind): string | undefined {
  const k = config.creaoAppKeys;
  return agent === "event_loader" ? k.eventLoader
    : agent === "person_researcher" ? k.personResearcher
    : agent === "follow_up_writer" ? k.followUpWriter
    : agent === "meeting_scheduler" ? k.meetingScheduler
    : agent === "networking_coach" ? k.networkingCoach : k.briefWriter;
}

export function creaoEnabled(agent: AgentKind): boolean {
  return !!agentIdFor(agent) && !!(appKeyFor(agent) || config.creaoKey);
}

// ---- App API (per-agent capi_ keys): POST/GET agent.creao.ai/api/v1/apps/{appId}/runs[/{runId}].
// Runs started here are remembered so getRun() knows which transport (and key) to use.
const APP_BASE = (process.env.CREAO_APP_BASE_URL?.trim() || "https://agent.creao.ai").replace(/\/$/, "");
const appRuns = new Map<string, { appId: string; key: string }>();
interface AppRun {
  id: string; status: CreaoRun["status"]; appId?: string; appName?: string; threadId?: string | null;
  result?: { text?: string; chatText?: string; artifacts?: CreaoRun["result"] extends infer R ? R extends { artifacts?: infer A } ? A : never : never };
  errorCode?: string | null;
}
async function appApi<T>(method: "GET" | "POST", key: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${APP_BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    let code = "HTTP_ERROR";
    try { code = String((JSON.parse(text) as { error?: string; message?: string }).error ?? code); } catch { /* not JSON */ }
    const ra = Number(res.headers.get("retry-after"));
    throw new CreaoHttpError(res.status, code, Number.isFinite(ra) && ra > 0 ? ra : undefined);
  }
  return JSON.parse(text) as T;
}
const fromAppRun = (r: AppRun, appId: string): CreaoRun => ({
  run_id: r.id, status: r.status, agent_id: appId, conversation_id: r.threadId ?? null,
  result: r.result ? { text: r.result.text, chat_text: r.result.chatText, artifacts: r.result.artifacts } : undefined,
  error: r.errorCode ? { code: r.errorCode } : undefined,
});

async function api<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T> {
  if (!config.creaoKey) throw new CreaoHttpError(0, "NO_KEY");
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${config.creaoKey}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    let code = "HTTP_ERROR";
    try { code = String((JSON.parse(text) as { error?: string }).error ?? code); } catch { /* not JSON */ }
    const ra = Number(res.headers.get("retry-after"));
    throw new CreaoHttpError(res.status, code, Number.isFinite(ra) && ra > 0 ? ra : undefined);
  }
  return JSON.parse(text) as T;
}

/** POST /v2/runs (202). Throws CreaoHttpError on non-2xx. Body is closed: only documented fields. */
export async function createRun(agentId: string, input: unknown, webhookUrl?: string, agent?: AgentKind): Promise<CreaoRun> {
  const appKey = agent ? appKeyFor(agent) : undefined;
  if (appKey) {
    const inputs = input && typeof input === "object" ? input : { input };
    const r = await appApi<AppRun>("POST", appKey, `/api/v1/apps/${encodeURIComponent(agentId)}/runs`, { inputs, ...(webhookUrl ? { webhookUrl } : {}) });
    appRuns.set(r.id, { appId: agentId, key: appKey });
    return fromAppRun(r, agentId);
  }
  const body: Record<string, unknown> = { agent_id: agentId, input };
  if (webhookUrl) body.webhook_url = webhookUrl;
  if (MODEL) body.model = MODEL;
  return api<CreaoRun>("POST", "/v2/runs", body);
}

/** GET /v2/runs/{id}. rawOutput=true prefers the full assistant transcript in result. */
export async function getRun(runId: string, rawOutput = false): Promise<CreaoRun> {
  const app = appRuns.get(runId);
  if (app) return fromAppRun(await appApi<AppRun>("GET", app.key, `/api/v1/apps/${encodeURIComponent(app.appId)}/runs/${encodeURIComponent(runId)}`), app.appId);
  return api<CreaoRun>("GET", `/v2/runs/${encodeURIComponent(runId)}${rawOutput ? "?raw_output=true" : ""}`);
}

/** GET /v2/agents: this project's hosted agents only (metadata). */
export async function listAgents(): Promise<{ agents: { agent_id: string; name: string; status: string; version: string }[] }> {
  return api("GET", "/v2/agents?limit=100");
}

/** GET /v2/me: probe the project key. */
export async function getMe(): Promise<{ projectId: string; keyId: string }> {
  return api("GET", "/v2/me");
}

/** POST /v2/agents: natural-language hosted-agent create (202, bills USD). Poll getAgentEdit after. */
export async function createAgent(input: string): Promise<CreaoRun> {
  return api<CreaoRun>("POST", "/v2/agents", { input, ...(MODEL ? { model: MODEL } : {}) });
}

/** GET /v2/agents/{agent_id}/edits/{run_id}: status of an NL create/edit run. */
export async function getAgentEdit(agentId: string, runId: string): Promise<CreaoAgentEdit> {
  return api("GET", `/v2/agents/${encodeURIComponent(agentId)}/edits/${encodeURIComponent(runId)}`);
}

/** GET /v2/agents/{agent_id}: includes skill_content and config_content. */
export async function getAgent(agentId: string): Promise<{ agent_id: string; name: string; skill_content?: string | null; config_content?: string | null }> {
  return api("GET", `/v2/agents/${encodeURIComponent(agentId)}`);
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
export const isTerminal = (s: string): boolean => TERMINAL.has(s);

// ---------------------------------------------------------------------------
// Result extraction. result.text may be a "session summary" JSON or the whole
// transcript (design/creao-api-notes.md section 4), so search everywhere.
// ---------------------------------------------------------------------------

type Shape = (v: unknown) => boolean;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export const SHAPES: Record<AgentKind, Shape> = {
  event_loader: (v) => isObj(v) && Array.isArray(v.organizations),
  person_researcher: (v) => isObj(v) && Array.isArray(v.facts) && typeof v.name === "string",
  brief_writer: (v) => isObj(v) && Array.isArray(v.cards),
  follow_up_writer: (v) => isObj(v) && isObj(v.email) && typeof v.message === "string",
  meeting_scheduler: (v) => isObj(v) && Array.isArray(v.proposedTimes) && typeof v.schedulingMessage === "string",
  networking_coach: (v) => isObj(v) && typeof v.summary === "string" && Array.isArray(v.priorities),
};

/** All top-level {...} substrings with balanced braces (string-aware). */
function braceObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"' && depth > 0) inStr = true;
    else if (ch === "{") { if (depth++ === 0) start = i; }
    else if (ch === "}" && depth > 0 && --depth === 0) out.push(text.slice(start, i + 1));
  }
  return out;
}

/** Find a value matching `shape` inside `v`, descending into objects, arrays and JSON-in-strings. */
function findShaped(v: unknown, shape: Shape, depth = 0): unknown {
  if (depth > 6 || v == null) return null;
  if (shape(v)) return v;
  if (typeof v === "string") return findInText(v, shape, depth + 1);
  if (Array.isArray(v)) {
    for (let i = v.length - 1; i >= 0; i--) { const r = findShaped(v[i], shape, depth + 1); if (r) return r; }
    return null;
  }
  if (isObj(v)) {
    for (const x of Object.values(v)) { const r = findShaped(x, shape, depth + 1); if (r) return r; }
  }
  return null;
}

/** Fenced ```json blocks (last first), then the whole text, then bare {...} objects (last first). */
export function findInText(text: string, shape: Shape, depth = 0): unknown {
  if (!text || depth > 6) return null;
  const tryParse = (s: string): unknown => {
    try { return findShaped(JSON.parse(s.trim()), shape, depth + 1); } catch { return null; }
  };
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]).reverse();
  for (const f of fences) { const r = tryParse(f); if (r) return r; }
  const whole = tryParse(text);
  if (whole) return whole;
  for (const o of braceObjects(text).reverse()) { const r = tryParse(o); if (r) return r; }
  return null;
}

function textsOf(run: CreaoRun): string[] {
  const r = run.result ?? {};
  const blocks = (r.blocks ?? []).filter((b) => b.type === "text" && b.content).map((b) => b.content!).reverse();
  return [r.text, r.chat_text, ...blocks].filter((s): s is string => typeof s === "string" && s.length > 0);
}

async function downloadArtifact(url: string, auth: { origin: string; key: string | undefined }): Promise<string | null> {
  try {
    // Artifact URLs need the key of the transport that ran the agent (the /v2 project key, or the
    // per-agent app key). Send it only to that origin itself, and never to a redirect target.
    const sameOrigin = new URL(url).origin === new URL(auth.origin).origin;
    const first = await fetch(url, {
      headers: sameOrigin && auth.key ? { authorization: `Bearer ${auth.key}` } : {},
      redirect: "manual",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const loc = first.headers.get("location");
    const res = first.status >= 300 && first.status < 400 && loc
      ? await fetch(new URL(loc, url), { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) })
      : first;
    if (!res.ok) return null;
    return (await res.text()).slice(0, 2_000_000);
  } catch { return null; }
}

/** Extract the agent's JSON from a terminal run. May make up to 1 + N(artifacts) extra requests. */
export async function extractResult(run: CreaoRun, agent: AgentKind): Promise<unknown> {
  const shape = SHAPES[agent];
  for (const t of textsOf(run)) { const r = findInText(t, shape); if (r) return r; }
  const inResult = findShaped(run.result, shape);
  if (inResult) return inResult;
  let raw: CreaoRun | null = null;
  try { raw = await getRun(run.run_id, true); } catch { /* fall through */ }
  if (raw) {
    for (const t of textsOf(raw)) { const r = findInText(t, shape); if (r) return r; }
  }
  const arts = (raw ?? run).result?.artifacts ?? [];
  for (const a of arts) {
    const kind = `${a.type ?? ""} ${a.title ?? ""} ${a.id ?? ""}`.toLowerCase();
    if (!a.url || !/json|markdown|text|\.md|\.txt/.test(kind)) continue;
    const app = appRuns.get(run.run_id);
    const body = await downloadArtifact(a.url, app ? { origin: APP_BASE, key: app.key } : { origin: BASE, key: config.creaoKey });
    const r = body ? findInText(body, shape) : null;
    if (r) return r;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Validation of agent output (lenient: bad entries are dropped, not fatal)
// ---------------------------------------------------------------------------

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 3).trimEnd() + "..." : s);

export { cleanFacts }; // moved to safety.ts (also used by store.loadSample); re-exported for creao-test.ts

const EventLoaderOut = z.object({
  organizations: z.array(z.unknown()),
  people: z.array(z.unknown()).default([]),
});
const RawOrg = z.object({
  id: z.string().nullish(),
  name: z.string().min(1),
  aliases: z.array(z.string()).nullish(),
  oneLiner: z.string().nullish(),
  focusNow: z.array(z.unknown()).nullish(),
  eventRole: z.string().nullish(),
  hiring: z.string().nullish(),
  people: z.array(z.string()).nullish(),
});
const RawPersonSeed = z.object({
  name: z.string().min(1),
  orgId: z.string().nullish(),
  org: z.string().nullish(),
  role: z.string().nullish(),
});
const PersonOut = z.object({
  name: z.string(),
  role: z.string().nullish(),
  headline: z.string().nullish(),
  facts: z.array(z.unknown()),
  match: z.enum(["high", "medium", "low"]).catch("low"),
  matchReason: z.string().nullish(),
  // The merged Research agent (agents/research.md) returns the final cards in the same run.
  cards: z.array(z.object({ kind: z.enum(["connect", "context", "angle"]), title: z.string(), body: z.string(), source: z.string().nullish() })).optional(),
  improvesOn: z.string().nullish(),
});
const BriefOut = z.object({
  cards: z.array(z.object({
    kind: z.enum(["connect", "context", "angle"]),
    title: z.string(),
    body: z.string(),
    source: z.string().nullish(),
  }).passthrough()),
  improvesOn: z.string().nullish(),
});

// ---------------------------------------------------------------------------
// Run bookkeeping
// ---------------------------------------------------------------------------

interface RunMeta {
  conversationId: string | null;
  lastStatus: string;
  lastPolledAt: number;
  tokens?: { in: number; out: number };
  usd?: number | null;   // estimate from USD_PER_MTOK; null if a model's rate is unknown
  errorCode?: string;
  outcome?: string;      // short human summary of what the result changed
}
const meta = new Map<string, RunMeta>();
const finalizing = new Set<string>();
let pausedUntil = 0;     // honor Retry-After across the poller and starts

function webhookUrl(): string | undefined {
  return config.publicBaseUrl ? `${config.publicBaseUrl.replace(/\/$/, "")}/webhooks/creao` : undefined;
}

/** Start a CREAO run. Returns the runId, or null if CREAO is not configured or the call failed. */
export async function startRun(
  agent: AgentKind,
  input: unknown,
  link: Pick<RunRecord, "briefId" | "personId" | "eventId"> = {},
): Promise<string | null> {
  const agentId = agentIdFor(agent);
  if (!agentId || !(appKeyFor(agent) || config.creaoKey)) return null;
  if (Date.now() < pausedUntil) {
    console.warn(`[creao] start ${agent} skipped: rate limited for ${Math.ceil((pausedUntil - Date.now()) / 1000)}s more`);
    return null;
  }
  try {
    const run = await createRun(agentId, input, webhookUrl(), agent);
    const runId = run.run_id ?? newId("run");
    store.runs.set(runId, { runId, agent, ...link, status: "pending", startedAt: new Date().toISOString() });
    meta.set(runId, { conversationId: run.conversation_id ?? null, lastStatus: run.status ?? "pending", lastPolledAt: Date.now() });
    ensurePoller();
    console.log(`[creao] started ${agent} run ${runId} conversation=${run.conversation_id ?? "?"} webhook=${webhookUrl() ? "on" : "off (polling only)"}`);
    return runId;
  } catch (err) {
    if (err instanceof CreaoHttpError && err.status === 429) pausedUntil = Date.now() + (err.retryAfterSec ?? 60) * 1000;
    console.warn(`[creao] start ${agent} failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Poller: one loop for all pending runs. Covers lost webhooks and local dev.
// ---------------------------------------------------------------------------

let poller: NodeJS.Timeout | null = null;

function ensurePoller(): void {
  if (poller) return;
  poller = setInterval(() => { void pollOnce(); }, POLL_EVERY_MS);
  poller.unref();
}

async function pollOnce(): Promise<void> {
  const pending = [...store.runs.values()].filter((r) => r.status === "pending");
  if (!pending.length) {
    if (poller) { clearInterval(poller); poller = null; }
    return;
  }
  for (const run of pending) {
    if (Date.now() - Date.parse(run.startedAt) > GIVE_UP_MS) {
      markFailed(run, "TIMEOUT_15_MIN");
      continue;
    }
    if (Date.now() < pausedUntil) return;
    const m = meta.get(run.runId);
    if (m && Date.now() - m.lastPolledAt < POLL_EVERY_MS - 1000) continue;
    await finalize(run.runId, "poll");
  }
}

/**
 * Fetch the run with our key; if terminal, extract + apply the result once.
 * Both the webhook and the poller call this. Safe to call repeatedly.
 */
export async function finalize(runId: string, via: "webhook" | "poll"): Promise<void> {
  const rec = store.runs.get(runId);
  if (!rec || rec.status !== "pending" || finalizing.has(runId)) return;
  finalizing.add(runId);
  try {
    let run: CreaoRun;
    try {
      run = await getRun(runId);
    } catch (err) {
      if (err instanceof CreaoHttpError && err.status === 429) pausedUntil = Date.now() + (err.retryAfterSec ?? 60) * 1000;
      if (err instanceof CreaoHttpError && err.status === 404) { markFailed(rec, "RUN_NOT_FOUND"); return; }
      console.warn(`[creao] get ${runId} (${via}) failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const m = meta.get(runId) ?? { conversationId: run.conversation_id, lastStatus: run.status, lastPolledAt: 0 };
    m.lastPolledAt = Date.now();
    m.lastStatus = run.status;
    m.conversationId = run.conversation_id ?? m.conversationId;
    if (run.usage?.models?.length) {
      const u = usageSummary(run);
      m.tokens = { in: u.inTok, out: u.outTok };
      m.usd = u.usd;
    }
    meta.set(runId, m);
    if (!isTerminal(run.status)) return;

    if (run.status !== "completed") { markFailed(rec, run.error?.code ?? run.status.toUpperCase()); return; }
    const out = await extractResult(run, rec.agent);
    if (!out) {
      // The wearer-facing agents sometimes answer in prose instead of the JSON block. The prose is
      // still worth texting; it just cannot be stored as structured output.
      if (await proseFallback(rec, run)) { rec.status = "completed"; return; }
      markFailed(rec, "NO_JSON_IN_RESULT");
      return;
    }
    rec.status = "completed";
    console.log(`[creao] run ${runId} (${rec.agent}) completed via ${via}, tokens=${m.tokens ? `${m.tokens.in}/${m.tokens.out}` : "?"} usd~${m.usd?.toFixed(4) ?? "?"}`);
    await applyResult(rec, out);
  } catch (err) {
    console.error(`[creao] finalize ${runId} error: ${String(err)}`);
    markFailed(rec, "APPLY_ERROR");
  } finally {
    finalizing.delete(runId);
  }
}

const PROSE_LABEL: Partial<Record<AgentKind, string>> = {
  networking_coach: "coach 🧠", follow_up_writer: "follow-up from CREAO ✍️", meeting_scheduler: "scheduler 📅",
};
async function proseFallback(rec: RunRecord, run: CreaoRun): Promise<boolean> {
  const label = PROSE_LABEL[rec.agent];
  const prose = (run.result?.chat_text ?? "").replace(/\n{3,}/g, "\n\n").trim();
  if (!label || prose.length < 40) return false;
  const r = await sendText([`${label} (no structured output this run)`, prose.slice(0, 1500)]);
  const m = meta.get(rec.runId);
  if (m) m.outcome = `prose only; text ${r.sent ? "sent" : `not sent (${r.reason})`}`;
  console.log(`[creao] ${rec.agent} ${rec.runId}: no JSON block, texted the prose (${prose.length} chars)`);
  return true;
}

function markFailed(rec: RunRecord, code: string): void {
  rec.status = "failed";
  const m = meta.get(rec.runId);
  if (m) m.errorCode = code;
  console.warn(`[creao] run ${rec.runId} (${rec.agent}) failed: ${code}`);
  if (rec.eventId && rec.agent === "event_loader") {
    const ev = store.events.get(rec.eventId);
    // Keep "ready" if hand-written orgs were already loaded (04 B5 fallback).
    if (ev && ev.creaoRunId === rec.runId && ev.loadStatus === "loading") ev.loadStatus = "failed";
  }
  if (rec.briefId && rec.agent === "follow_up_writer") {
    // The gate reads this: failed means the fast writer covers. Only this run's own status, never a newer debrief's.
    const b = store.briefs.get(rec.briefId);
    if (b?.followUp && b.followUp.runId === rec.runId) store.briefs.set(b.id, { ...b, followUp: { ...b.followUp, status: "failed" }, version: b.version + 1 });
  } else if (rec.briefId && (rec.agent === "person_researcher" || rec.agent === "brief_writer")) {
    setSlowPath(rec.briefId, { status: "failed", runId: rec.runId }); // the research chain is what slowPath tracks
  }
}

/** Terminal slow-path change. Bumps version so the app's ?since= poll sees it. */
function setSlowPath(briefId: string, slowPath: Brief["slowPath"], cards?: Card[]): void {
  const b = store.briefs.get(briefId);
  if (!b) return;
  store.briefs.set(b.id, {
    ...b, slowPath, ...(cards ? { cards } : {}),
    version: b.version + 1, updatedAt: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Applying results
// ---------------------------------------------------------------------------

export async function applyResult(rec: RunRecord, out: unknown): Promise<void> {
  const m = meta.get(rec.runId);
  const note = (s: string) => { if (m) m.outcome = s; console.log(`[creao] ${rec.agent} ${rec.runId}: ${s}`); };
  if (rec.agent === "event_loader") { note(applyEventLoader(rec, out)); await notifyEventReady(rec.eventId); }
  else if (rec.agent === "person_researcher") note(await applyPersonResearcher(rec, out));
  else if (rec.agent === "follow_up_writer") note(await applyFollowUpWriter(rec, out));
  else if (rec.agent === "meeting_scheduler") note(await applyMeetingScheduler(rec, out));
  else if (rec.agent === "networking_coach") note(await applyNetworkingCoach(rec, out));
  else note(applyBriefWriter(rec, out));
}

/** An event announced over iMessage: when its pack lands, text who is there and who to talk to first. */
async function notifyEventReady(eventId: string | undefined): Promise<void> {
  const ev = eventId ? store.events.get(eventId) : undefined;
  if (!ev || ev.loadStatus !== "ready" || !ev.sources.some((s) => s.kind === "imessage")) return;
  const orgs = store.eventOrgs(ev.id);
  const { composeEventAnswer } = await import("./compose.js");
  const answer = await composeEventAnswer(`${ev.name} pack just loaded. In 3 short lines: who is there, and who I should talk to first for my goal and why.`);
  const r = await sendText([`your ${ev.name} pack is ready: ${orgs.length} orgs`, ...answer.split("\n").filter(Boolean).slice(0, 3), "say \"look up <name>, <company>\" for anyone and i'll prep you"]);
  console.log(`[creao] event pack texted: ${r.sent ? "sent" : `not sent (${r.reason})`}`);
}

// Follow-up Writer (agents/follow-up-writer.md): email + message + next steps from the brief and the
// wearer's debrief. Stored on the person (same place as the hand-pasted output) and texted to the
// wearer over Photon as the "full follow-up", after the instant Haiku recap.
const ScheduleOut = z.object({
  proposedTimes: z.array(z.string()).max(5),
  inviteTitle: z.string(),
  inviteDescription: z.string(),
  schedulingMessage: z.string(),
  calendarEventCreated: z.boolean().default(false),
  eventLink: z.string().nullable().default(null),
});
const FollowUpOut = z.object({
  email: z.object({ subject: z.string(), body: z.string() }),
  message: z.string(),
  nextSteps: z.array(z.string()).default([]),
  draftLink: z.string().nullable().optional(), // Gmail draft the agent saved (never sent), when it has the connector
  schedule: ScheduleOut.optional(),            // the merged Follow-up agent returns the times too (agents/follow-up.md)
  recap: z.array(z.string()).optional(),       // the agent's own recap bubbles (replaces the instant Haiku recap)
  researchNotes: z.array(z.string()).optional(), // what it looked up after the conversation (journaled, not texted)
});
async function applyFollowUpWriter(rec: RunRecord, out: unknown): Promise<string> {
  const parsed = FollowUpOut.safeParse(out);
  if (!parsed.success) return "invalid shape";
  const d = parsed.data;
  const subject = sanitize(d.email.subject).trim().slice(0, 120);
  const body = d.email.body.trim().slice(0, 2500);
  const message = sanitize(d.message).trim().slice(0, 400);
  const nextSteps = d.nextSteps.map((s) => sanitize(s).trim().slice(0, 160)).filter(Boolean).slice(0, 3);
  const person = rec.personId ? store.people.get(rec.personId) : undefined;
  const written = { agent: "creao-follow-up-writer", agentId: agentIdFor("follow_up_writer"), email: { subject, body }, message, nextSteps, draftLink: d.draftLink ?? null };
  if (person) store.putPerson({ ...person, followUp: { ...(person.followUp ?? {}), ...written } });
  // The brief is the source of truth (a walk-up with no matched person still gets the agent's email).
  { const b = rec.briefId ? store.briefs.get(rec.briefId) : undefined;
    if (b) store.briefs.set(b.id, { ...b, followUp: { ...(b.followUp ?? {}), ...written, status: "ready", runId: rec.runId }, version: b.version + 1, updatedAt: new Date().toISOString() }); }
  // The agent's own recap and research notes go to the journal only; Haiku's instant recap already
  // reached the phone, and the wearer asked for fewer texts, not more.
  const recap = (d.recap ?? []).map((b) => sanitize(b).trim().slice(0, 160)).filter(Boolean).slice(0, 5);
  if (recap.length) {
    const b0 = rec.briefId ? store.briefs.get(rec.briefId) : undefined;
    journal({ type: "recap", briefId: rec.briefId, person: b0?.query, data: { sent: false, bubbles: recap, by: "follow-up agent (journal only)" } });
  }
  const draftLine = d.draftLink && /^https?:\/\//.test(d.draftLink) ? [`saved as a gmail draft too: ${d.draftLink}`] : [];
  let scheduleNote = "";
  let r: Awaited<ReturnType<typeof sendText>>;
  if (d.schedule) {
    // Merged agent: email + times in ONE wave of at most 4 bubbles (voice.ts followUpWave).
    const s = await applySchedule(rec, d.schedule, { quiet: true });
    scheduleNote = `; ${s.note}`;
    // Nothing is texted here: the recap already said "just say email". The wearer asks and gets this
    // (recap.ts: "email" -> the CREAO email, "text" -> the message, "book" -> the times and the hold).
    void followUpWave; r = { sent: false, reason: "stored; texted on request" };
  } else {
    r = await sendText(followUpBubbles({ email: { subject, body }, message, nextSteps }, firstName(person?.name)).concat(draftLine));
  }
  let note = `follow-up stored${person ? ` on ${person.name}` : ""}; text ${r.sent ? "sent" : `not sent (${r.reason})`}`;
  { const b0 = rec.briefId ? store.briefs.get(rec.briefId) : undefined;
    journal({ type: "follow_up", briefId: rec.briefId, person: b0?.query ?? (person ? { name: person.name, org: person.orgId } : undefined),
      data: { subject, body, message, nextSteps, draftLink: d.draftLink ?? null, runId: rec.runId, texted: r.sent, researchNotes: (d.researchNotes ?? []).slice(0, 8) } }); }
  // Orchestration: split agents only (Follow-up Writer -> Meeting Scheduler); the merged agent returned the schedule above.
  if (d.schedule) return note + scheduleNote;
  const brief = rec.briefId ? store.briefs.get(rec.briefId) : undefined;
  if (brief && creaoEnabled("meeting_scheduler")) {
    const p = store.profile;
    const runId = await startRun("meeting_scheduler", {
      person: { name: brief.query.name, role: brief.query.role ?? "", org: brief.query.org },
      followUp: { email: { subject, body }, message, nextSteps },
      debrief: brief.debrief ?? "",
      conversation: (brief.conversation ?? "").slice(0, 6000),
      // The wearer's own words plus the free windows from their Google Calendar when it is connected (calendar.ts).
      wearer: { name: p.name, school: p.school ?? "", availability: await availabilityWithCalendar(p.availability ?? "weekday afternoons"), timezone: config.wearerTimezone },
      eventName: store.events.get(brief.eventId)?.name ?? "",
    }, { briefId: brief.id, personId: rec.personId });
    note += runId ? `; started meeting_scheduler ${runId}` : "; meeting_scheduler start failed";
  }
  return note;
}

// Meeting Scheduler: three proposed times, a scheduling message, and a tentative calendar hold.
// The backend checks the times against the wearer's Google Calendar and places the hold itself
// (calendar.ts); the agent's own hold is kept when it made one. Stored on the person, texted.
async function applyMeetingScheduler(rec: RunRecord, out: unknown): Promise<string> {
  const parsed = ScheduleOut.safeParse(out);
  if (!parsed.success) return "invalid shape";
  return (await applySchedule(rec, parsed.data)).note;
}
async function applySchedule(rec: RunRecord, d: z.infer<typeof ScheduleOut>, opts: { quiet?: boolean } = {}): Promise<{ note: string; schedule: NonNullable<NonNullable<Person["followUp"]>["schedule"]> }> {
  const { schedule, note: calNote } = await confirmSchedule({
    proposedTimes: d.proposedTimes.map((s) => sanitize(s).trim().slice(0, 40)).filter(Boolean).slice(0, 3),
    inviteTitle: sanitize(d.inviteTitle).trim().slice(0, 80),
    inviteDescription: sanitize(d.inviteDescription).trim().slice(0, 500),
    schedulingMessage: sanitize(d.schedulingMessage).trim().slice(0, 400),
    calendarEventCreated: d.calendarEventCreated,
    eventLink: d.eventLink && /^https?:\/\//.test(d.eventLink) ? d.eventLink.slice(0, 300) : null,
    ...(d.calendarEventCreated ? { holdSource: "agent" as const } : {}),
  });
  const person = rec.personId ? store.people.get(rec.personId) : undefined;
  if (person) store.putPerson({ ...person, followUp: { ...(person.followUp ?? {}), schedule } });
  { const b = rec.briefId ? store.briefs.get(rec.briefId) : undefined;
    if (b) store.briefs.set(b.id, { ...b, followUp: { status: "ready", runId: rec.runId, ...(b.followUp ?? {}), schedule }, version: b.version + 1 }); }
  const first = person?.name.split(/\s+/)[0] ?? "them";
  const r = opts.quiet ? { sent: false as const, reason: "sent with the follow-up wave" } : await sendText(scheduleBubbles(schedule, first));
  { const b0 = rec.briefId ? store.briefs.get(rec.briefId) : undefined;
    journal({ type: "schedule", briefId: rec.briefId, person: b0?.query ?? (person ? { name: person.name, org: person.orgId } : undefined), data: { ...schedule, runId: rec.runId, texted: r.sent } }); }
  return { schedule, note: `schedule stored${person ? ` on ${person.name}` : ""}, hold ${schedule.calendarEventCreated ? `created (${schedule.holdSource ?? "agent"})` : "not created"}, ${calNote}; text ${r.sent ? "sent" : `not sent (${r.reason})`}` };
}

// Networking Coach: the long-run agent (agents/networking-coach.md). Texted as a few bubbles.
const CoachOut = z.object({
  summary: z.string(),
  patterns: z.array(z.string()).default([]),
  priorities: z.array(z.object({ name: z.string(), why: z.string().default(""), action: z.string().default("") })).default([]),
  coaching: z.array(z.string()).default([]),
  nextTime: z.string().default(""),
});
export let lastCoaching: (z.infer<typeof CoachOut> & { at: string }) | null = null;
async function applyNetworkingCoach(rec: RunRecord, out: unknown): Promise<string> {
  const parsed = CoachOut.safeParse(out);
  if (!parsed.success) return "invalid shape";
  const d = parsed.data;
  const s = (x: string, n: number) => sanitize(x).trim().slice(0, n);
  lastCoaching = {
    summary: s(d.summary, 500), patterns: d.patterns.map((x) => s(x, 160)).filter(Boolean).slice(0, 4),
    priorities: d.priorities.slice(0, 3).map((p) => ({ name: s(p.name, 60), why: s(p.why, 140), action: s(p.action, 140) })),
    coaching: d.coaching.map((x) => s(x, 180)).filter(Boolean).slice(0, 3), nextTime: s(d.nextTime, 180), at: new Date().toISOString(),
  };
  const c = lastCoaching;
  const r = await sendText(coachBubbles(c));
  journal({ type: "coaching", data: { summary: c.summary, patterns: c.patterns, priorities: c.priorities, coaching: c.coaching, nextTime: c.nextTime, runId: rec.runId, texted: r.sent } });
  return `coaching stored (${c.priorities.length} priorities); text ${r.sent ? "sent" : `not sent (${r.reason})`}`;
}

function resolveOrgId(eventId: string, ref: string | null | undefined): string | null {
  if (!ref) return null;
  const k = norm(ref);
  const hit = store.eventOrgs(eventId).find((o) =>
    norm(o.id) === k || norm(o.name) === k || o.aliases.some((a) => norm(a) === k));
  return hit?.id ?? null;
}

/** Event Loader -> the org store the fast path reads (exact lookup by id/alias). */
export function applyEventLoader(rec: Pick<RunRecord, "eventId">, out: unknown): string {
  const eventId = rec.eventId ?? store.activeEventId;
  const ev = eventId ? store.events.get(eventId) : undefined;
  if (!eventId || !ev) return "no event to apply to";
  const parsed = EventLoaderOut.safeParse(out);
  if (!parsed.success) { ev.loadStatus = ev.loadStatus === "loading" ? "failed" : ev.loadStatus; return "invalid shape"; }

  let orgsApplied = 0, factsKept = 0, peopleApplied = 0;
  for (const raw of parsed.data.organizations) {
    const p = RawOrg.safeParse(raw);
    if (!p.success) continue;
    const o = p.data;
    const id = resolveOrgId(eventId, o.id) ?? resolveOrgId(eventId, o.name) ?? (slug(o.id ?? "") || slug(o.name));
    if (!id) continue;
    const prev = store.getOrg(eventId, id);
    const focusNow = cleanFacts(o.focusNow ?? [], 5, "org_site");
    factsKept += focusNow.length;
    const aliases = [...new Set([...(prev?.aliases ?? []), ...(o.aliases ?? [])]
      .map((a) => sanitize(a).trim()).filter((a) => a && norm(a) !== norm(o.name)))].slice(0, 8);
    const next: Organization = {
      id, eventId,
      name: prev?.name ?? sanitize(o.name).trim(),
      aliases,
      oneLiner: clip(sanitize(o.oneLiner ?? "").trim(), 120) || prev?.oneLiner || "",
      focusNow: focusNow.length ? focusNow : prev?.focusNow ?? [],
      eventRole: o.eventRole?.trim() || prev?.eventRole,
      hiring: o.hiring?.trim() ? clip(sanitize(o.hiring).trim(), 160) : prev?.hiring,
      people: [...new Set([...(prev?.people ?? []), ...(o.people ?? [])])],
    };
    store.putOrg(next);
    orgsApplied++;
  }
  for (const raw of parsed.data.people) {
    const p = RawPersonSeed.safeParse(raw);
    if (!p.success) continue;
    const orgId = resolveOrgId(eventId, p.data.orgId) ?? resolveOrgId(eventId, p.data.org);
    if (!orgId) continue;
    store.upsertPerson(eventId, orgId, sanitize(p.data.name).trim(), {
      ...(p.data.role ? { role: sanitize(p.data.role).trim() } : {}),
      match: "high", matchReason: "on the event list", fromEventList: true,
    });
    const org = store.getOrg(eventId, orgId);
    if (org && !org.people.some((n) => norm(n) === norm(p.data.name))) {
      store.putOrg({ ...org, people: [...org.people, p.data.name] });
    }
    peopleApplied++;
  }
  ev.loadStatus = orgsApplied ? "ready" : (ev.loadStatus === "loading" ? "failed" : ev.loadStatus);
  store.saveEventFile(ev.id);
  return `${orgsApplied} orgs (${factsKept} sourced facts), ${peopleApplied} people -> event ${eventId} ${ev.loadStatus}`;
}

/** The wearer fields we share with CREAO. resumeText stays on our backend. */
function wearerForAgent() {
  const { resumeText: _omit, ...rest } = store.profile;
  return rest;
}

export const orgLabels = (person: Pick<Person, "orgId">, org: Organization | null): string[] =>
  [org?.name ?? "", ...(org?.aliases ?? []), person.orgId].filter(Boolean);
export const orgHosts = (org: Organization | null): string[] =>
  [...new Set((org?.focusNow ?? []).map((f) => hostOf(f.sourceUrl)).filter(Boolean))];

async function applyPersonResearcher(rec: RunRecord, out: unknown): Promise<string> {
  const parsed = PersonOut.safeParse(out);
  const person = rec.personId ? store.people.get(rec.personId) : undefined;
  if (!parsed.success || !person) {
    if (rec.briefId) setSlowPath(rec.briefId, { status: "failed", runId: rec.runId });
    return parsed.success ? "person no longer in store" : "invalid shape";
  }
  const org = store.getOrg(person.eventId, person.orgId) ?? null;
  // Backend re-check (03 section 4): agent facts must be about this person at this org.
  // The fact names the person (full, or first + last) AND the org (label in text/URL, or the org's domain).
  const facts = cleanFacts(parsed.data.facts, 8, "article").filter((f) => factAboutPerson(f, person.name, orgLabels(person, org), orgHosts(org)));
  const agentMatch = facts.length ? parsed.data.match : "low";
  const updated: Person = {
    ...person,
    role: person.role ?? (parsed.data.role ? sanitize(parsed.data.role).trim() : undefined),
    headline: person.headline ?? (parsed.data.headline ? clip(sanitize(parsed.data.headline).trim(), 120) : undefined),
    facts: sortFacts([...facts, ...person.facts]),
    lastResearchedAt: new Date().toISOString(),
  };
  store.putPerson(updated);
  store.saveEventFile(updated.eventId); // researched facts survive a restart
  const summary = `${facts.length} new facts kept, agent match ${agentMatch}`;
  journal({ type: "research", briefId: rec.briefId, person: { name: updated.name, org: org?.name ?? updated.orgId, role: updated.role },
    data: { agent: "person_researcher", runId: rec.runId, kept: facts.length, match: agentMatch, facts: updated.facts.map((f) => ({ text: f.text, sourceUrl: f.sourceUrl })) } });
  if (!rec.briefId) return summary;
  if (!facts.length) { setSlowPath(rec.briefId, { status: "done", runId: rec.runId }); return `${summary}; brief unchanged`; }

  const brief = store.briefs.get(rec.briefId);
  if (!brief) return `${summary}; brief gone`;
  if (brief.match.personId !== person.id) {
    setSlowPath(rec.briefId, { status: "done", runId: rec.runId });
    return `${summary}; brief not updated (wearer changed the person)`;
  }
  const input: BriefInput & { improvesOnHint?: string } = {
    person: { name: updated.name, role: updated.role, headline: updated.headline, facts: updated.facts, match: brief.match.confidence },
    organization: org ? { name: org.name, oneLiner: org.oneLiner, focusNow: org.focusNow, eventRole: org.eventRole, hiring: org.hiring } : null,
    wearer: store.profile,
    goal: store.goal,
    eventName: store.events.get(person.eventId)?.name ?? "",
  };

  // Brief v2 lands now with the fast LLM (seconds), so the wearer sees "updated" as soon as the
  // research arrives. The CREAO Brief Writer, if configured, runs after and overwrites with v3.
  let result: string;
  try {
    const cards = enforceCards(await writeCards(input));
    result = applyCardsV2(rec.briefId, cards, rec.runId, `${summary}; v2 via fast LLM`, rec.personId);
  } catch (err) {
    setSlowPath(rec.briefId, { status: "done", runId: rec.runId });
    result = `${summary}; fast LLM v2 failed (${String(err)})`;
  }
  if (parsed.data.cards?.length) {
    const allowedHosts = [...updated.facts.map((f) => hostOf(f.sourceUrl)), ...orgHosts(org)];
    const cards = enforceCards(parsed.data.cards.map((c) => ({ kind: c.kind, title: c.title, body: c.body, source: c.source ?? null })), { allowedHosts });
    return `${result}; ${applyCardsV2(rec.briefId, cards, rec.runId, `cards from the research agent${parsed.data.improvesOn ? ` (improvesOn: ${parsed.data.improvesOn})` : ""}`, rec.personId)}`;
  }
  if (creaoEnabled("brief_writer")) {
    const runId = await startRun("brief_writer", { ...input, wearer: wearerForAgent() }, { briefId: rec.briefId, personId: person.id });
    if (runId) {
      const b = store.briefs.get(rec.briefId);
      if (b) store.briefs.set(b.id, { ...b, slowPath: { status: "running", runId } });
      result += `; started brief_writer ${runId}`;
    }
  }
  return result;
}

function applyBriefWriter(rec: RunRecord, out: unknown): string {
  if (!rec.briefId) return "no brief linked";
  const parsed = BriefOut.safeParse(out);
  if (!parsed.success) { setSlowPath(rec.briefId, { status: "failed", runId: rec.runId }); return "invalid shape"; }
  // Sources must be hosts of facts we gave the agent (the researched person's facts + org focusNow).
  const person = rec.personId ? store.people.get(rec.personId) : undefined;
  const org = person ? store.getOrg(person.eventId, person.orgId) ?? null : null;
  const allowedHosts = [...(person?.facts ?? []).map((f) => hostOf(f.sourceUrl)), ...orgHosts(org)];
  const cards = enforceCards(
    parsed.data.cards.map((c) => ({ kind: c.kind, title: c.title, body: c.body, source: c.source ?? null })),
    { allowedHosts },
  );
  return applyCardsV2(rec.briefId, cards, rec.runId, `improvesOn: ${parsed.data.improvesOn ?? "-"}`, rec.personId);
}

/**
 * Replace a brief's cards with the slow-path version, if still valid, still the wearer's current brief,
 * and still about the person the run researched (the wearer may have picked "Neither" or someone else since).
 */
function applyCardsV2(briefId: string, cards: Card[], runId: string, why: string, personId?: string): string {
  const brief = store.briefs.get(briefId);
  if (!brief) return `${why}; brief gone`;
  if (personId && brief.match.personId !== personId) {
    setSlowPath(briefId, { status: "done", runId });
    return `${why}; not applied (wearer changed the person)`;
  }
  // The glasses poll the brief they hold by id, so updating an older brief is harmless; the only
  // guard is the person check above (a "latest brief" check dropped real updates on the server).
  const kinds = new Set(brief.cards.map((c) => c.kind));
  const next = brief.cards.map((c) => cards.find((n) => n.kind === c.kind) ?? c);
  const usable = cards.some((c) => kinds.has(c.kind));
  if (!usable) {
    setSlowPath(briefId, { status: "done", runId });
    return `${why}; not applied (no usable cards)`;
  }
  setSlowPath(briefId, { status: "done", runId }, next);
  journal({ type: "cards_updated", briefId, person: brief.query, data: { why, runId, cards: next.map((c) => ({ kind: c.kind, title: c.title, body: c.body })) } });
  return `${why}; brief ${briefId} -> v${store.briefs.get(briefId)!.version}`;
}

// ---------------------------------------------------------------------------
// HTTP: webhook + run list for the setup page / demo. Mount after the /api auth middleware.
// ---------------------------------------------------------------------------

export const creaoRouter = Router();

// No signature (design/creao-api-notes.md section 5): accept only runIds we started, dedupe on
// X-Creao-Delivery-Id (or runId), reply 200 at once, then re-fetch the run with our key
// (the webhook body's artifact urls are empty on /v2 anyway).
creaoRouter.post("/webhooks/creao", express.json({ limit: "2mb" }), (req, res) => {
  const payload = (req.body ?? {}) as Record<string, unknown>;
  const runId = String(payload.runId ?? payload.run_id ?? "");
  const delivery = req.header("x-creao-delivery-id") ?? runId;
  const run = store.runs.get(runId);
  if (!run) {
    console.warn(`[creao] webhook for unknown runId "${runId.slice(0, 64)}" ignored`);
    res.status(200).json({ ok: false, reason: "unknown runId" });
    return;
  }
  if (store.seenDeliveries.has(delivery)) { res.status(200).json({ ok: true, duplicate: true }); return; }
  store.seenDeliveries.add(delivery);
  console.log(`[creao] webhook runId=${runId} agent=${run.agent} status=${String(payload.status ?? "?")}`);
  res.status(200).json({ ok: true });
  setImmediate(() => { void finalize(runId, "webhook"); });
});

creaoRouter.get("/api/creao/runs", (_req, res) => {
  const runs = [...store.runs.values()].reverse().map((r) => {
    const m = meta.get(r.runId);
    return {
      runId: r.runId, agent: r.agent, agentId: agentIdFor(r.agent) ?? null, status: r.status,
      creaoStatus: m?.lastStatus ?? null, conversationId: m?.conversationId ?? null,
      tokens: m?.tokens ?? null, usd: m?.usd ?? null, error: m?.errorCode ?? null, outcome: m?.outcome ?? null,
      startedAt: r.startedAt, briefId: r.briefId ?? null, eventId: r.eventId ?? null,
    };
  });
  res.json({
    enabled: {
      event_loader: creaoEnabled("event_loader"),
      person_researcher: creaoEnabled("person_researcher"),
      brief_writer: creaoEnabled("brief_writer"),
    },
    webhook: webhookUrl() ?? null,
    runs,
  });
});
