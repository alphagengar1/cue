// Fast path orchestration (01 section 3, 03 section 4-5):
// parse -> store lookup -> Exa -> filter -> match level -> one LLM call -> Brief v1.
// Any failure in search or LLM degrades to the template brief; the endpoint still returns 200.
import type { Brief, Card, Confidence, Goal, Organization, Person, Query } from "../../shared/types.js";
import { config } from "./config.js";
import { creaoEnabled, startRun } from "./creao.js";
import { decide, type Decision } from "./decide.js";
import { CueError } from "./errors.js";
import { LlmUnavailable, writeCards, type BriefInput } from "./llm.js";
import { findOrg, findStoredPerson, parseTranscript } from "./parse.js";
import { cleanSource, enforceCards, hostOf, isBoilerplate } from "./safety.js";
import {
  filterResults, fullNamesIn, resultsToFacts, searchPerson, SearchUnavailable, type SearchResult,
} from "./search.js";
import { newId, norm, slug, store } from "./store.js";
import { log, span, spanAttrs } from "./telemetry.js";

export interface BriefOutcome {
  brief: Brief;
  fallback: boolean;     // true if any card came from the template instead of the LLM
  notes: string[];       // why (for logs and the X-Cue-Notes header)
  timings?: Record<string, number>; // ms per live-path step (Server-Timing header, bench)
}

const now = () => new Date().toISOString();
const ALL: Card["kind"][] = ["connect", "context", "angle"];

/** Which cards a brief should have (01 section 5, Brief.cards comment). */
function expectedKinds(confidence: Confidence, org: Organization | null): Card["kind"][] {
  if (confidence !== "low") return ALL;
  return org ? ["context"] : ["angle"];
}

function orgDomains(org: Organization | null): string[] {
  if (!org) return [];
  return [...new Set(org.focusNow.map((f) => hostOf(f.sourceUrl)).filter(Boolean))];
}

// ---------------------------------------------------------------------------
// Template cards (no LLM). Used when keys are missing or a call fails.
// ---------------------------------------------------------------------------

const GOAL_ASK: Record<Goal, (org: string) => string> = {
  internship: (o) => `Ask how ${o} hires interns and who to follow up with after the event.`,
  cofounder: (o) => `Ask what problem at ${o} they would start a company around.`,
  learn: (o) => `Ask what is hardest about their work at ${o} right now.`,
  teammates_sponsors: (o) => `Ask if ${o} has APIs, credits or mentors for hackers this weekend.`,
  mentorship: (o) => `Ask what they wish they knew as a student, and if you can follow up.`,
};

export function templateCard(
  kind: Card["kind"], q: Query, org: Organization | null, person: Person | null,
  goal: Goal, opts: { lowPrefix?: string } = {},
): Card | null {
  const orgName = org?.name ?? (q.org || "their team");
  if (kind === "angle") {
    return { kind, title: "Your angle", body: GOAL_ASK[goal](orgName), source: null };
  }
  if (kind === "context") {
    if (!org) {
      const f = person?.facts[0];
      if (!f) return null;
      return { kind, title: "Context", body: f.text, source: cleanSource(f.sourceUrl) };
    }
    const fact = org.focusNow[0];
    const who = person?.role ? `${person.name.split(" ")[0]}: ${person.role}. ` : "";
    const parts = [opts.lowPrefix ?? who, org.oneLiner, fact ? `Now: ${fact.text}` : ""];
    return {
      kind, title: "Context",
      body: parts.filter(Boolean).join(" "),
      source: cleanSource(fact?.sourceUrl) ?? `${org.id} (event pack)`,
    };
  }
  // connect: needs a real fact to open with (not a nav/boilerplate snippet)
  const f = person?.facts.find((x) => !isBoilerplate(x.text));
  if (!f) return null;
  return { kind, title: "Connect", body: `Ask about: ${f.text}`, source: cleanSource(f.sourceUrl) };
}

/**
 * Write cards with the LLM, then fill any missing expected card from the template.
 * For low matches, the context body must start with the "No public info" line.
 */
