// One realistic LA Hacks day against a RUNNING backend, for the demo and for the long-term agents:
// everything goes through the same API the glasses use (POST /api/say, POST /api/briefs/:id/transcript),
// so the journal, /dashboard and the CREAO agents (Follow-up, Coach, Speech Coach, Relationships) all see it.
//
//   npm run simulate                       # the deployed server, DEVICE_TOKEN from backend/.env
//   BASE_URL=http://localhost:8787 npm run simulate
//   FAST=1 npm run simulate                # 2 s between steps instead of 20–40 s
//   START=daniel npm run simulate          # resume from a step after a crash: will, kai, david, daniel, milin, coach
//
// Steps, 20–40 s apart like a real walk between booths: five lookups of real sponsor people, four debriefs
// (one great with a clear next step, one weak, one after a misheard name is corrected, one with a consented
// conversation transcript), then "how did I do today?". The transcript route takes audio only (it is the
// glasses mic), so the transcript text is spoken by macOS `say` and converted with ffmpeg to the PCM the
// route expects; without those two tools that step is skipped and the debrief still runs.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const envFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const base = (process.env.BASE_URL ?? "https://35.164.205.54.sslip.io").replace(/\/$/, "");
const token = process.env.DEVICE_TOKEN?.trim();
if (!token) { console.error("DEVICE_TOKEN is not set (backend/.env)"); process.exit(1); }
const fast = !!process.env.FAST;
const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${token}` };

interface Brief { id: string; version: number; query: { name: string; org: string; role?: string }; match: { personId: string | null; confidence?: string }; cards: { kind: string }[] }
interface SayResponse {
  intent: string; intentConfidence?: number; intentSource?: string; brief?: Brief;
  recap?: { sent: true; chars: number } | { sent: false; reason: string }; say?: string; creaoRunId?: string;
}

const stamp = () => new Date().toLocaleTimeString(undefined, { hour12: false });
const log = (s: string) => console.log(`${stamp()}  ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function pause(): Promise<void> {
  const ms = fast ? 2_000 : 20_000 + Math.floor(Math.random() * 20_000);
  log(`… ${Math.round(ms / 1000)} s`);
  await sleep(ms);
}

/** fetch with two retries on a network error or a 5xx: a laptop Wi-Fi blip or the proxy giving up on a slow debrief must not end the day. */
async function call(label: string, input: string, init: RequestInit): Promise<{ r: Response; body: any }> {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(input, init);
      const body = await r.json().catch(() => ({}));
      if (r.ok || r.status < 500 || attempt >= 3) return { r, body };
      log(`${label} -> ${r.status}, retrying in 15 s`);
    } catch (err) {
      if (attempt >= 3) throw err;
      log(`${label} -> ${(err as Error & { cause?: Error }).cause?.message ?? (err as Error).message}, retrying in 15 s`);
    }
    await sleep(15_000);
  }
}

// A debrief does the recap, the text and the CREAO start before it answers, so the proxy in front of the
// server can give up first (502/504). The work still happened; on a final failure log it and carry on.
async function say(text: string, briefId?: string): Promise<SayResponse> {
  const t0 = Date.now();
  const { r, body } = await call(`say "${text}"`, `${base}/api/say`, { method: "POST", headers, body: JSON.stringify(briefId ? { text, briefId } : { text }) }) as { r: Response; body: SayResponse & { error?: { code: string; message: string } } };
  if (!r.ok) { log(`say "${text}" -> ${r.status} ${body.error?.code ?? ""} ${body.error?.message ?? ""}`.trim()); return { intent: "error" }; }
  const recap = !body.recap ? "–" : body.recap.sent ? `sent (${body.recap.chars} chars)` : `not sent: ${body.recap.reason}`;
  const who = body.brief ? `${body.brief.query.name}, ${body.brief.query.org}${body.brief.query.role ? ", " + body.brief.query.role : ""} (${body.brief.match.personId ? "matched" : "unmatched"}, ${body.brief.cards.length} cards)` : "";
  log(`say "${text}"`);
  log(`  -> intent ${body.intent}${body.intentConfidence !== undefined ? ` ${body.intentConfidence.toFixed(2)} ${body.intentSource ?? ""}` : ""} | recap ${recap}${who ? ` | ${who}` : ""}${body.creaoRunId ? ` | creao run ${body.creaoRunId.slice(0, 8)}` : ""}${body.say ? ` | hud "${body.say.replace(/\n/g, " / ")}"` : ""} | ${Date.now() - t0} ms`);
  const notes = r.headers.get("x-cue-notes");
  if (notes) log(`  notes: ${notes}`);
  if (r.headers.get("x-cue-fallback")) log("  fallback: template");
  return body;
}

