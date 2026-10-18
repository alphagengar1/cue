// Cue backend: Express app, routes, CORS, auth (01 section 4 and 6).
import { captureError, log, span, spanAttrs } from "./telemetry.js"; // first: Sentry must init before Express loads
import fs from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type {
  BriefResponse, Event, GoalResponse, Organization, StateResponse, SttResponse, WearerProfile,
} from "../../shared/types.js";
import { buildBrief, confirmPerson, regenerateAngle, type BriefOutcome } from "./brief.js";
import { BACKEND_DIR, config } from "./config.js";
import { creaoRouter, startRun } from "./creao.js";
import { CueError, sendError } from "./errors.js";
import { parseTranscript } from "./parse.js";
import { newId, slug, store } from "./store.js";
import { transcribe } from "./stt.js";

store.loadSample();

const app = express();
app.disable("x-powered-by");

// --- CORS (01 section 6): bearer auth, not cookies, so "*" is fine. Log each new Origin once.
const seenOrigins = new Set<string>();
app.use((req, res, next) => {
  const origin = req.headers.origin ?? "(none)";
  if (!seenOrigins.has(origin)) {
    seenOrigins.add(origin);
    console.log(`[cors] new Origin: ${origin}`);
  }
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Audio-Format");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  res.setHeader("Access-Control-Expose-Headers", "X-Cue-Fallback, X-Cue-Notes, Server-Timing");
  res.setHeader("Access-Control-Max-Age", "600");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  next();
});

// --- Auth: one bearer token for /api/*. If DEVICE_TOKEN is unset, auth is off (local dev).
if (!config.deviceToken) console.warn("[auth] DEVICE_TOKEN not set: /api/* is open (dev only)");
const requireToken = (req: Request, res: Response, next: NextFunction) => {
  if (!config.deviceToken) return next();
  if (req.headers.authorization === `Bearer ${config.deviceToken}`) return next();
  sendError(res, 401, "UNAUTHORIZED", "Missing or wrong device token");
};
app.use("/api", requireToken);

// --- Simple per-minute rate limit on lookups (token is extractable from the .ehpk).
const hits: number[] = [];
const rateLimit = (_req: Request, res: Response, next: NextFunction) => {
  const t = Date.now();
  while (hits.length && t - hits[0] > 60_000) hits.shift();
  if (hits.length >= config.lookupsPerMinute) {
    sendError(res, 429, "RATE_LIMITED", "Too many lookups, wait a minute");
    return;
  }
  hits.push(t);
  next();
};

const json = express.json({ limit: "200kb" });
const asyncRoute = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

function sendBrief(res: Response, out: BriefOutcome): void {
  if (out.fallback) res.setHeader("X-Cue-Fallback", "template");
  res.setHeader("X-Cue-Notes", out.notes.join("; ").replace(/[^\x20-\x7e]/g, "").slice(0, 500));
  if (out.timings) {
    res.setHeader("Server-Timing", Object.entries(out.timings).map(([k, v]) => `${k};dur=${v}`).join(", "));
  }
  console.log(`[brief] ${out.brief.id} v${out.brief.version} ${out.brief.match.confidence} cards=${out.brief.cards.length} | ${out.notes.join("; ")}`);
  const body: BriefResponse = { brief: out.brief };
  res.json(body);
}

// --- Schemas
const GoalEnum = z.enum(["internship", "cofounder", "learn", "teammates_sponsors", "mentorship"]);
const FactSchema = z.object({
  text: z.string().max(300),
  sourceUrl: z.string(),
  sourceKind: z.enum(["talk", "podcast", "own_post", "personal_site", "github", "article",
    "school_page", "team_page", "org_site", "search_snippet"]),
  date: z.string().optional(),
});
const ProfileSchema = z.object({
  name: z.string().min(1),
  school: z.string().optional(),
  major: z.string().optional(),
  resumeText: z.string().default(""),
  summary: z.string().default(""),
  interests: z.array(z.string()).default([]),
  projects: z.array(z.string()).default([]),
  goal: GoalEnum,
  goalNote: z.string().optional(),
  pastConversations: z.array(z.object({ personName: z.string(), orgId: z.string(), note: z.string() })).optional(),
});
const EventSchema = z.object({
  name: z.string().min(1),
  date: z.string(),
  orgs: z.array(z.string()).default([]),
  people: z.array(z.object({ name: z.string(), org: z.string(), role: z.string().optional() })).default([]),
  sourceText: z.string().default(""),
  // Extension (04 B5): hand-written Organization records, used when CREAO is down.
  organizations: z.array(z.object({
    name: z.string(), id: z.string().optional(), aliases: z.array(z.string()).default([]),
    oneLiner: z.string().default(""), focusNow: z.array(FactSchema).max(5).default([]),
    eventRole: z.string().optional(), hiring: z.string().optional(), people: z.array(z.string()).default([]),
  })).optional(),
});