async function writeBriefCards(
  q: Query, org: Organization | null, person: Person | null, confidence: Confidence,
  notes: string[], lowPrefix?: string, only?: Card["kind"][], timings?: Record<string, number>,
): Promise<{ cards: Card[]; fallback: boolean }> {
  const kinds = only ?? expectedKinds(confidence, org);
  const goal = store.goal;
  const event = store.activeEvent();
  const input: BriefInput = {
    person: person
      ? { name: person.name, role: person.role, headline: person.headline, facts: person.facts, match: confidence }
      : { name: q.name, role: q.role, facts: [], match: confidence },
    organization: org
      ? { name: org.name, oneLiner: org.oneLiner, focusNow: org.focusNow, eventRole: org.eventRole, hiring: org.hiring }
      : null,
    wearer: store.profile,
    goal,
    eventName: event?.name ?? "",
  };

  let llmCards: Card[] = [];
  let fallback = false;
  const t0 = Date.now();
  try {
    llmCards = await span("llm", "gen_ai.chat", async () => {
      const out = (await writeCards(input, only)).filter((c) => kinds.includes(c.kind));
      spanAttrs({ "cue.cards": out.length });
      return out;
    }, { "gen_ai.request.model": config.briefModel, "cue.kinds": kinds.join(",") });
    notes.push(`llm ${Date.now() - t0}ms`);
  } catch (err) {
    fallback = true;
    notes.push(`llm fallback: ${err instanceof LlmUnavailable ? err.message : String(err)}`);
  }
  if (timings) timings.llm = Date.now() - t0;

  const cards: Card[] = [];
  for (const kind of kinds) {
    let card: Card | null = llmCards.find((c) => c.kind === kind) ?? null;
    if (!card) {
      if (!fallback) { fallback = true; notes.push(`template filled ${kind}`); }
      card = templateCard(kind, q, org, person, goal, { lowPrefix });
    }
    if (!card) continue;
    if (kind === "context" && lowPrefix && !card.body.startsWith(lowPrefix)) {
      card = { ...card, body: `${lowPrefix} ${card.body}` };
    }
    cards.push(card);
  }
  return { cards: enforceCards(cards), fallback };
}

// ---------------------------------------------------------------------------
// POST /api/briefs/text
// ---------------------------------------------------------------------------

