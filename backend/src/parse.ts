// Transcript -> { name, org, role } and org/person lookup (01 section 5, "Parsing" and "Lookup rules").
import type { Organization, Person, Query } from "../../shared/types.js";
import { norm, store } from "./store.js";

// Strip sentence punctuation but keep dots inside words ("Sentry.io", "Next.js").
const clean = (s: string): string =>
  s.replace(/[?!;:"]+/g, " ").replace(/\.(?!\w)|(?<!\w)\./g, " ").replace(/\s+/g, " ").trim();

// Spoken lead-ins before a name, and connectors between name and org ("um this is Alex Kim from ...").
const FILLERS = ["um", "uh", "hi", "hey", "hello", "oh", "ok", "okay", "so", "and", "this is", "i'm", "i am",
  "my name is", "name's", "meet", "that's", "thats", "it's", "its", "here's"];
const CONNECTORS = ["from", "at", "with", "of", "who's", "who is", "and"];
const FILLER_RE = new RegExp(`^(?:(?:${FILLERS.join("|")})(?:\\s+|$))+`, "i");
const CONNECTOR_RE = new RegExp(`(?:^|\\s+)(?:${CONNECTORS.join("|")})$`, "i");
const LEAD_CONNECTOR_RE = new RegExp(`^(?:${CONNECTORS.join("|")})(?:\\s+|$)`, "i");

const tidyName = (s: string): string => {
  let t = s.replace(/,/g, " ").replace(/\s+/g, " ").trim().replace(FILLER_RE, "");
  for (let prev = ""; prev !== t;) { prev = t; t = t.replace(CONNECTOR_RE, "").trim(); }
  return t;
};
const tidyRole = (s: string): string => {
  let t = s.replace(/,/g, " ").replace(/\s+/g, " ").trim();
  for (let prev = ""; prev !== t;) { prev = t; t = t.replace(LEAD_CONNECTOR_RE, "").replace(CONNECTOR_RE, "").trim(); }
  return t;
};

/** Longest org name/alias from the store inside `text` (whole words, case-insensitive). */
function findOrgSpan(text: string, orgs: Organization[]): { start: number; end: number } | null {
  const lower = text.toLowerCase();
  let best: { start: number; end: number } | null = null;
  for (const o of orgs) {
    for (const label of [o.name, ...o.aliases]) {
      const l = label.toLowerCase();
      if (!l) continue;
      const re = new RegExp(`(^|\\W)${l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\W|$)`);
      const m = re.exec(lower);
      if (!m) continue;
      const start = m.index + m[1].length;
      const end = start + l.length;
      if (!best || end - start > best.end - best.start) best = { start, end };
    }
  }
  return best;
}

const withRole = (name: string, org: string, role: string): Query => (role ? { name, org, role } : { name, org });

/**
 * 1. Find the longest org name/alias from the store inside the text: words before = name
 *    (fillers like "um this is" and connectors like "from" dropped; if the text before the org has
 *    commas, the first non-filler part is the name and the rest is the role), words after = role.
 * 2. Else, if the text splits on commas into 2-3 parts: name, org, role ("recruiter at X" -> role, org).
 * 3. Else (unknown org, no commas): "<name> from/at <org>", or first word = name,
 *    last word = role if 3+ words, rest = org.
 */
export function parseTranscript(text: string, orgs: Organization[] = store.eventOrgs()): Query {
  const t = clean(text);
  const best = findOrgSpan(t, orgs);
  if (best) {
    const before = t.slice(0, best.start);
    const org = t.slice(best.start, best.end).trim();
    let role = tidyRole(t.slice(best.end));
    let name = tidyName(before);
    if (before.includes(",")) {
      const parts = before.split(",").map(tidyName).filter(Boolean);
      name = parts[0] ?? "";
      if (!role) role = tidyRole(parts.slice(1).join(" "));
    }
    return withRole(name, org, role);
  }

  const parts = t.split(",").map((p) => p.trim()).filter(Boolean);
  while (parts.length > 1 && !tidyName(parts[0])) parts.shift(); // "Hi, Priya, ..." -> drop the greeting
  if (parts.length >= 2 && parts.length <= 3) {
    const name = tidyName(parts[0]);
    let [, org, role] = parts;
    const at = /^(.+?)\s+(?:at|from|with)\s+(.+)$/i.exec(org);
    if (at && !role) { role = at[1]; org = at[2]; }
    return withRole(name, org, role ?? "");
  }

  const flat = tidyRole(parts.join(" ").replace(FILLER_RE, ""));
  const from = /^(.+?)\s+(?:from|at|with)\s+(.+)$/i.exec(flat);
  if (from) return { name: from[1], org: from[2] };
  const words = flat.split(" ").filter(Boolean);
  if (words.length >= 3) {
    return { name: words[0], org: words.slice(1, -1).join(" "), role: words[words.length - 1] };
  }
  return { name: words[0] ?? "", org: words[1] ?? "" };
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/** Exact or alias match, then case-insensitive fuzzy match. */
export function findOrg(orgText: string, orgs: Organization[] = store.eventOrgs()): Organization | null {
  const q = norm(orgText);
  if (!q) return null;
  const labels = (o: Organization) => [o.id, o.name, ...o.aliases].map(norm).filter(Boolean);
  const exact = orgs.find((o) => labels(o).includes(q));
  if (exact) return exact;
  let best: { org: Organization; score: number } | null = null;
  for (const o of orgs) {
    for (const l of labels(o)) {
      const dist = levenshtein(q, l);
      const score = dist / Math.max(q.length, l.length);
      if (score <= 0.3 && (!best || score < best.score)) best = { org: o, score };
    }
  }
  return best?.org ?? null;
}

/**
 * Name expansion: if the wearer said only a first name and the store has exactly one
 * Person at that org with that first name, return that person. Only known people count:
 * from the event list, or confirmed by the wearer. Search guesses saved as Person records do not.
 */
export function findStoredPerson(name: string, org: Organization | null): Person | null {
  if (!org || !name) return null;
  const atOrg = store.eventPeople(org.eventId).filter((p) => p.orgId === org.id && (p.fromEventList || p.confirmed));
  const full = atOrg.filter((p) => norm(p.name) === norm(name));
  if (full.length === 1) return full[0];
  const first = norm(name.split(" ")[0]);
  const byFirst = atOrg.filter((p) => norm(p.name.split(" ")[0]) === first);
  if (byFirst.length === 1 && !name.includes(" ")) return byFirst[0];
  return fuzzyPerson(name, atOrg);
}

/**
 * Misheard names: STT gives "David Kramer" for David Cramer. Within the people at the org (or, with
 * no org match, every listed attendee), accept a unique person whose normalized full name is within
 * 2 edits, or whose first name matches and last name is within 2 edits. Never applied to search
 * guesses, only to the event list.
 */
export function fuzzyPerson(name: string, pool: Person[]): Person | null {
  const n = norm(name);
  if (n.length < 5 || !name.trim().includes(" ")) return null;
  const [first, ...rest] = name.trim().split(/\s+/);
  const last = norm(rest.join(" "));
  const hits = pool.filter((p) => {
    const pn = norm(p.name);
    if (levenshtein(pn, n) <= 2) return true;
    const [pf, ...pr] = p.name.trim().split(/\s+/);
    return norm(pf) === norm(first) && !!last && levenshtein(norm(pr.join(" ")), last) <= 2;
  });
  return hits.length === 1 ? hits[0] : null;
}

/** With no org match, a listed attendee whose name is a near-miss of what was heard. */
export function findListedPersonByName(name: string, eventId: string | null = store.activeEventId): Person | null {
  if (!eventId) return null;
  const listed = store.eventPeople(eventId).filter((p) => p.fromEventList || p.confirmed);
  const exact = listed.filter((p) => norm(p.name) === norm(name));
  if (exact.length === 1) return exact[0];
  return fuzzyPerson(name, listed);
}
