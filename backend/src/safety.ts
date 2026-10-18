// Safety filter and card limits (03 section 6, 02 section 2, 04 section 8).
import type { Card, Fact } from "../../shared/types.js";

// Whole words, or stems ending in "*" (match any suffix).
const BLOCKLIST = [
  "wife", "husband", "spouse", "girlfriend", "boyfriend", "kids", "children", "daughter", "son",
  "married", "divorce*", "pregnan*", "home address", "lives in", "diagnos*", "illness",
  "cancer", "disease", "church", "religio*", "mosque", "synagogue", "temple", "democrat*",
  "republican*", "political", "politics", "years old", "born in",
];
const esc = (w: string) => w.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
const BLOCK_RE = new RegExp(
  `\\b(${BLOCKLIST.map((w) => (w.endsWith("*") ? esc(w.slice(0, -1)) + "\\w*" : esc(w))).join("|")})\\b`,
  "i",
);

export const isSensitive = (text: string): boolean => BLOCK_RE.test(text);

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

// ASCII plus the safe glyph list from 02 section 2.
const SAFE_GLYPHS = new Set([..."━─█▲▼●○■□★│╭╮╯╰"]);
const REPLACE: Record<string, string> = {
  "‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-",
  "…": "...", "·": "|", "•": "-", " ": " ", "✓": "",
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
  const cut = t.slice(0, LIMITS.title + 1).replace(/\s+\S*$/, "").replace(/[\s,;:'-]+$/, "");
  return cut.length >= 8 ? cut : DEFAULT_TITLE[kind];
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

/**
 * Enforce card limits and source rules. Drops connect/context cards with no source
 * and any card that trips the sensitive-topic blocklist.
 */
export function enforceCards(cards: Card[]): Card[] {
  const out: Card[] = [];
  for (const c of cards) {
    const card: Card = {
      kind: c.kind,
      title: fitTitle(sanitize(c.title).replace(/\s+/g, " ").trim(), c.kind),
      body: wrapBody(c.body),
      source: cleanSource(c.source),
    };
    if (!card.body) continue;
    if (card.kind !== "angle" && !card.source) continue;
    if (isSensitive(card.body)) continue;
    out.push(card);
  }
  return out;
}
