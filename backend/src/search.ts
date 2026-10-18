// Fast-path person search: Exa (03 section 4, "Fast-path implementation").
// Two parallel searches, linkedin.com excluded at search time, then the name AND org filter.
import type { Fact, SourceKind } from "../../shared/types.js";
import { config } from "./config.js";
import { blockLinkedIn, filterFacts, hostOf, isBoilerplate, isLinkedIn } from "./safety.js";

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
    ...(blockLinkedIn() ? { excludeDomains: ["linkedin.com"] } : {}),
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
 * One Exa search for "<event> sponsors", for an event that arrives with no org list ("I'm going to
 * LA Hacks tomorrow"). Returns the results as text for the Research agent's sourceText, or "" when
 * there is no key, nothing came back or Exa failed: the agent then finds the event on its own.
 */
export async function searchEventSponsors(eventName: string): Promise<string> {
  const name = eventName.replace(/\s+/g, " ").trim();
  if (!config.exaKey || !name) return "";
  try {
    const results = await exaSearch(`${name} sponsors`);
    return results
      .filter((r) => r.title.trim() || r.text.trim())
      .slice(0, 6)
      .map((r) => [r.title || r.url, r.url, r.text].filter(Boolean).join("\n"))
      .join("\n\n");
  } catch (err) {
    console.warn(`[search] "${name} sponsors" search failed: ${err instanceof Error ? err.message : String(err)}`);
    return "";
  }
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
    if (seen.has(r.url) || (blockLinkedIn() && isLinkedIn(r.url))) continue;
    seen.add(r.url);
    out.push(r);
  }
  return out;
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whole-word, case-insensitive ("Sam" does not match "Samsung", "Even" needs to stand alone). */
const containsWord = (hay: string, needle: string): boolean =>
  !!needle.trim() && new RegExp(`(^|[^A-Za-z0-9])${escRe(needle.trim()).replace(/\s+/g, "\\s+")}($|[^A-Za-z0-9])`, "i").test(hay);

// Aliases that are everyday English words match too much prose ("even though", "open to").
const COMMON_WORDS = new Set([
  "even", "open", "one", "go", "get", "all", "best", "first", "next", "new", "now", "just", "may", "will",
  "can", "well", "real", "true", "here", "there", "about", "more", "like", "time", "work", "home", "help",
  "made", "make", "line", "base", "scale", "square", "notion", "ramp", "box", "bolt", "loom", "zoom",
  "apple", "oracle", "slack", "signal",
]);

/**
 * Disambiguation rule (03 section 4): keep a result only if its title or text mentions
 * the person's name AND the org name (or an alias), as whole words. orgLabels[0] is the org's
 * name and is always used; other aliases are ignored if under 4 chars or a common English word.
 */
export function filterResults(results: SearchResult[], name: string, orgLabels: string[]): SearchResult[] {
  const [main, ...aliases] = orgLabels.map((l) => l.trim()).filter(Boolean);
  const labels = [main, ...aliases.filter((a) => a.length >= 4 && !COMMON_WORDS.has(a.toLowerCase()))].filter(Boolean);
  return results.filter((r) => {
    const hay = `${r.title}\n${r.text}`;
    return containsWord(hay, name) && labels.some((l) => containsWord(hay, l));
  });
}

// Words that follow a first name in headlines but are not surnames ("Priya Speaks at ...").
const NOT_SURNAMES = new Set([
  "speaks", "says", "said", "talks", "joins", "joined", "leads", "led", "will", "and", "the", "from", "at", "is",
  "was", "has", "had", "shares", "explains", "discusses", "presents", "announces", "launches", "builds", "writes",
  "wins", "named", "about", "on", "in", "with", "for", "to", "of", "interview", "podcast", "blog", "team",
  "keynote", "talk", "episode", "profile", "bio", "github", "home", "posts", "news", "update", "here", "who",
]);

/**
 * When only a first name was said, find distinct "<First> <Last>" full names in kept results.
 * Used to fill `candidates` when results name 2+ different people. The first name matches
 * case-insensitively; the surname must look like one (Capitalized, not a common headline word).
 */
export function fullNamesIn(results: SearchResult[], firstName: string): string[] {
  const first = firstName.replace(/[^A-Za-z'-]/g, "");
  if (!first) return [];
  const ci = [...first].map((c) => (/[a-z]/i.test(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : c)).join("");
  const re = new RegExp(`\\b${ci}\\s+([A-Z][a-z'-]+(?:-[A-Z][a-z]+)?)\\b`, "g");
  const counts = new Map<string, number>();
  for (const r of results) {
    const found = new Set<string>();
    for (const m of `${r.title} ${r.text}`.matchAll(re)) {
      if (m[1].length < 2 || NOT_SURNAMES.has(m[1].toLowerCase())) continue;
      found.add(`${firstName} ${m[1]}`);
    }
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
    // First sentence that is real content (skip "Skip to main content", cookie banners, nav crumbs).
    const sentences = (r.text || r.title).replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s|\s+\.\.\.\s+/);
    const sentence = sentences.find((x) => !isBoilerplate(x)) ?? (isBoilerplate(r.title) ? "" : r.title);
    const text = sentence.length > 140 ? sentence.slice(0, 137).trimEnd() + "..." : sentence;
    const fact: Fact = { text, sourceUrl: r.url, sourceKind: classifySource(r.url, orgDomains) };
    if (r.publishedDate) fact.date = r.publishedDate.slice(0, 10);
    return fact;
  }).filter((f) => f.text);
  return filterFacts(facts)
    .sort((a, b) => PRIORITY.indexOf(a.sourceKind) - PRIORITY.indexOf(b.sourceKind))
    .slice(0, 8);
}
