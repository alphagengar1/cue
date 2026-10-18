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
    : agent === "person_researcher" ? ids.personResearcher : ids.briefWriter;
}

export function creaoEnabled(agent: AgentKind): boolean {
  return !!(config.creaoKey && agentIdFor(agent));
}

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
export async function createRun(agentId: string, input: unknown, webhookUrl?: string): Promise<CreaoRun> {
  const body: Record<string, unknown> = { agent_id: agentId, input };
  if (webhookUrl) body.webhook_url = webhookUrl;
  if (MODEL) body.model = MODEL;
  return api<CreaoRun>("POST", "/v2/runs", body);
}

/** GET /v2/runs/{id}. rawOutput=true prefers the full assistant transcript in result. */
export async function getRun(runId: string, rawOutput = false): Promise<CreaoRun> {
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

async function downloadArtifact(url: string): Promise<string | null> {
  try {
    // GET /v2/runs hydrates artifact URLs (signed). Send our key only to the CREAO origin itself,
    // and never to a redirect target.
    const sameOrigin = new URL(url).origin === new URL(BASE).origin;
    const first = await fetch(url, {
      headers: sameOrigin ? { authorization: `Bearer ${config.creaoKey}` } : {},
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
    const body = await downloadArtifact(a.url);
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
  if (!config.creaoKey || !agentId) return null;
  if (Date.now() < pausedUntil) {
    console.warn(`[creao] start ${agent} skipped: rate limited for ${Math.ceil((pausedUntil - Date.now()) / 1000)}s more`);
    return null;
  }
  try {
    const run = await createRun(agentId, input, webhookUrl());
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
    if (!out) { markFailed(rec, "NO_JSON_IN_RESULT"); return; }
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
  if (rec.briefId) setSlowPath(rec.briefId, { status: "failed", runId: rec.runId });
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

async function applyResult(rec: RunRecord, out: unknown): Promise<void> {
  const m = meta.get(rec.runId);
  const note = (s: string) => { if (m) m.outcome = s; console.log(`[creao] ${rec.agent} ${rec.runId}: ${s}`); };
  if (rec.agent === "event_loader") note(applyEventLoader(rec, out));
  else if (rec.agent === "person_researcher") note(await applyPersonResearcher(rec, out));
  else note(applyBriefWriter(rec, out));
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
  const summary = `${facts.length} new facts kept, agent match ${agentMatch}`;
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

  // Chain: Brief Writer on CREAO if configured.
  if (creaoEnabled("brief_writer")) {
    const runId = await startRun("brief_writer", { ...input, wearer: wearerForAgent() }, { briefId: rec.briefId, personId: person.id });
    if (runId) {
      const b = store.briefs.get(rec.briefId);
      if (b) store.briefs.set(b.id, { ...b, slowPath: { status: "running", runId } });
      return `${summary}; started brief_writer ${runId}`;
    }
  }
  // Fallback (01 section 8): write Brief v2 with the fast LLM from the researched Person.
  try {
    const cards = enforceCards(await writeCards(input));
    return applyCardsV2(rec.briefId, cards, rec.runId, `${summary}; v2 via fast LLM`, rec.personId);
  } catch (err) {
    setSlowPath(rec.briefId, { status: "done", runId: rec.runId });
    return `${summary}; fast LLM fallback failed (${String(err)})`;
  }
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
  const latest = [...store.briefs.values()].reduce((a, b) => (b.createdAt > a.createdAt ? b : a), brief);
  const kinds = new Set(brief.cards.map((c) => c.kind));
  const next = brief.cards.map((c) => cards.find((n) => n.kind === c.kind) ?? c);
  const usable = cards.some((c) => kinds.has(c.kind));
  if (latest.id !== brief.id || !usable) {
    setSlowPath(briefId, { status: "done", runId });
    return `${why}; not applied (${latest.id !== brief.id ? "wearer moved on" : "no usable cards"})`;
  }
  setSlowPath(briefId, { status: "done", runId }, next);
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