/** The consented conversation, as the glasses would send it: ~20 s chunks of 16 kHz mono s16le PCM. */
async function transcript(briefId: string, chunks: string[]): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cue-sim-"));
  try {
    for (const [i, text] of chunks.entries()) {
      const aiff = path.join(tmp, `${i}.aiff`), pcm = path.join(tmp, `${i}.pcm`);
      try {
        execFileSync("say", ["-o", aiff, text], { stdio: "ignore" });
        execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", aiff, "-f", "s16le", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", pcm], { stdio: "ignore" });
      } catch {
        log(`  transcript chunk ${i + 1}: skipped (needs macOS \`say\` and ffmpeg to make the audio the route takes)`);
        return;
      }
      const audio = fs.readFileSync(pcm);
      const { r, body } = await call(`transcript chunk ${i + 1}`, `${base}/api/briefs/${briefId}/transcript`, {
        method: "POST", body: new Uint8Array(audio),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream", "x-audio-format": "pcm_s16le;rate=16000;channels=1" },
      }) as { r: Response; body: { chars?: number; added?: number; error?: { code: string } } };
      log(`  transcript chunk ${i + 1}: ${Math.round(audio.length / 32_000)} s of audio -> ${r.status}${r.ok ? ` ${body.added} chars transcribed, ${body.chars} on the brief` : ` ${body.error?.code ?? ""}`}`);
      if (i < chunks.length - 1) await sleep(fast ? 1_000 : 5_000);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const state = await fetch(`${base}/api/state`, { headers });
if (!state.ok) { console.error(`GET /api/state -> ${state.status}. Wrong BASE_URL or DEVICE_TOKEN?`); process.exit(1); }
const s = (await state.json()) as { event?: { name: string }; orgs?: { name: string }[]; goal?: string };
log(`${base}: event ${s.event?.name ?? "none"}, orgs ${s.orgs?.map((o) => o.name).join(", ") ?? ""}, goal ${s.goal ?? ""}`);

// The day as named steps. START=<name> resumes from that step (after a crash, so the people already in the
// journal are not met twice): will, kai, david, daniel, milin, coach.
const steps: [string, () => Promise<void>][] = [
  ["will", async () => { // great conversation, clear next step
    const r = await say("Will Wang, Even Realities, co-founder and CEO");
    await pause();
    if (r.brief) { await say("he said email him the demo video tonight, they are hiring interns for the Even Hub SDK team this summer and he wants to see the glasses flow end to end", r.brief.id); await pause(); }
  }],
  ["kai", async () => { // weak one
    const r = await say("Kai Cheng, CREAO, founder and CEO");
    await pause();
    if (r.brief) { await say("she said apply online", r.brief.id); await pause(); }
  }],
  ["david", async () => { // misheard, corrected, then the debrief
    let r = await say("Will Wong, Even Realities, co-founder");
    await pause();
    r = await say("no, Wang with an A", r.brief?.id);
    await pause();
    if (r.brief) { await say("he said send him the Sentry integration we built and the error traces from the glasses, he can intro me to the SDK team", r.brief.id); await pause(); }
  }],
  ["daniel", async () => { // consented conversation (transcript), then the debrief
    const r = await say("Daniel Tian, Photon, co-founder and CEO");
    await pause();
    if (!r.brief) return;
    log("transcript (after the consent line and the tap)");
    await transcript(r.brief.id, [
      "Sure, happy to have the glasses take notes. So Photon is the iMessage layer, we power about a million end users for agent messaging. What are you building on it?",
      "Nice, a recap texted to yourself after every conversation is exactly the kind of flow we want to show. Send me the iMessage flow and I will put you in touch with our founding engineer. We are hiring for the summer too.",
    ]);
    await pause();
    await say("he offered to intro me to their founding engineer, follow up with the iMessage flow and ask about the summer role", r.brief.id);
    await pause();
  }],
  ["milin", async () => { // one more lookup, no debrief (walked away)
    await say("Milin Desai, Sentry, CEO");
    await pause();
  }],
  ["coach", async () => { await say("how did I do today?"); }],
];

const start = process.env.START?.trim();
const from = start ? steps.findIndex(([name]) => name === start) : 0;
if (from < 0) { console.error(`START=${start}: no such step (${steps.map(([n]) => n).join(", ")})`); process.exit(1); }
for (const [name, run] of steps.slice(from)) { log(`-- ${name}`); await run(); }
log("done");
