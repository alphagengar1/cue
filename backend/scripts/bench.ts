// Live-path bench against a RUNNING backend. Spends API credit (Exa, Anthropic, OpenAI): run on purpose.
//
//   cd backend && BASE_URL=http://127.0.0.1:8787 DEVICE_TOKEN=... \
//     $HOME/.nvm/versions/node/v22.18.0/bin/node node_modules/tsx/dist/cli.mjs scripts/bench.ts [--count 10] [--file data/creao-lahacks-sponsors.json]
//
// Sends `count` comma-form lookups ("Name, Org, role") to POST /api/say, one at a time, taken from the
// event file's people (top-level `people` plus each organization's `people` names). If the file has fewer
// people than `count`, the list cycles, so repeats also show warm-path variance.
// Prints p50/p95 of the wall-clock total, per-step timings parsed from the X-Cue-Notes header
// (search, decide, llm, and the backend's own total), and a decision table (match / goalFit / lead) per person.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// --- args / env
const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const BASE_URL = (process.env.BASE_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const DEVICE_TOKEN = process.env.DEVICE_TOKEN ?? "";
const COUNT = Math.max(1, Number(flag("count") ?? 10) || 10);
const FILE = path.resolve(BACKEND_DIR, flag("file") ?? "data/creao-lahacks-sponsors.json");

// --- lookups from the event file
interface EventFile {
  organizations?: { id: string; name: string; people?: string[] }[];
  people?: { name: string; orgId?: string; org?: string; role?: string }[];
}
const data = JSON.parse(fs.readFileSync(FILE, "utf8")) as EventFile;
const orgName = new Map((data.organizations ?? []).map((o) => [o.id, o.name]));
const seen = new Set<string>();
const lookups: { name: string; org: string; role?: string; text: string }[] = [];
const add = (name: string, org: string, role?: string) => {
  const key = `${name}|${org}`.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  lookups.push({ name, org, role, text: [name, org, role].filter(Boolean).join(", ") });
};
for (const p of data.people ?? []) add(p.name, p.org ?? orgName.get(p.orgId ?? "") ?? p.orgId ?? "", p.role);
for (const o of data.organizations ?? []) for (const n of o.people ?? []) add(n, o.name);
if (lookups.length === 0) {
  console.error(`no people in ${path.relative(BACKEND_DIR, FILE)}`);
  process.exit(1);
}
const plan = Array.from({ length: COUNT }, (_, i) => lookups[i % lookups.length]);

// --- one request
interface Row {
  text: string;
  status: number;
  wallMs: number;
  confidence?: string;
  cards?: number;
  fallback: boolean;
  steps: Partial<Record<"search" | "decide" | "llm" | "total", number>>;
  decision?: { match: number; fit: number; lead: string } | "off";
  notes: string;
}

async function say(text: string): Promise<Row> {
  const t0 = Date.now();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (DEVICE_TOKEN) headers.Authorization = `Bearer ${DEVICE_TOKEN}`;
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/api/say`, { method: "POST", headers, body: JSON.stringify({ text }) });
  } catch (err) {
    return { text, status: 0, wallMs: Date.now() - t0, fallback: false, steps: {}, notes: `fetch failed: ${(err as Error).message}` };
  }
  const wallMs = Date.now() - t0;
  const notes = res.headers.get("x-cue-notes") ?? "";
  const row: Row = { text, status: res.status, wallMs, fallback: res.headers.get("x-cue-fallback") === "template", steps: {}, notes };
  if (res.status === 200) {
    const body = (await res.json().catch(() => ({}))) as { brief?: { match?: { confidence?: string }; cards?: unknown[] } };
    row.confidence = body.brief?.match?.confidence;
    row.cards = body.brief?.cards?.length;
  }
  // Notes look like: "org sentry; search 412ms, kept 3/8; decide 290ms match 0.91 fit 1.6 lead connect; llm 2210ms; store 1ms; total 2950ms"
  for (const step of ["search", "decide", "llm", "total"] as const) {
    const m = notes.match(new RegExp(`(?:^|; )${step} (\\d+)ms`));
    if (m) row.steps[step] = Number(m[1]);
  }
  const d = notes.match(/decide \d+ms match ([\d.]+) fit ([\d.]+) lead (\w+)/);
  if (d) row.decision = { match: Number(d[1]), fit: Number(d[2]), lead: d[3] };
  else if (/decide off\/skipped/.test(notes)) row.decision = "off";
  return row;
}

// --- stats / printing
const pct = (xs: number[], p: number): number => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const fmt = (n: number | undefined, w = 6): string => (n === undefined || Number.isNaN(n) ? "-".padStart(w) : String(Math.round(n)).padStart(w));
const pad = (s: string, w: number): string => (s.length > w ? s.slice(0, w - 1) + "~" : s.padEnd(w));

const main = async () => {
  console.log(`bench: ${COUNT} lookups -> ${BASE_URL}/api/say  (people from ${path.relative(BACKEND_DIR, FILE)}: ${lookups.length} unique)`);
  if (!DEVICE_TOKEN) console.log("note: DEVICE_TOKEN not set, sending without Authorization");
  console.log();
  console.log(`${pad("#", 3)} ${pad("lookup", 34)} ${pad("st", 4)} ${"wall".padStart(6)} ${"search".padStart(6)} ${"decide".padStart(6)} ${"llm".padStart(6)} ${"total".padStart(6)}  conf   cards fb`);
  const rows: Row[] = [];
  for (const [i, l] of plan.entries()) {
    const r = await say(l.text);
    rows.push(r);
    console.log(
      `${pad(String(i + 1), 3)} ${pad(l.text, 34)} ${pad(String(r.status), 4)} ${fmt(r.wallMs)} ${fmt(r.steps.search)} ${fmt(r.steps.decide)} ${fmt(r.steps.llm)} ${fmt(r.steps.total)}  ${pad(r.confidence ?? "-", 6)} ${pad(String(r.cards ?? "-"), 5)} ${r.fallback ? "T" : "."}`,
    );
    if (r.status !== 200) console.log(`    ${r.notes || "(no notes)"}`);
  }

  const ok = rows.filter((r) => r.status === 200);
  console.log();
  console.log(`ok ${ok.length}/${rows.length}` + (ok.length < rows.length ? `  (${rows.length - ok.length} failed)` : ""));
  console.log(`${pad("step", 8)} ${"p50".padStart(6)} ${"p95".padStart(6)} ${"max".padStart(6)}  n`);
  const line = (label: string, xs: number[]) =>
    console.log(`${pad(label, 8)} ${fmt(pct(xs, 50))} ${fmt(pct(xs, 95))} ${fmt(xs.length ? Math.max(...xs) : NaN)}  ${xs.length}`);
  line("wall", ok.map((r) => r.wallMs));
  for (const step of ["search", "decide", "llm", "total"] as const) {
    line(step, ok.map((r) => r.steps[step]).filter((x): x is number => x !== undefined));
  }

  console.log();
  console.log("decision gate per person (from X-Cue-Notes)");
  console.log(`${pad("lookup", 34)} ${"match".padStart(6)} ${"fit".padStart(5)}  lead     note`);
  for (const r of ok) {
    if (r.decision === undefined) { console.log(`${pad(r.text, 34)} ${"-".padStart(6)} ${"-".padStart(5)}  -        no decide note (low match or org-only?)`); continue; }
    if (r.decision === "off") { console.log(`${pad(r.text, 34)} ${"-".padStart(6)} ${"-".padStart(5)}  -        off/skipped`); continue; }
    const extra = [
      /match below 0\.6/.test(r.notes) ? "match<0.6 -> no person cards" : "",
      (r.notes.match(/decide dropped (\d+) sensitive/) ?? [])[0] ?? "",
      /fit below|goalFit 0|one quiet line/.test(r.notes) ? "goalFit 0 -> quiet line" : "",
    ].filter(Boolean).join(", ");
    console.log(`${pad(r.text, 34)} ${r.decision.match.toFixed(2).padStart(6)} ${r.decision.fit.toFixed(1).padStart(5)}  ${pad(r.decision.lead, 8)} ${extra}`);
  }
  const fallbacks = ok.filter((r) => r.fallback).length;
  if (fallbacks) console.log(`\n${fallbacks} brief(s) used template cards (X-Cue-Fallback). Check the llm notes above.`);
};

main().catch((err) => { console.error(err); process.exit(1); });
