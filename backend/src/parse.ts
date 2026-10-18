// Transcript -> { name, org, role } and org/person lookup (01 section 5, "Parsing" and "Lookup rules").
import type { Organization, Person, Query } from "../../shared/types.js";
import { norm, store } from "./store.js";

const clean = (s: string): string => s.replace(/[.?!;:"]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * 1. If the text splits on commas into 2-3 parts: name, org, role.
 * 2. Else find the longest org name/alias from the store inside the text:
 *    words before = name, words after = role.
 * 3. Else (unknown org, no commas): first word = name, last word = role if 3+ words, rest = org.
 */
export function parseTranscript(text: string, orgs: Organization[] = store.eventOrgs()): Query {
  const t = clean(text);
  const parts = t.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2 && parts.length <= 3) {
    const [name, org, role] = parts;
    return role ? { name, org, role } : { name, org };
  }

  const flat = parts.join(" ");
  const lower = flat.toLowerCase();
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
  if (best) {
    const name = flat.slice(0, best.start).trim();
    const org = flat.slice(best.start, best.end).trim();
    const role = flat.slice(best.end).trim();
    return role ? { name, org, role } : { name, org };
  }

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
 * Person at that org with that first name, return that person.
 */
export function findStoredPerson(name: string, org: Organization | null): Person | null {
  if (!org || !name) return null;
  const atOrg = store.eventPeople(org.eventId).filter((p) => p.orgId === org.id);
  const full = atOrg.filter((p) => norm(p.name) === norm(name));
  if (full.length === 1) return full[0];
  const first = norm(name.split(" ")[0]);
  const byFirst = atOrg.filter((p) => norm(p.name.split(" ")[0]) === first);
  return byFirst.length === 1 && !name.includes(" ") ? byFirst[0] : null;
}
