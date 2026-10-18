// Smoke test against a RUNNING backend: `npm run smoke` (or `npm run smoke -- "Maya, Even Realities, devrel"`).
// Env: BASE_URL (default http://localhost:8787), DEVICE_TOKEN (if the server requires it).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const envFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const base = (process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 8787}`).replace(/\/$/, "");
const headers: Record<string, string> = { "content-type": "application/json" };
if (process.env.DEVICE_TOKEN) headers.authorization = `Bearer ${process.env.DEVICE_TOKEN}`;
const text = process.argv[2] ?? "Jordan, Sentry, developer advocate";

let failed = false;
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
  if (!ok) failed = true;
};

try {
  const s = await fetch(`${base}/api/state`, { headers });
  const state = (await s.json()) as { event?: { name: string }; orgs?: unknown[] };
  check(s.ok, `GET /api/state -> ${s.status} (event: ${state.event?.name ?? "none"}, orgs: ${state.orgs?.length ?? 0})`);

  const t0 = Date.now();
  const r = await fetch(`${base}/api/briefs/text`, { method: "POST", headers, body: JSON.stringify({ text }) });
  const ms = Date.now() - t0;
  const data = (await r.json()) as { brief?: { id: string; version: number; match: unknown; cards: { kind: string; body: string; source: string | null }[] } };
  check(r.ok && !!data.brief, `POST /api/briefs/text "${text}" -> ${r.status} in ${ms}ms`);
  console.log(`  fallback: ${r.headers.get("x-cue-fallback") ?? "no"} | notes: ${r.headers.get("x-cue-notes") ?? ""}`);
  console.log(JSON.stringify(data, null, 2));

  if (data.brief) {
    for (const c of data.brief.cards) {
      const lines = c.body.split("\n");
      check(c.body.length <= 200 && lines.length <= 5 && lines.every((l) => l.length <= 40),
        `card ${c.kind} within limits (${c.body.length} chars, ${lines.length} lines)`);
    }
    const p = await fetch(`${base}/api/briefs/${data.brief.id}?since=${data.brief.version}`, { headers });
    check(p.status === 304, `GET /api/briefs/:id?since=${data.brief.version} -> ${p.status} (expect 304)`);
  }
} catch (err) {
  console.error(`Could not reach ${base}. Is the server running (npm run dev)?`, err);
  failed = true;
}
process.exit(failed ? 1 : 0);
