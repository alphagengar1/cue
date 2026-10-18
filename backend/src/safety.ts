// Safety filter and card limits (03 section 6, 02 section 2, 04 section 8).
import { z } from "zod";
import type { Card, Fact, SourceKind } from "../../shared/types.js";

// Whole words, or stems ending in "*" (match any suffix). Multi-word terms match across any whitespace.
const BLOCKLIST = [
  "wife", "husband", "spouse", "girlfriend", "boyfriend", "kids", "children", "daughter", "son",
  "married", "divorce*", "pregnan*", "home address", "lives in", "diagnos*", "illness",
  "cancer", "disease", "church", "religio*", "mosque", "synagogue", "temple", "democrat*",
  "republican*", "political", "politics", "years old", "born in",
];
// Terms that are not personal when used Capitalized inside a proper name
// ("Temple University", "Children's Hospital", "Cancer Center", "Political Science").
const PROPER_NOUN_OK = new Set(["temple", "children", "church", "son", "cancer", "disease", "political", "politics"]);
const esc = (w: string) => w.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
const BLOCK_RE = new RegExp(
  `\\b(${BLOCKLIST.map((w) => (w.endsWith("*") ? esc(w.slice(0, -1)) + "\\w*" : esc(w))).join("|")})\\b`,
  "gi",
);

export function isSensitive(text: string): boolean {
  for (const m of text.matchAll(BLOCK_RE)) {
    const term = m[0].toLowerCase();
    const after = text.slice(m.index + m[0].length);
    const inProperName = PROPER_NOUN_OK.has(term) && /^[A-Z]/.test(m[0]) && /^('s)?\s+[A-Z]/.test(after);
    if (!inProperName) return true;
  }
  return false;
}

export const hostOf = (url: string): string => {
  try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; }
};

export const isLinkedIn = (url: string): boolean => {
  const h = hostOf(url);
  return h === "linkedin.com" || h.endsWith(".linkedin.com");
};

/** Drop blocklisted facts and any linkedin.com source. */
export function filterFacts(facts: Fact[]): Fact[] {
  return facts.filter((f) => !isLinkedIn(f.sourceUrl) && !isSensitive(f.text));
}

// Search-snippet sentences that are page chrome, not content (cookie banners, nav links).
const BOILERPLATE_RE = /\b(skip to (main )?content|cookie|sign (in|up)|log ?in|subscribe|newsletter|menu|navigation|privacy policy|terms of (use|service)|all rights reserved|javascript|accept all|toggle|breadcrumb)\b|^(home|about|blog|search)\b\s*[|>/]/i;

/** True for snippet text that is navigation/boilerplate or too short to open a conversation with. */
export const isBoilerplate = (s: string): boolean => s.trim().length < 25 || BOILERPLATE_RE.test(s);

export const SOURCE_KINDS: SourceKind[] = ["talk", "podcast", "own_post", "personal_site", "github",
  "article", "school_page", "team_page", "org_site", "search_snippet"];
const SOURCE_RANK = new Map(SOURCE_KINDS.map((k, i) => [k, i]));

/** Dedupe by URL, sort by source priority (03 section 4), max 8. */
export function sortFacts(facts: Fact[]): Fact[] {
  const seen = new Set<string>();
  return facts
    .filter((f) => (seen.has(f.sourceUrl) ? false : (seen.add(f.sourceUrl), true)))
    .sort((a, b) => (SOURCE_RANK.get(a.sourceKind) ?? 99) - (SOURCE_RANK.get(b.sourceKind) ?? 99))
    .slice(0, 8);
}

const RawFact = z.object({
  text: z.string().min(1),
  sourceUrl: z.string().url(),
  sourceKind: z.string().optional(),
  date: z.string().nullish(),
});