function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body);
  if (!r.success) throw new CueError("BAD_REQUEST", z.prettifyError(r.error));
  return r.data;
}

// --- Routes

app.get("/api/state", (_req, res) => {
  const body: StateResponse = {
    event: store.activeEvent(),
    goal: store.goal,
    profile: { name: store.profile.name, school: store.profile.school },
    orgs: store.eventOrgs(),
  };
  res.json(body);
});

app.post(
  "/api/stt",
  rateLimit,
  express.raw({ type: "application/octet-stream", limit: config.maxAudioBytes }),
  asyncRoute(async (req, res) => {
    const pcm = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!Buffer.isBuffer(req.body)) {
      throw new CueError("BAD_REQUEST", "Send raw PCM with Content-Type: application/octet-stream");
    }
    const t0 = Date.now();
    // Span/log carry only sizes and timings: never audio or transcript text (01 section 6).
    const transcript = await span("stt", "ai.stt", async () => {
      const t = await transcribe(pcm, req.header("x-audio-format"));
      spanAttrs({ "cue.transcript_chars": t.length });
      return t;
    }, { "cue.provider": "deepgram", "cue.audio_bytes": pcm.length });
    const sttMs = Date.now() - t0;
    console.log(`[stt] ${pcm.length} bytes -> ${sttMs}ms`);
    log.info("stt", { "cue.audio_bytes": pcm.length, "cue.ms.stt": sttMs });
    res.setHeader("Server-Timing", `stt;dur=${sttMs}`);
    const body: SttResponse = { transcript, query: parseTranscript(transcript) };
    res.json(body);
  }),
);

app.post("/api/briefs/text", rateLimit, json, asyncRoute(async (req, res) => {
  const { text } = parseBody(z.object({ text: z.string().trim().min(1).max(300) }), req.body);
  sendBrief(res, await span("lookup total", "cue.brief", () => buildBrief(text)));
}));

// Latest brief (setup page mirror). 204 when there is none yet. Registered before /:id.
app.get("/api/briefs/latest", (_req, res) => {
  const brief = store.latestBrief();
  if (!brief) { res.status(204).end(); return; }
  const body: BriefResponse = { brief };
  res.json(body);
});

app.get("/api/briefs/:id", (req, res) => {
  const brief = store.briefs.get(req.params.id);
  if (!brief) { sendError(res, 404, "NOT_FOUND", `No brief ${req.params.id}`); return; }
  const since = Number(req.query.since);
  if (Number.isFinite(since) && since >= brief.version) { res.status(304).end(); return; }
  const body: BriefResponse = { brief };
  res.json(body);
});

app.post("/api/briefs/:id/confirm", json, asyncRoute(async (req, res) => {
  const { personId } = parseBody(z.object({ personId: z.string().nullable() }), req.body);
  sendBrief(res, await confirmPerson(String(req.params.id), personId));
}));

// 01 says PUT. POST is accepted too so simple clients and curl tests work either way.
const goalHandler = asyncRoute(async (req, res) => {
  const { goal, briefId } = parseBody(z.object({ goal: GoalEnum, briefId: z.string().optional() }), req.body);
  store.goal = goal;
  const body: GoalResponse = { goal };
  if (briefId) {
    const out = await regenerateAngle(briefId);
    if (out.fallback) res.setHeader("X-Cue-Fallback", "template");
    body.brief = out.brief;
  }
  res.json(body);
});
app.put("/api/goal", json, goalHandler);
app.post("/api/goal", json, goalHandler);

const profileHandler = (req: Request, res: Response) => {
  const p = parseBody(ProfileSchema, req.body);
  const profile: WearerProfile = { ...p, id: "me" };
  store.profile = profile;
  res.json({ profile });
};
app.get("/api/profile", (_req, res) => { res.json({ profile: store.profile }); });
app.put("/api/profile", json, profileHandler);
app.post("/api/profile", json, profileHandler);

