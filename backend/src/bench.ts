// Latency benchmark against a RUNNING backend: `npm run bench` or `npm run bench -- 10 "Maya, Even Realities, devrel"`.
// Runs N typed lookups (POST /api/briefs/text) one after another and prints per-step timings
// from the Server-Timing header (store, search, llm, total), falling back to X-Cue-Notes.
// Env: BASE_URL (default http://localhost:8787), DEVICE_TOKEN (if the server requires it),
// BENCH_GAP_MS (pause between calls, default 250). Server rate limit: LOOKUPS_PER_MINUTE (default 30).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const envFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const base = (process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 8787}`).replace(/\/$/, "");
const headers: Record<string, string> = { "content-type": "application/json" };
if (process.env.DEVICE_TOKEN) headers.authorization = `Bearer ${process.env.DEVICE_TOKEN}`;
const gapMs = Number(process.env.BENCH_GAP_MS ?? 250);

const args = process.argv.slice(2);
const n = Number(args[0]) > 0 ? Number(args[0]) : 5;
const texts = args.slice(Number(args[0]) > 0 ? 1 : 0);
if (!texts.length) texts.push("Maya, Even Realities, devrel", "Sam Park, CREAO", "Jordan, Sentry, developer advocate");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseTimings(serverTiming: string | null, notes: string): Record<string, number> {
  const out: Record<string, number> = {};
  if (serverTiming) {
    for (const part of serverTiming.split(",")) {
      const m = part.trim().match(/^([\w.-]+).*?dur=([\d.]+)/);
      if (m) out[m[1]] = Number(m[2]);
    }
  }
  if (!Object.keys(out).length) {
    for (const m of notes.matchAll(/\b(\w+) (\d+)ms\b/g)) out[m[1]] = Number(m[2]);
  }
  return out;
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};

const samples: Record<string, number[]> = {};
let fallbacks = 0;
let errors = 0;

console.log(`bench: ${n} lookups against ${base}\n`);
for (let i = 0; i < n; i++) {
  const text = texts[i % texts.length];
  const t0 = performance.now();
  let res: Response;
  try {
    res = await fetch(`${base}/api/briefs/text`, { method: "POST", headers, body: JSON.stringify({ text }) });
  } catch (err) {
    console.error(`#${i + 1} cannot reach ${base}: ${String(err)}`);
    process.exit(1);
  }
  const body = (await res.json().catch(() => ({}))) as { brief?: { match: { confidence: string }; cards: unknown[] }; error?: { code: string; message: string } };
  const client = Math.round(performance.now() - t0);
  if (res.status === 429) {
    console.log(`#${i + 1} rate limited; waiting 60s (raise LOOKUPS_PER_MINUTE on the server to avoid this)`);
    await sleep(60_000);
    i--;
    continue;
  }
  if (!res.ok || !body.brief) {
    errors++;
    console.log(`#${i + 1} ${res.status} ${body.error?.code ?? ""} ${body.error?.message ?? ""} (${client}ms)`);
    continue;
  }
  const notes = res.headers.get("x-cue-notes") ?? "";
  const fb = res.headers.get("x-cue-fallback");
  if (fb) fallbacks++;
  const t = { ...parseTimings(res.headers.get("server-timing"), notes), client };
  for (const [k, v] of Object.entries(t)) (samples[k] ??= []).push(v);
  const steps = Object.entries(t).map(([k, v]) => `${k}=${v}`).join(" ");
  console.log(`#${i + 1} "${text}" -> ${body.brief.match.confidence}, ${body.brief.cards.length} cards${fb ? `, fallback ${fb}` : ""} | ${steps}`);
  console.log(`     notes: ${notes}`);
  if (gapMs > 0 && i < n - 1) await sleep(gapMs);
}

console.log(`\n${"step".padEnd(8)} ${"n".padStart(3)} ${"min".padStart(6)} ${"p50".padStart(6)} ${"p95".padStart(6)} ${"max".padStart(6)} ${"mean".padStart(6)}`);
const order = ["store", "search", "llm", "total", "client"];
const keys = [...order.filter((k) => samples[k]), ...Object.keys(samples).filter((k) => !order.includes(k))];
for (const k of keys) {
  const xs = samples[k];
  const mean = Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
  console.log(`${k.padEnd(8)} ${String(xs.length).padStart(3)} ${String(Math.min(...xs)).padStart(6)} ${String(pct(xs, 50)).padStart(6)} ${String(pct(xs, 95)).padStart(6)} ${String(Math.max(...xs)).padStart(6)} ${String(mean).padStart(6)}`);
}
console.log(`\nfallbacks: ${fallbacks}/${n - errors}, errors: ${errors}`);
console.log("Note: search/llm include the no-key fallback path when keys are missing (near 0ms).");
