// Intent routing for "hold the temple and say anything" (POST /api/say). A decision model (the
// OpenAI Decisions API, same endpoint as decide.ts) classifies the utterance into one of a few
// intents with calibrated probabilities; a rules classifier is the fallback and the tie-breaker.
// Nothing here generates text; the correction rewrite (Haiku) lives in say.ts.
import type { Goal, Query, SayIntent } from "../../shared/types.js";
import { config } from "./config.js";
import { DECISIONS_MODEL, DECISIONS_URL } from "./decide.js";
import { parseTranscript } from "./parse.js";

export type Intent = SayIntent;
export const INTENTS: Intent[] = ["lookup", "debrief", "correction", "goal", "recap", "coach", "quiet", "unknown"];

export interface IntentContext {
  hasBrief: boolean;
  lastQuery?: Query;
}
export interface IntentResult {
  intent: Intent;
  confidence: number;            // 0-1 for the chosen intent
  goal?: Goal;                   // when intent is "goal"
  source: "decisions" | "rules";
  probabilities?: Partial<Record<Intent, number>>;
}

// ---------------------------------------------------------------------------
// Rules (always available)
// ---------------------------------------------------------------------------

const GOAL_WORDS: [RegExp, Goal][] = [
  [/\b(intern(ship)?s?|new grad|full[- ]time|job|hiring)\b/i, "internship"],
  [/\b(co-?founders?|start(ing)? a (company|startup)|founding)\b/i, "cofounder"],
  [/\b(mentors?(hip)?|advice|guidance)\b/i, "mentorship"],
  [/\b(teammates?|sponsors?|team up|join (my|our) team)\b/i, "teammates_sponsors"],
  [/\b(learn(ing)?|experts?|curious|understand)\b/i, "learn"],
];
const GOAL_TRIGGER = /\b(looking for|my goal|i want|i'm (here|looking)|i am (here|looking)|switch (to|my goal)|set (my )?goal|goal is|focus on)\b/i;
const CORRECTION = /\b(with an? [a-z]\b|spell(ed|ing)?|not [A-Z][a-z]+|i meant|i said|no,? it's|it's actually|correction|wrong (name|company|org))\b/i;
const RECAP = /\b(text me|send (me )?(the |a )?(recap|summary)|recap|summar(y|ize)|message me)\b/i;
const QUIET = /^\s*(never ?mind|cancel|stop|forget it|go quiet|quiet|nothing)\b/i;
const COACH = /\b(how (did|am|was) i (do|doing|today)|how did (today|it) go|who should i (follow up|talk|email)|coach( me)?|what (patterns|did i learn)|rate my (day|networking)|how.{0,12}networking)\b/i;
const DEBRIEF = /\b(he|she|they|we)\s+(said|told|wants?|mentioned|asked|suggested|offered|liked|is|are|was|were)\b|\b(talked|spoke|chatted|met)\b|\b(email (him|her|them)|follow ?up|send (him|her|them))\b/i;

export function goalFromText(text: string): Goal | undefined {
  for (const [re, g] of GOAL_WORDS) if (re.test(text)) return g;
  return undefined;
}

/** Deterministic classifier. Conservative: "lookup" only when the text parses as name + org. */
export function rulesIntent(text: string, ctx: IntentContext): IntentResult {
  const t = text.trim();
  const r = (intent: Intent, confidence: number, goal?: Goal): IntentResult => ({ intent, confidence, goal, source: "rules" });
  if (!t) return r("unknown", 1);
  if (QUIET.test(t)) return r("quiet", 0.9);
  if (COACH.test(t)) return r("coach", 0.85);
  if (RECAP.test(t) && !DEBRIEF.test(t)) return r("recap", 0.8);
  if (ctx.hasBrief && CORRECTION.test(t)) return r("correction", 0.8);
  const goal = goalFromText(t);
  if (goal && (GOAL_TRIGGER.test(t) || t.split(/\s+/).length <= 3)) return r("goal", 0.8, goal);
  const q = parseTranscript(t);
  const looksLikeLookup = !!q.name && !!q.org && t.split(/\s+/).length <= 9 && !DEBRIEF.test(t);
  if (looksLikeLookup) return r("lookup", t.includes(",") ? 0.85 : 0.6);
  if (ctx.hasBrief && (DEBRIEF.test(t) || t.split(/\s+/).length >= 6)) return r("debrief", 0.7);
  const pronoun = /^(he|she|they|we|i|it|you|him|her|them)$/i.test(q.name);
  if (q.name && q.org && !pronoun && !DEBRIEF.test(t)) return r("lookup", 0.5);
  return r("unknown", 0.5);
}

// ---------------------------------------------------------------------------
// Decision model
// ---------------------------------------------------------------------------

const INTENT_CHOICES: { value: Intent; description: string }[] = [
  { value: "lookup", description: "Names a person and/or a company to look up before talking to them, e.g. 'Priya Shah, Anduril, recruiter' or 'Tim from Sentry'." },
  { value: "debrief", description: "Notes about a conversation that already happened: what the person said, wants, offered, or what to send them, e.g. 'he said email him about Seer, they're hiring interns'." },
  { value: "correction", description: "Fixes how the last name or company was heard, e.g. 'Cook with a C', 'no, it's Priya not Maya', 'I meant Anduril'." },
  { value: "goal", description: "States what the wearer is looking for at the event: an internship or job, a cofounder, mentorship, learning from experts, or teammates and sponsors." },
  { value: "recap", description: "Asks to text or send the recap or summary of the last person to their phone." },
  { value: "coach", description: "Asks for reflection or advice across the day: how did I do, who should I follow up with first, what patterns, coach me." },
  { value: "quiet", description: "Cancel, never mind, stop, go quiet, nothing." },
  { value: "unknown", description: "None of the above, or too garbled to tell." },
];
export const GOAL_CHOICES: { value: Goal; description: string }[] = [
  { value: "internship", description: "An internship, job, new-grad role, or being hired." },
  { value: "cofounder", description: "A cofounder or someone to start a company with." },
  { value: "mentorship", description: "A mentor, advice, or guidance." },
  { value: "learn", description: "Learning from experts, curiosity about their work." },
  { value: "teammates_sponsors", description: "Teammates for a project or sponsors." },
];

export interface Answer { type: string; name: string; choice?: string; probabilities?: { value: string; probability: number }[]; confidence?: number }
export type Choice<T extends string> = { value: T; description: string };
export interface DecisionsOpts { apiKey?: string; fetch?: typeof globalThis.fetch; timeoutMs?: number }

/**
 * One Decisions API call, shared by the voice and iMessage classifiers. Returns the answers by
 * name, or null (-> rules) without a key, on timeout, non-200, or bad JSON. Never throws.
 */
export async function askDecisions(
  input: string,
  questions: { type: "choice"; name: string; instructions: string; choices: Choice<string>[] }[],
  opts: DecisionsOpts = {},
): Promise<Map<string, Answer> | null> {
  const apiKey = (opts.apiKey ?? process.env.OPENAI_API_KEY ?? "").trim();
  if (!apiKey) return null;
  const doFetch = opts.fetch ?? globalThis.fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? config.decideTimeoutMs);
  try {
    const res = await doFetch(DECISIONS_URL, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: DECISIONS_MODEL, input, questions }), signal: ac.signal,
    });
    if (res.status !== 200) return null;
    const json = (await res.json()) as { answers?: Answer[] };
    return new Map((json.answers ?? []).map((a) => [a.name, a]));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The chosen value of a choice answer when it is one of `allowed`, with its calibrated probability. */
