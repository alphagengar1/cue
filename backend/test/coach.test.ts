import "./_env.js";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { app } from "../src/app.js";
import { coachHistory, debriefsToday, startCoach } from "../src/coach.js";
import { rulesIntent } from "../src/intent.js";
import { store } from "../src/store.js";

let server: Server;
let base = "";
before(async () => {
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((r) => server.close(() => r())));

const say = async (text: string, briefId?: string) => {
  const res = await fetch(`${base}/api/say`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, briefId }) });
  return { res, body: await res.json() };
};

describe("Networking Coach", () => {
  test("coach questions are an intent, with or without a brief", () => {
    assert.equal(rulesIntent("how did I do today?", { hasBrief: true }).intent, "coach");
    assert.equal(rulesIntent("who should I follow up with first", { hasBrief: false }).intent, "coach");
    assert.equal(rulesIntent("coach me", { hasBrief: false }).intent, "coach");
  });
  test("history: today's conversations, one per person, with debrief and transcript; not configured -> no run", async () => {
    store.briefs.clear();
    const first = (await say("Priya Shah, Anduril, recruiter")).body.brief;
    await say("she said apply online and email her the demo", first.id);
    const h = coachHistory();
    assert.equal(h.length, 1);
    assert.equal(h[0].person.name, "Priya Shah");
    assert.match(h[0].debrief, /apply online/);
    assert.equal(h[0].followUpSent, false);
    assert.equal(debriefsToday(), 1);
    assert.equal(await startCoach("how did I do", "test"), null);
    const { body } = await say("how did I do today?", first.id);
    assert.equal(body.intent, "coach");
    assert.match(body.say, /not set up/);
  });
});

describe("POST /api/briefs/:id/transcript (consented conversation)", () => {
  test("404 unknown brief, 400 without PCM, 503 without a Deepgram key, brief unchanged", async () => {
    const first = (await say("Priya Shah, Anduril, recruiter")).body.brief;
    const post = (id: string, body: BodyInit | null, type = "application/octet-stream") =>
      fetch(`${base}/api/briefs/${id}/transcript`, { method: "POST", headers: { "content-type": type, "x-audio-format": "pcm_s16le;rate=16000;channels=1" }, body });
    assert.equal((await post("nope", new Uint8Array(3200))).status, 404);
    assert.equal((await post(first.id, "x", "text/plain")).status, 400);
    const r = await post(first.id, new Uint8Array(3200));
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error.code, "STT_FAILED");
    assert.equal(store.briefs.get(first.id)?.conversation, undefined);
    assert.equal(store.briefs.get(first.id)?.version, first.version);
  });
});