export async function buildBrief(text: string): Promise<BriefOutcome> {
  const tStart = Date.now();
  const event = store.activeEvent();
  if (!event) throw new CueError("NO_EVENT", "No active event. Load one on the setup page.", 409);
  const notes: string[] = [];
  const timings: Record<string, number> = {};

  // Store lookup: parse the text, match the org and a known attendee.
  const tStore = Date.now();
  const { query, org, stored } = span("store lookup", "cue.lookup", () => {
    const query = parseTranscript(text);
    const org = query.name ? findOrg(query.org) : null;
    const stored = query.name ? findStoredPerson(query.name, org) : null;
    spanAttrs({ "cue.org_found": !!org, "cue.person_found": !!stored });
    return { query, org, stored };
  });
  timings.store = Date.now() - tStore;
  if (!query.name) throw new CueError("BAD_REQUEST", "Could not find a name in the text");
  const name = stored?.name ?? query.name;
  const firstOnly = !name.includes(" ");
  const orgName = org?.name ?? query.org;
  const orgId = org?.id ?? slug(query.org || "unknown");
  notes.push(org ? `org ${org.id}` : "org not in store");
  if (stored) notes.push(`stored person ${stored.id}`);

  // Search: "<name> <org>", or "<first name> <org> <role>" when the name could not be expanded.
  let kept: SearchResult[] = [];
  let searchFailed = false;
  const t0 = Date.now();
  try {
    const q = firstOnly ? `${name} ${orgName} ${query.role ?? ""}` : `${name} ${orgName}`;
    const results = await span("search", "http.client", async () => {
      const r = await searchPerson(q);
      spanAttrs({ "cue.results": r.length });
      return r;
    }, { "cue.provider": "exa" });
    kept = filterResults(results, name, org ? [org.name, ...org.aliases] : [query.org]);
    notes.push(`search ${Date.now() - t0}ms, kept ${kept.length}/${results.length}`);
  } catch (err) {
    searchFailed = true;
    notes.push(`search unavailable: ${err instanceof SearchUnavailable ? err.message : String(err)}`);
  }
  timings.search = Date.now() - t0;

  // Match level (01 section 5 / 03 section 4 / 04 section 8).
  let confidence: Confidence;
  let candidateNames: string[] = [];
  if (stored) {
    confidence = "high";
  } else if (kept.length === 0) {
    confidence = "low";
  } else {
    const names = firstOnly ? fullNamesIn(kept, name) : [name];
    if (firstOnly && names.length >= 2) {
      confidence = "medium";
      candidateNames = names.slice(0, 3);
    } else {
      confidence = kept.length >= 2 && !firstOnly ? "high" : "medium";
      candidateNames = [names[0] ?? name];
    }
  }
  if (!org && confidence === "high") confidence = "medium"; // search-only brief (01 section 7)

  // Person records.
  const factsFor = (n: string) =>
    resultsToFacts(kept.filter((r) => norm(`${r.title} ${r.text}`).includes(norm(n))), orgDomains(org));
  let person: Person | null = null;
  const candidates: Brief["match"]["candidates"] = [];
  if (confidence !== "low") {
    const names = stored ? [stored.name] : candidateNames;
    for (const n of names) {
      const base = stored && n === stored.name ? stored : null;
      const facts = mergeFacts(base?.facts ?? [], factsFor(n));
      const p = store.upsertPerson(event.id, orgId, n, {
        role: base?.role ?? query.role,
        facts,
        match: confidence,
        matchReason: stored
          ? `on the event list; ${kept.length} search results mention ${n} and ${orgName}`
          : `${kept.length} search result(s) mention ${n} and ${orgName}`,
      });
      person ??= p;
      if (confidence === "medium") {
        candidates.push({ personId: p.id, label: [p.name, p.role, orgName].filter(Boolean).join(" | ") });
      }
    }
  }

  // Decision gate (agents/decision-gate.md): one Decisions API call, 700 ms cap, off without a key.
  // match < 0.6 on a search-only person -> treat as "no public info" (never a card about a stranger);
  // sensitive[i] > 0.5 -> that fact is dropped before the writer; lead -> that card shows first.
  let decision: Decision | null = null;
  if (person && confidence !== "low") {
    const tD = Date.now();
    decision = await decide({
      query, goal: store.goal, goalNote: store.profile.goalNote,
      facts: person.facts.map((f) => ({ text: f.text, sourceUrl: f.sourceUrl })),
    }, { timeoutMs: config.decideTimeoutMs });
    timings.decide = Date.now() - tD;
    if (decision) {
      const d = decision;
      notes.push(`decide ${timings.decide}ms match ${d.match.toFixed(2)} fit ${d.goalFit.toFixed(1)} lead ${d.lead}`);
      const keep = person.facts.filter((_, i) => (d.sensitive[i] ?? 0) <= 0.5);
      if (keep.length !== person.facts.length) {
        notes.push(`decide dropped ${person.facts.length - keep.length} sensitive fact(s)`);
        person = { ...person, facts: keep };
      }
      if (!stored && d.match < 0.6) {
        notes.push("decide: match below 0.6, no person cards");
        confidence = "low"; person = null; candidates.length = 0;
      }
    } else {
      notes.push(`decide off/skipped (${timings.decide}ms)`);
    }
  }

  const lowPrefix = confidence === "low"
    ? (searchFailed && !stored ? "Person lookup unavailable." : `No public info found for ${query.name}.`)
    : undefined;
  const { cards, fallback } = await writeBriefCards(query, org, person, confidence, notes, lowPrefix, undefined, timings);

  const t = now();
  const brief: Brief = {
    id: newId("brf"),
    version: 1,
    eventId: event.id,
    transcript: text,
    query,
    match: { personId: person?.id ?? null, confidence, candidates },
    // Lead card first (stable: the other two keep their order).
    cards: decision ? [...cards].sort((a, b) => Number(b.kind === decision!.lead) - Number(a.kind === decision!.lead)) : cards,
    ...(decision ? { decision: { match: decision.match, goalFit: decision.goalFit, lead: decision.lead } } : {}),
    slowPath: { status: "none" },
    createdAt: t, updatedAt: t,
  };
  store.briefs.set(brief.id, brief);
  if (confidence === "high" && person) maybeStartResearch(brief, person, org);
  timings.total = Date.now() - tStart;
  notes.push(`store ${timings.store}ms`, `total ${timings.total}ms`);
  // Structured log: ids, counts and timings only. No names, transcript, or profile text.
  log.info("lookup", {
    "cue.brief_id": brief.id,
    "cue.confidence": confidence,
    "cue.cards": cards.length,
    "cue.fallback": fallback,
    "cue.org": org?.id ?? "unknown",
    "cue.stored_person": !!stored,
    "cue.search_failed": searchFailed,
    "cue.search_kept": kept.length,
    "cue.ms.store": timings.store,
    "cue.ms.search": timings.search,
    "cue.ms.llm": timings.llm,
    "cue.ms.decide": timings.decide,
    "cue.ms.total": timings.total,
  });
  return { brief: store.briefs.get(brief.id)!, fallback, notes, timings };
}

function mergeFacts(a: Person["facts"], b: Person["facts"]): Person["facts"] {
  const seen = new Set<string>();
  return [...a, ...b].filter((f) => (seen.has(f.sourceUrl) ? false : (seen.add(f.sourceUrl), true))).slice(0, 8);
}