export function pickChoice<T extends string>(a: Answer | undefined, allowed: readonly T[]): { value: T; confidence: number; probabilities: Partial<Record<T, number>> } | null {
  if (!a || a.type !== "choice" || !allowed.includes(a.choice as T)) return null;
  const probabilities: Partial<Record<T, number>> = {};
  for (const p of a.probabilities ?? []) probabilities[p.value as T] = p.probability;
  const value = a.choice as T;
  return { value, confidence: probabilities[value] ?? a.confidence ?? 0, probabilities };
}

/** One Decisions call. Returns null (-> rules) without a key, on timeout, non-200, or bad JSON. */
export async function decisionsIntent(text: string, ctx: IntentContext, opts: DecisionsOpts = {}): Promise<IntentResult | null> {
  const last = ctx.lastQuery ? `A brief is open for ${ctx.lastQuery.name} at ${ctx.lastQuery.org}.` : "No brief is open yet.";
  const byName = await askDecisions(
    `A student wearing smart glasses at a networking event held the temple and said: "${text.slice(0, 400)}"\nContext: ${last}`,
    [
      { type: "choice", name: "intent", instructions: "What does the wearer want the glasses to do?", choices: INTENT_CHOICES },
      { type: "choice", name: "goal", instructions: "If they are stating what they are looking for, which goal is it?", choices: GOAL_CHOICES },
    ], opts);
  if (!byName) return null;
  const intentA = pickChoice(byName.get("intent"), INTENTS);
  if (!intentA) return null;
  const goal = pickChoice(byName.get("goal"), GOAL_CHOICES.map((g) => g.value))?.value;
  return { intent: intentA.value, confidence: intentA.confidence, goal, source: "decisions", probabilities: intentA.probabilities };
}

/**
 * Decision model first; rules when it is off or unsure. A confident rules "lookup" (comma-separated
 * name, org) beats a weak model answer, since that is the one shape we know by construction.
 */
export async function classifyIntent(text: string, ctx: IntentContext): Promise<IntentResult> {
  const rules = rulesIntent(text, ctx);
  // "Name, org, role" is a lookup by construction: skip the model call (saves 0.2-1 s on the common path).
  if (rules.intent === "lookup" && rules.confidence >= 0.85) return rules;
  const model = await decisionsIntent(text, ctx);
  if (!model) return rules;
  if (rules.intent === "lookup" && rules.confidence >= 0.85 && model.confidence < 0.7) return rules;
  if (model.confidence < 0.45) return rules;
  if (model.intent === "goal" && !model.goal) model.goal = rules.goal ?? goalFromText(text);
  if (model.intent === "debrief" && !ctx.hasBrief) return rules.intent === "lookup" ? rules : { ...model, intent: "unknown" };
  return model;
}
