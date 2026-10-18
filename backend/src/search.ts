// Fast-path person search: Exa (03 section 4, "Fast-path implementation").
// Two parallel searches, linkedin.com excluded at search time, then the name AND org filter.
import type { Fact, SourceKind } from "../../shared/types.js";
import { config } from "./config.js";
import { filterFacts, hostOf, isLinkedIn } from "./safety.js";

export interface SearchResult {
  title: string;
  url: string;
  text: string;           // highlights joined (or text), for filtering and facts
  publishedDate?: string;
}

export class SearchUnavailable extends Error {}

interface ExaResponse {
  results?: { title?: string | null; url: string; text?: string; highlights?: string[]; publishedDate?: string | null }[];
}

async function exaSearch(query: string, category?: string): Promise<SearchResult[]> {
  const body: Record<string, unknown> = {
    query,
    type: "fast",
    numResults: 8,
    excludeDomains: ["linkedin.com"],
    contents: { highlights: { maxCharacters: 500 } },
  };
  if (category) body.category = category;
  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "x-api-key": config.exaKey!, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.searchTimeoutMs),
  });
  if (!res.ok) throw new Error(`Exa ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as ExaResponse;
  return (data.results ?? []).map((r) => ({
    title: r.title ?? "",
    url: r.url,
    text: (r.highlights?.length ? r.highlights.join(" ... ") : r.text ?? "").slice(0, 1500),
    publishedDate: r.publishedDate ?? undefined,
  }));
}

/**
 * Run search A (query, usually "<name> <org>") and search B (same, category "personal site")
 * in parallel. Throws SearchUnavailable if there is no key or both calls fail.
 */
export async function searchPerson(query: string): Promise<SearchResult[]> {
  if (!config.exaKey) throw new SearchUnavailable("EXA_API_KEY not set");
  const q = query.replace(/\s+/g, " ").trim();
  const settled = await Promise.allSettled([exaSearch(q), exaSearch(q, "personal site")]);
  const ok = settled.filter((s): s is PromiseFulfilledResult<SearchResult[]> => s.status === "fulfilled");
  if (!ok.length) {
    const reason = settled.map((s) => (s.status === "rejected" ? String(s.reason) : "")).join("; ");
    throw new SearchUnavailable(reason);
  }
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of ok.flatMap((s) => s.value)) {
    if (seen.has(r.url) || isLinkedIn(r.url)) continue;
    seen.add(r.url);
    out.push(r);
  }
  return out;
}

const contains = (hay: string, needle: string): boolean =>
  !!needle && hay.toLowerCase().includes(needle.toLowerCase());

/**
 * Disambiguation rule (03 section 4): keep a result only if its title or text mentions
 * the person's name AND the org name (or an alias).
 */
export function filterResults(results: SearchResult[], name: string, orgLabels: string[]): SearchResult[] {
  const labels = orgLabels.filter(Boolean);
  return results.filter((r) => {
    const hay = `${r.title}\n${r.text}`;
    return contains(hay, name) && labels.some((l) => contains(hay, l));
  });
}

/**
 * When only a first name was said, find distinct "<First> <Last>" full names in kept results.
 * Used to fill `candidates` when results name 2+ different people.
 */
export function fullNamesIn(results: SearchResult[], firstName: string): string[] {
  const re = new RegExp(`\\b${firstName.replace(/[^A-Za-z'-]/g, "")}\\s+([A-Z][a-zA-Z'-]+)\\b`, "g");
  const counts = new Map<string, number>();
  for (const r of results) {
    const found = new Set<string>();
    for (const m of `${r.title} ${r.text}`.matchAll(re)) found.add(`${firstName} ${m[1]}`);
    for (const n of found) counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
}

const PRIORITY: SourceKind[] = [
  "talk", "podcast", "own_post", "personal_site", "github", "article",
  "school_page", "team_page", "org_site", "search_snippet",
];

export function classifySource(url: string, orgDomains: string[] = []): SourceKind {
  const h = hostOf(url);
  const p = (() => { try { return new URL(url).pathname.toLowerCase(); } catch { return ""; } })();
  if (/(youtube\.com|youtu\.be|vimeo\.com)$/.test(h) || /\/(talks?|conference|keynote)s?\//.test(p)) return "talk";
  if (/(podcasts\.apple\.com|spotify\.com|transistor\.fm|simplecast|buzzsprout|anchor\.fm)/.test(h) || p.includes("podcast")) return "podcast";
  if (h === "github.com" || h.endsWith("github.io")) return "github";
  if (/(medium\.com|substack\.com|dev\.to|hashnode)/.test(h) || h === "x.com" || h === "twitter.com") return "own_post";
  if (h.endsWith(".edu")) return "school_page";
  if (orgDomains.some((d) => h === d || h.endsWith("." + d))) {
    return /\/(team|about|people|leadership)/.test(p) ? "team_page" : "org_site";
  }
  if (/(news|techcrunch|forbes|wired|theverge|bloomberg|reuters)/.test(h)) return "article";
  return "search_snippet";
}

/** Kept results -> Facts: one sentence each, <= 140 chars, safety-filtered, sorted by source priority, max 8. */
export function resultsToFacts(results: SearchResult[], orgDomains: string[] = []): Fact[] {
  const facts: Fact[] = results.map((r) => {
    const sentence = (r.text || r.title).replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s/)[0] ?? "";
    const text = sentence.length > 140 ? sentence.slice(0, 137).trimEnd() + "..." : sentence;
    const fact: Fact = { text, sourceUrl: r.url, sourceKind: classifySource(r.url, orgDomains) };
    if (r.publishedDate) fact.date = r.publishedDate.slice(0, 10);
    return fact;
  }).filter((f) => f.text);
  return filterFacts(facts)
    .sort((a, b) => PRIORITY.indexOf(a.sourceKind) - PRIORITY.indexOf(b.sourceKind))
    .slice(0, 8);
}
