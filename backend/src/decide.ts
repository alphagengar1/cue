// Decision gate (03 section 9, agents/decision-gate.md): one call to the OpenAI Decisions API
// (public beta) that returns calibrated numbers the brief pipeline can threshold.
//
//   match     0-1  do these facts describe the person the wearer named (same name, same org)?
//   goalFit   0-2  how useful is this person for the wearer's goal?
//   lead      which card should show first
//   sensitive 0-1 per fact: does it mention private matters?
//
// Optional and off when OPENAI_API_KEY is missing. Never throws: every failure path (no key,
// timeout, non-200, bad JSON, missing answer, refusal) returns null and the caller behaves as today.
// Raw fetch, no SDK, so the test suite can stub globalThis.fetch and never touch the network.
import "./config.js"; // loads backend/.env so OPENAI_API_KEY is visible when set only there

export const DECISIONS_URL = "https://api.openai.com/v1/decisions";
export const DECISIONS_MODEL = "gpt-6-luna";
export const DECIDE_TIMEOUT_MS = 700;
export const MAX_FACTS = 12;
export const MAX_FACT_CHARS = 140;

export type Lead = "connect" | "context" | "angle";
export const LEADS: Lead[] = ["connect", "context", "angle"];

export interface DecideInput {
  query: { name: string; org: string; role?: string };
  goal: string;
  goalNote?: string;
  facts: { text: string; sourceUrl: string }[];
}

export interface Decision {
  match: number;        // 0-1 probability
  goalFit: number;      // 0-2 weighted level index
  lead: Lead;
  sensitive: number[];  // one 0-1 probability per fact sent (same order as input.facts, max MAX_FACTS)
}

export interface DecideOptions {
  apiKey?: string;              // default: process.env.OPENAI_API_KEY
  fetch?: typeof globalThis.fetch; // default: globalThis.fetch
  timeoutMs?: number;           // default: DECIDE_TIMEOUT_MS
}

// Request shapes (subset of the Decisions API; see the guide linked above).
export interface PredicateQuestion { type: "predicate"; name: string; instructions: string }
export interface ChoiceQuestion {
  type: "choice"; name: string; instructions: string; choices: { value: string; description: string }[];
}
export interface ScoreQuestion {
  type: "score"; name: string; instructions: string; levels: { label: string; description: string }[];
}
export type Question = PredicateQuestion | ChoiceQuestion | ScoreQuestion;
export interface DecisionsRequest { model: string; input: string; questions: Question[] }

export const Q = {
  match: "match",
  goalFit: "goal_fit",
  lead: "lead",
  sensitive: (i: number) => `sensitive_${i}`,
} as const;

const trunc = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n - 3).trimEnd() + "...";
};

/** Facts as sent: at most MAX_FACTS, each truncated to MAX_FACT_CHARS. Exported so callers can align `sensitive`. */
export function factsForDecision(facts: DecideInput["facts"]): { text: string; sourceUrl: string }[] {
  return facts.slice(0, MAX_FACTS).map((f) => ({ text: trunc(f.text, MAX_FACT_CHARS), sourceUrl: f.sourceUrl }));
}

/** Build the exact request body. Pure, so it is unit-tested against literal JSON. */
export function buildRequest(input: DecideInput): DecisionsRequest {
  const facts = factsForDecision(input.facts);
  const who = [input.query.name, input.query.org, input.query.role].filter(Boolean).join(", ");
  const goal = input.goalNote ? `${input.goal} (${input.goalNote})` : input.goal;
  const lines = [
    `Wearer named: ${who}`,
    `Wearer's goal: ${goal}`,
    "Facts found by web search (numbered, each with its source URL):",
    ...facts.map((f, i) => `${i}. ${f.text} [${f.sourceUrl}]`),
  ];
  if (facts.length === 0) lines.push("(no facts found)");

  const questions: Question[] = [
    {
      type: "predicate", name: Q.match,
      instructions: "These facts describe the person the wearer named: the same name and the same organization.",
    },
    {
      type: "score", name: Q.goalFit,
      instructions: "How useful is talking to this person for the wearer's goal, given only these facts?",
      levels: [
        { label: "not useful", description: "Nothing here helps the wearer's goal." },
        { label: "somewhat useful", description: "Some overlap with the goal, or a general conversation is possible." },
        { label: "strongly useful", description: "This person can directly help with the wearer's goal." },
      ],
    },
    {
      type: "choice", name: Q.lead,
      instructions: "Which card should the wearer see first?",
      choices: [
        { value: "connect", description: "A specific opener about something this person made, said or wrote." },
        { value: "context", description: "Who they are and what they and their organization focus on now." },
        { value: "angle", description: "How this conversation serves the wearer's goal and what to ask for." },
      ],
    },
    ...facts.map((_, i): PredicateQuestion => ({
      type: "predicate", name: Q.sensitive(i),
      instructions: `Fact ${i} mentions private matters: health, family, religion, politics, legal, home, age or appearance.`,
    })),
  ];
  return { model: DECISIONS_MODEL, input: lines.join("\n"), questions };
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Parse a Decisions API response body for a request with `factCount` facts.
 * Returns null if any required answer is missing, refused, or malformed.
 */
export function parseResponse(body: unknown, factCount: number): Decision | null {
  if (!body || typeof body !== "object") return null;
  const answers = (body as { answers?: unknown }).answers;
  if (!Array.isArray(answers)) return null;
  const byName = new Map<string, Record<string, unknown>>();
  for (const a of answers) {
    if (a && typeof a === "object" && typeof (a as { name?: unknown }).name === "string") {
      byName.set((a as { name: string }).name, a as Record<string, unknown>);
    }
  }
  const get = (name: string): Record<string, unknown> | null => {
    const a = byName.get(name);
    return a && a.type !== "refusal" ? a : null;
  };

  const match = num(get(Q.match)?.probability);
  const goalFit = num(get(Q.goalFit)?.score);
  const lead = get(Q.lead)?.choice;
  if (match === null || goalFit === null || !LEADS.includes(lead as Lead)) return null;

  const sensitive: number[] = [];
  for (let i = 0; i < factCount; i++) {
    const p = num(get(Q.sensitive(i))?.probability);
    if (p === null) return null;
    sensitive.push(clamp(p, 0, 1));
  }
  return { match: clamp(match, 0, 1), goalFit: clamp(goalFit, 0, 2), lead: lead as Lead, sensitive };
}

/**
 * One Decisions call per brief. Resolves null (never rejects) when the key is missing,
 * the call times out (DECIDE_TIMEOUT_MS), the status is not 200, or the body does not parse.
 */
export async function decide(input: DecideInput, opts: DecideOptions = {}): Promise<Decision | null> {
  const apiKey = (opts.apiKey ?? process.env.OPENAI_API_KEY ?? "").trim();
  if (!apiKey) return null;
  const doFetch = opts.fetch ?? globalThis.fetch;
  const req = buildRequest(input);
  const factCount = Math.min(input.facts.length, MAX_FACTS);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? DECIDE_TIMEOUT_MS);
  try {
    const res = await doFetch(DECISIONS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(req),
      signal: ac.signal,
    });
    if (res.status !== 200) return null;
    return parseResponse(await res.json(), factCount);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