/** Person Researcher: high/confirmed only, at most once per person per event (01 section 8). */
function maybeStartResearch(brief: Brief, person: Person, org: Organization | null): void {
  if (!creaoEnabled("person_researcher") || person.lastResearchedAt) return;
  store.putPerson({ ...person, lastResearchedAt: now() });
  store.briefs.set(brief.id, { ...brief, slowPath: { status: "running" } });
  const input = { name: person.name, org: org?.name ?? brief.query.org, role: person.role ?? "", orgAliases: org?.aliases ?? [] };
  void startRun("person_researcher", input, { briefId: brief.id, personId: person.id }).then((runId) => {
    const b = store.briefs.get(brief.id);
    if (!b) return;
    store.briefs.set(b.id, { ...b, slowPath: runId ? { status: "running", runId } : { status: "failed" } });
  });
}

// ---------------------------------------------------------------------------
// POST /api/briefs/:id/confirm
// ---------------------------------------------------------------------------

export async function confirmPerson(briefId: string, personId: string | null): Promise<BriefOutcome> {
  const brief = store.briefs.get(briefId);
  if (!brief) throw new CueError("NOT_FOUND", `No brief ${briefId}`, 404);
  const org = findOrg(brief.query.org);
  const notes: string[] = [];
  let fallback = false;
  let next: Brief;

  if (personId === null) {
    // "Neither": org-only, one context card. Org unknown too: the generic angle card (Brief.cards rule).
    const prefix = `${brief.query.name} not confirmed.`;
    const card = templateCard("context", brief.query, org, null, store.goal, { lowPrefix: prefix })
      ?? templateCard("angle", brief.query, org, null, store.goal);
    next = {
      ...brief,
      match: { ...brief.match, personId: null, confidence: "low" },
      cards: card ? enforceCards([card]) : [],
    };
  } else {
    const idx = brief.match.candidates.findIndex((c) => c.personId === personId);
    if (idx < 0) throw new CueError("BAD_REQUEST", `personId ${personId} is not a candidate on this brief`);
    let person = store.people.get(personId) ?? null;
    if (person && !person.confirmed) {
      person = { ...person, confirmed: true };
      store.putPerson(person);
    }
    if (idx === 0 || !person) {
      next = { ...brief, match: { ...brief.match, personId, confidence: "high" } };
    } else {
      const r = await writeBriefCards(brief.query, org, person, "high", notes);
      fallback = r.fallback;
      // Re-read after the LLM await: a slow-path update may have landed meanwhile. Keep its slowPath.
      const cur = store.briefs.get(briefId) ?? brief;
      next = { ...cur, match: { ...cur.match, personId, confidence: "high" }, cards: r.cards };
    }
    if (person) {
      next = { ...next, version: next.version + 1, updatedAt: now() };
      store.briefs.set(next.id, next);
      maybeStartResearch(next, person, org);
      return { brief: store.briefs.get(next.id)!, fallback, notes };
    }
  }
  next = { ...next, version: next.version + 1, updatedAt: now() };
  store.briefs.set(next.id, next);
  return { brief: next, fallback, notes };
}

// ---------------------------------------------------------------------------
// PUT /api/goal with briefId: regenerate card 3 only, keep cards 1-2 byte-for-byte.
// ---------------------------------------------------------------------------

export async function regenerateAngle(briefId: string): Promise<BriefOutcome> {
  const brief = store.briefs.get(briefId);
  if (!brief) throw new CueError("NOT_FOUND", `No brief ${briefId}`, 404);
  const notes: string[] = [];
  if (!brief.cards.some((c) => c.kind === "angle")) {
    notes.push("org-only brief, unchanged");
    return { brief, fallback: false, notes };
  }
  const org = findOrg(brief.query.org);
  const person = brief.match.personId ? store.people.get(brief.match.personId) ?? null : null;
  const { cards, fallback } = await writeBriefCards(
    brief.query, org, person, brief.match.confidence, notes, undefined, ["angle"],
  );
  const angle = cards.find((c) => c.kind === "angle");
  // Re-read after the LLM await: the slow path may have replaced cards 1-2 meanwhile. Change only card 3.
  const cur = store.briefs.get(briefId) ?? brief;
  if (!angle || !cur.cards.some((c) => c.kind === "angle")) return { brief: cur, fallback, notes };
  const next: Brief = {
    ...cur,
    cards: cur.cards.map((c) => (c.kind === "angle" ? angle : c)),
    version: cur.version + 1,
    updatedAt: now(),
  };
  store.briefs.set(next.id, next);
  return { brief: next, fallback, notes };
}