app.post("/api/events", json, asyncRoute(async (req, res) => {
  const b = parseBody(EventSchema, req.body);
  const id = slug(b.name) || newId("evt");
  const event: Event = {
    id, name: b.name, date: b.date,
    sources: b.sourceText ? [{ kind: "employers", raw: b.sourceText }] : [],
    loadStatus: "empty",
  };
  store.events.set(id, event);
  store.activeEventId = id;

  const orgs: Organization[] = (b.organizations ?? []).map((o) => ({
    ...o, id: o.id ?? slug(o.name), eventId: id,
  }));
  for (const name of b.orgs) {
    if (!orgs.some((o) => o.id === slug(name))) {
      orgs.push({ id: slug(name), eventId: id, name, aliases: [], oneLiner: "", focusNow: [], people: [] });
    }
  }
  for (const o of orgs) store.putOrg(o);
  for (const p of b.people) store.upsertPerson(id, slug(p.org), p.name, { role: p.role, match: "high", matchReason: "on the event list" });
  if (b.organizations?.length) event.loadStatus = "ready";

  const runId = await startRun("event_loader", {
    eventId: id, eventName: b.name, orgs: b.orgs, people: b.people, sourceText: b.sourceText,
  }, { eventId: id });
  if (runId) { event.loadStatus = "loading"; event.creaoRunId = runId; }
  res.json({ event });
}));

// Bundled event files in backend/data (setup page). Loading one keeps the wearer profile and starts no CREAO run.
const DATA_DIR = path.join(BACKEND_DIR, "data");
function bundledFiles(): { file: string; name: string; orgs: number; people: number }[] {
  let names: string[] = [];
  try { names = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".json")); } catch { return []; }
  return names.flatMap((file) => {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), "utf8"));
      if (!j?.event?.id || !Array.isArray(j.organizations)) return [];
      return [{ file, name: String(j.event.name ?? j.event.id), orgs: j.organizations.length, people: (j.people ?? []).length }];
    } catch { return []; }
  });
}
app.get("/api/events/bundled", (_req, res) => { res.json({ files: bundledFiles() }); });
app.post("/api/events/bundled", json, (req, res) => {
  const { file } = parseBody(z.object({ file: z.string() }), req.body);
  if (!bundledFiles().some((f) => f.file === file)) throw new CueError("NOT_FOUND", `No bundled event file ${file}`, 404);
  const event = store.loadSample(path.join(DATA_DIR, file), { withProfile: false });
  log.info("event loaded", { "cue.event": event.id, "cue.source": "bundled", "cue.orgs": store.eventOrgs(event.id).length });
  res.json({ event });
});

app.get("/api/events/:id", (req, res) => {
  const event = store.events.get(req.params.id);
  if (!event) { sendError(res, 404, "NOT_FOUND", `No event ${req.params.id}`); return; }
  res.json({
    event,
    counts: { orgs: store.eventOrgs(event.id).length, people: store.eventPeople(event.id).length },
  });
});

// CREAO: POST /webhooks/creao (re-fetches the run with our key) and GET /api/creao/runs. See creao.ts.
app.use(creaoRouter);

// Setup page (04 B10): one static HTML file with inline JS, re-read per request so edits show without a restart.
app.get("/setup", (_req, res) => {
  res.type("html").setHeader("Cache-Control", "no-store");
  res.send(fs.readFileSync(path.join(BACKEND_DIR, "public", "setup.html"), "utf8"));
});
app.get("/", (_req, res) => { res.redirect("/setup"); });

// --- Errors
app.use((req, res) => sendError(res, 404, "NOT_FOUND", `No route ${req.method} ${req.path}`));
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof CueError) {
    if (err.status >= 500 || err.code === "STT_FAILED") log.warn("api error", { "cue.code": err.code, "cue.status": err.status });
    sendError(res, err.status, err.code, err.message);
    return;
  }
  const e = err as { type?: string; status?: number; message?: string };
  if (e?.type === "entity.too.large") { sendError(res, 413, "BAD_REQUEST", "Body too large"); return; }
  if (e?.type === "entity.parse.failed") { sendError(res, 400, "BAD_REQUEST", "Invalid JSON"); return; }
  console.error("[error]", err);
  captureError(err);
  sendError(res, 500, "INTERNAL", "Internal error");
});

app.listen(config.port, () => {
  const keys = {
    deepgram: !!config.deepgramKey, exa: !!config.exaKey, anthropic: !!config.anthropicKey, creao: !!config.creaoKey,
  };
  console.log(`[cue] listening on :${config.port} | model ${config.briefModel} | keys ${JSON.stringify(keys)} | event ${store.activeEventId}`);
});
