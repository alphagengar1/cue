// "Hold the temple and say anything" (POST /api/say). The intent classifier (intent.ts) decides
// what the wearer meant; this file does it: a lookup, a correction of the last lookup, a debrief
// note (stored on the brief, recap texted), a goal change (angle card rewritten), a recap, or
// nothing. One entry point, so the glasses menu stays small.
import { z } from "zod";
import type { Brief, Query, SayResponse } from "../../shared/types.js";
import { buildBrief, regenerateAngle, type BriefOutcome } from "./brief.js";
import { composeRecap } from "./compose.js";
import { CueError } from "./errors.js";
import { classifyIntent } from "./intent.js";
import { LlmUnavailable, parseWithModel } from "./llm.js";
import { parseTranscript } from "./parse.js";
import { photonConfigured, sendRecap } from "./photon.js";
import { store } from "./store.js";
import { log } from "./telemetry.js";

export interface SayOutcome { response: SayResponse; fallback: boolean; notes: string[] }

const Rewrite = z.object({ name: z.string(), org: z.string(), role: z.string() });

/** "Cramer with a C" + the last query -> the corrected query. Haiku; falls back to re-parsing the text. */
export async function rewriteQuery(prev: Query | undefined, text: string): Promise<Query> {
  try {
    const out = await parseWithModel(
      "The wearer of smart glasses is correcting how their last lookup was heard. Given the previous name, org and role and what they said now, return the corrected name, org and role (role may be empty). Spell the name exactly as the correction implies ('Cramer with a C' means the surname starts with C: 'Cramer'). Keep any field you have no reason to change. Return only the fields.",
      { previous: prev ?? null, saidNow: text }, Rewrite, { maxTokens: 200, timeoutMs: 4000 },
    );
    const name = out.name.trim();
    const org = out.org.trim() || prev?.org || "";
    const role = out.role.trim() || prev?.role;
    if (name) return role ? { name, org, role } : { name, org };
  } catch (err) {
    console.warn(`[say] rewrite fell back: ${err instanceof LlmUnavailable ? err.message : String(err)}`);
  }
  const q = parseTranscript(text);
  const role = q.role || prev?.role;
  return { name: q.name || prev?.name || "", org: q.org || prev?.org || "", ...(role ? { role } : {}) };
}

const queryText = (q: Query): string => [q.name, q.org, q.role].filter(Boolean).join(", ");

export async function handleSay(text: string, briefId?: string): Promise<SayOutcome> {
  const notes: string[] = [];
  const current = (briefId ? store.briefs.get(briefId) : undefined) ?? store.latestBrief() ?? undefined;
  const t0 = Date.now();
  const intent = await classifyIntent(text, { hasBrief: !!current, lastQuery: current?.query });
  notes.push(`intent ${intent.intent} ${intent.confidence.toFixed(2)} (${intent.source}, ${Date.now() - t0}ms)`);
  log.info("say", { "cue.intent": intent.intent, "cue.intent_confidence": intent.confidence, "cue.intent_source": intent.source });
  const done = (response: SayResponse, fallback = false): SayOutcome => ({
    response: { ...response, intentConfidence: intent.confidence, intentSource: intent.source }, fallback, notes,
  });

  const recapFor = async (brief: Brief): Promise<NonNullable<SayResponse["recap"]>> => {
    if (!photonConfigured()) return { sent: false, reason: "Photon not set up" };
    const bubbles = await composeRecap(brief);
    const r = await sendRecap(brief, undefined, { bubbles, force: true });
    return r.sent ? { sent: true, chars: r.text.length } : { sent: false, reason: r.reason };
  };
  const debrief = async (): Promise<SayOutcome> => {
    if (!current) return done({ intent: "unknown", say: "No one to debrief yet.\nSay a name, company, role first." });
    const brief: Brief = { ...current, debrief: text.trim().slice(0, 600), version: current.version + 1, updatedAt: new Date().toISOString() };
    store.briefs.set(brief.id, brief);
    return done({ intent: "debrief", brief, recap: await recapFor(brief) });
  };
  const lookup = async (q: string, as: "lookup" | "correction" = "lookup"): Promise<SayOutcome> => {
    let out: BriefOutcome;
    try {
      out = await buildBrief(q);
    } catch (err) {
      // No name in it: it was a note about the conversation, not a lookup.
      if (err instanceof CueError && err.code === "BAD_REQUEST" && current) return debrief();
      throw err;
    }
    notes.push(...out.notes);
    return done({ intent: as, brief: out.brief }, out.fallback);
  };

  switch (intent.intent) {
    case "lookup":
      return lookup(text);
    case "correction": {
      const q = await rewriteQuery(current?.query, text);
      notes.push(`corrected to "${queryText(q)}"`);
      if (!q.name) return done({ intent: "unknown", say: "Didn't catch the correction.\nSay the full name and company." });
      return lookup(queryText(q), "correction");
    }
    case "debrief":
      return debrief();
    case "goal": {
      const goal = intent.goal;
      if (!goal) return done({ intent: "unknown", say: "Which goal? Internship, cofounder,\nmentorship, learning, or teammates." });
      store.goal = goal;
      if (!current) return done({ intent: "goal", goal });
      const out = await regenerateAngle(current.id);
      notes.push(...out.notes);
      return done({ intent: "goal", goal, brief: out.brief }, out.fallback);
    }
    case "recap":
      if (!current) return done({ intent: "unknown", say: "No brief to send yet." });
      return done({ intent: "recap", recap: await recapFor(current) });
    case "quiet":
      return done({ intent: "quiet" });
    default:
      return done({ intent: "unknown", say: "Say a name, company and role,\nor tell me what they said." });
  }
}