/** Validate, clip and safety-filter facts from agent output (CREAO runs and hand-run JSON in data/*.json). */
export function cleanFacts(raw: unknown, max: number, defaultKind: SourceKind): Fact[] {
  if (!Array.isArray(raw)) return [];
  const facts: Fact[] = [];
  for (const f of raw) {
    const p = RawFact.safeParse(f);
    if (!p.success || !/^https?:\/\//i.test(p.data.sourceUrl)) continue;
    const kind = SOURCE_KINDS.includes(p.data.sourceKind as SourceKind) ? (p.data.sourceKind as SourceKind) : defaultKind;
    const text = clip(sanitize(p.data.text).replace(/\s+/g, " ").trim(), 140);
    if (!text) continue;
    facts.push({ text, sourceUrl: p.data.sourceUrl, sourceKind: kind, ...(p.data.date ? { date: p.data.date } : {}) });
  }
  return filterFacts(facts).slice(0, max);
}

const words = (s: string): string => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;

/**
 * Backend re-check for agent facts (03 section 4): the fact must name the person (full name, or
 * first and last name) AND the org (name/alias in the text, or a label/org domain in the URL).
 */
export function factAboutPerson(f: Fact, name: string, orgLabels: string[], orgHosts: string[] = []): boolean {
  const t = words(f.text);
  const url = f.sourceUrl.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const has = (w: string) => w.trim().length > 0 && t.includes(words(w));
  const toks = words(name).trim().split(" ").filter(Boolean);
  if (!toks.length) return false;
  const first = toks[0], last = toks[toks.length - 1];
  const nameOk = has(name) || (toks.length > 1 && has(first) && has(last)) || (toks.length > 1 && url.includes(first + last));
  const host = hostOf(f.sourceUrl);
  const orgOk = orgLabels.some((l) => {
    const n = l.toLowerCase().replace(/[^a-z0-9]+/g, "");
    return n.length >= 3 && (has(l) || url.includes(n));
  }) || orgHosts.some((d) => d && (host === d || host.endsWith("." + d)));
  return nameOk && orgOk;
}

// ASCII plus the safe glyph list from 02 section 2.
const SAFE_GLYPHS = new Set([..."━─█▲▼●○■□★│╭╮╯╰"]);
const REPLACE: Record<string, string> = {
  "‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-",
  "…": "...", "·": "|", "•": "-", " ": " ", "✓": "", "\t": " ", "\r": " ",
};

export function sanitize(s: string): string {
  let out = "";
  for (const ch of s.normalize("NFKD")) {
    if (REPLACE[ch] !== undefined) out += REPLACE[ch];
    else if (ch === "\n" || (ch >= " " && ch <= "~")) out += ch;
    else if (SAFE_GLYPHS.has(ch)) out += ch;
    // anything else (accents after NFKD, emoji, CJK) is dropped
  }
  return out;
}

export const LIMITS = { title: 20, body: 200, lines: 5, lineChars: 40, source: 34 } as const;

const clip = (s: string, n: number): string =>
  s.length <= n ? s : s.slice(0, Math.max(0, n - 3)).trimEnd() + "...";

const DEFAULT_TITLE: Record<Card["kind"], string> = { connect: "Connect", context: "Context", angle: "Your angle" };

/** Titles over the limit are cut at a word boundary (no "..."); a stub falls back to the card name. */
function fitTitle(t: string, kind: Card["kind"]): string {
  if (t.length <= LIMITS.title) return t || DEFAULT_TITLE[kind];
  const head = t.slice(0, LIMITS.title + 1);
  // No space to cut at (one long word): hard cut at the limit.
  const cut = (/\s/.test(head) ? head.replace(/\s+\S*$/, "") : head.slice(0, LIMITS.title)).replace(/[\s,;:'-]+$/, "");
  return cut.length >= 8 ? cut.slice(0, LIMITS.title) : DEFAULT_TITLE[kind];
}

/** Greedy word wrap into <= lineChars lines, <= lines lines, <= body chars total. */
export function wrapBody(text: string): string {
  const words = sanitize(text).replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (let w of words) {
    while (w.length > LIMITS.lineChars) { // hard-split very long tokens (URLs)
      if (cur) { lines.push(cur); cur = ""; }
      lines.push(w.slice(0, LIMITS.lineChars));
      w = w.slice(LIMITS.lineChars);
    }
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= LIMITS.lineChars) cur += " " + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  let kept = lines.slice(0, LIMITS.lines);
  if (lines.length > LIMITS.lines) {
    const last = kept[kept.length - 1];
    kept[kept.length - 1] = last.slice(0, LIMITS.lineChars - 3).trimEnd() + "...";
  }
  let body = kept.join("\n");
  while (body.length > LIMITS.body && kept.length > 1) {
    kept = kept.slice(0, -1);
    body = kept.join("\n");
  }
  return body.slice(0, LIMITS.body);
}

/** Bare domain/path, no scheme/www/"src:", <= 34 chars. */
export function cleanSource(src: string | null | undefined): string | null {
  if (!src) return null;
  let s = sanitize(src).trim().replace(/^src:\s*/i, "").replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  s = s.replace(/[?#].*$/, "").replace(/\/+$/, "");
  if (!s) return null;
  if (s.length > LIMITS.source) {
    // keep the host plus as much of the path as fits
    const [host, ...rest] = s.split("/");
    s = host.slice(0, LIMITS.source);
    for (const seg of rest) {
      if (s.length + 1 + seg.length > LIMITS.source) break;
      s += "/" + seg;
    }
  }
  return s;
}

/** Host of a cleaned card source ("anduril.com/blog" -> "anduril.com"); "" if it is not a domain. */
const sourceHost = (src: string): string => {
  const h = src.split("/")[0].toLowerCase().replace(/^www\./, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h) ? h : "";
};
const sameSite = (a: string, b: string): boolean => a === b || a.endsWith("." + b) || b.endsWith("." + a);

/**
 * Enforce card limits and source rules. Drops connect/context cards with no source, any card
 * citing linkedin.com, and any card that trips the sensitive-topic blocklist (title or body).
 * `opts.allowedHosts` (hosts of the facts the model was given): a connect/context card citing any
 * other host is dropped (the caller's template fills the gap); an angle card's source is set to null.
 */
export function enforceCards(cards: Card[], opts: { allowedHosts?: string[] } = {}): Card[] {
  const allowed = opts.allowedHosts?.map((h) => h.toLowerCase().replace(/^www\./, "")).filter(Boolean);
  const out: Card[] = [];
  for (const c of cards) {
    const title = sanitize(c.title).replace(/\s+/g, " ").trim();
    const card: Card = {
      kind: c.kind,
      title: fitTitle(title, c.kind),
      body: wrapBody(c.body),
      source: cleanSource(c.source),
    };
    if (!card.body) continue;
    if (card.source && isLinkedIn(`https://${card.source}`)) {
      if (card.kind !== "angle") continue;
      card.source = null;
    }
    if (card.source && allowed) {
      const h = sourceHost(card.source);
      if (!h || !allowed.some((a) => sameSite(h, a))) {
        if (card.kind !== "angle") continue;
        card.source = null;
      }
    }
    if (card.kind !== "angle" && !card.source) continue;
    // Check the unwrapped text: wrapping puts "\n" inside multi-word terms like "lives in".
    if (isSensitive(title) || isSensitive(sanitize(c.body).replace(/\s+/g, " "))) continue;
    out.push(card);
  }
  return out;
}
