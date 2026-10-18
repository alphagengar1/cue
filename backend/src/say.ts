// "Hold the temple and say anything" (POST /api/say). The intent classifier (intent.ts) decides
// what the wearer meant; this file does it: a lookup, a correction of the last lookup, a debrief
// note (stored on the brief, recap texted), a goal change (angle card rewritten), a recap, or
// nothing. One entry point, so the glasses menu stays small.
import { z } from "zod";
import type { Brief, Query, SayResponse } from "../../shared/types.js";
import { buildBrief, regenerateAngle, type BriefOutcome } from "./brief.js";
import { composeRecap } from "./compose.js";
import { debriefsToday, startCoach } from "./coach.js";
import { journal } from "./journal.js";
import { creaoEnabled, startRun } from "./creao.js";
import { CueError } from "./errors.js";
import { classifyIntent } from "./intent.js";
import { LlmUnavailable, parseWithModel } from "./llm.js";
import { parseTranscript } from "./parse.js";
import { photonConfigured, sendRecap } from "./photon.js";
import { store } from "./store.js";
import { log } from "./telemetry.js";

export interface SayOutcome { response: SayResponse; fallback: boolean; notes: string[] }

const Rewrite = z.object({ name: z.string(), org: z.string(), role: z.string() });

/** "Cook with a C" + the last query -> the corrected query. Haiku; falls back to re-parsing the text. */
export async function rewriteQuery(prev: Query | undefined, text: string): Promise<Query> {
  try {
    const out = await parseWithModel(
      "The wearer of smart glasses is correcting how their last lookup was heard. Given the previous name, org and role and what they said now, return the corrected name, org and role (role may be empty). Spell the name exactly as the correction implies ('Cook with a C' means the surname starts with C: 'Cook'). Keep any field you have no reason to change. Return only the fields.",
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
  // Every utterance, verbatim, with how it was understood: the speech record the long-term agents read.
  journal({ type: "say", briefId: current?.id, person: current?.query, data: { text, intent: intent.intent, confidence: intent.confidence, source: intent.source, hadBrief: !!current } });
  log.info("say", { "cue.intent": intent.intent, "cue.intent_confidence": intent.confidence, "cue.intent_source": intent.source });
  const done = (response: SayResponse, fallback = false): SayOutcome => ({
    response: { ...response, intentConfidence: intent.confidence, intentSource: intent.source }, fallback, notes,
  });

  const recapFor = async (brief: Brief): Promise<NonNullable<SayResponse["recap"]>> => {
    if (!photonConfigured()) return { sent: false, reason: "Photon not set up" };
    const bubbles = await composeRecap(brief);
    const r = await sendRecap(brief, undefined, { bubbles, force: true });
    journal({ type: "recap", briefId: brief.id, person: brief.query, data: r.sent ? { sent: true, chars: r.text.length, bubbles } : { sent: false, reason: r.reason, bubbles } });
    return r.sent ? { sent: true, chars: r.text.length } : { sent: false, reason: r.reason };
  };
  const debrief = async (): Promise<SayOutcome> => {
    if (!current) return done({ intent: "unknown", say: "No one to debrief yet.\nSay a name, company, role first." });
    const brief: Brief = { ...current, debrief: text.trim().slice(0, 600), version: current.version + 1, updatedAt: new Date().toISOString() };
    store.briefs.set(brief.id, brief);
    journal({ type: "debrief", briefId: brief.id, person: brief.query, data: { text: brief.debrief } });
    // With the Follow-up agent configured, it writes the recap itself after post-conversation research
    // (agents/follow-up.md); the phone gets a one-line ack now. Without it, Haiku's instant recap.
    const recap = await recapFor(brief); // Haiku, in seconds; the CREAO follow-up arrives as one wave later
    // CREAO Follow-up Writer, live when its app key is set: the full email + message + next steps,
    // texted when the run completes (about a minute). The Haiku recap above is the instant part.
    let creaoRunId: string | undefined;
    if (creaoEnabled("follow_up_writer")) {
      const p = store.profile;
      const runId = await startRun("follow_up_writer", {
        brief: { person: { name: brief.query.name, role: brief.query.role ?? "", org: brief.query.org }, cards: brief.cards },
        // The consented transcript rides inside the debrief field (the agent's inputs are pinned).
        debrief: [brief.debrief, brief.conversation ? `Conversation transcript: ${brief.conversation.slice(0, 6000)}` : ""].filter(Boolean).join("\n\n"),
        goal: store.goal,
        wearer: { name: p.name, school: p.school ?? "", major: p.major ?? "", summary: p.summary, interests: p.interests, projects: p.projects, goalNote: p.goalNote ?? "" },
        eventName: store.events.get(brief.eventId)?.name ?? "",
      }, { briefId: brief.id, personId: brief.match.personId ?? undefined });
      notes.push(runId ? `follow_up_writer run ${runId}` : "follow_up_writer start failed");
      creaoRunId = runId ?? undefined;
    }
    // Long-run agent: after every third debrief of the day, the Networking Coach reviews the day.
    if (debriefsToday() % 3 === 0) { const id = await startCoach("", "third debrief"); if (id) notes.push(`networking_coach run ${id}`); }
    return done({ intent: "debrief", brief, recap, ...(creaoRunId ? { creaoRunId } : {}) });
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
      store.saveLocal();
      journal({ type: "goal", data: { goal, via: "spoken", said: text } });
      if (!current) return done({ intent: "goal", goal });
      const out = await regenerateAngle(current.id);
      notes.push(...out.notes);
      return done({ intent: "goal", goal, brief: out.brief }, out.fallback);
    }
    case "recap":
      if (!current) return done({ intent: "unknown", say: "No brief to send yet." });
      return done({ intent: "recap", recap: await recapFor(current) });
    case "coach": {
      const runId = await startCoach(text, "say");
      notes.push(runId ? `networking_coach run ${runId}` : "networking_coach not configured");
      return done({ intent: "coach", say: runId ? "coach is on it,\ntext coming in a minute" : "coach not set up yet", ...(runId ? { creaoRunId: runId } : {}) });
    }
    case "quiet":
      return done({ intent: "quiet" });
    default:
      return done({ intent: "unknown", say: "Say a name, company and role,\nor tell me what they said." });
  }
}
