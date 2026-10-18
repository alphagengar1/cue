import "./_env.js";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { SayResponse } from "../../shared/types.js";
import { app } from "../src/app.js";
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
  return { res, body: (await res.json()) as SayResponse & { error?: { code: string } } };
};

describe("POST /api/say (rules only: no keys in tests)", () => {
  test("empty text is a 400", async () => {
    const { res, body } = await say("");
    assert.equal(res.status, 400); assert.equal(body.error?.code, "BAD_REQUEST");
  });
  test("a name, company, role is a lookup and returns a (template) brief", async () => {
    const { res, body } = await say("Priya Shah, Anduril, recruiter");
    assert.equal(res.status, 200);
    assert.equal(body.intent, "lookup"); assert.equal(body.intentSource, "rules");
    assert.ok(body.brief?.id); assert.equal(body.brief?.query.name, "Priya Shah");
    assert.equal(res.headers.get("x-cue-fallback"), "template");
  });
  test("a note after the conversation is a debrief: stored on the brief, recap not sent without Photon", async () => {
    const first = (await say("Priya Shah, Anduril, recruiter")).body.brief!;
    const { body } = await say("she said to email her about the sim team, they are hiring interns", first.id);
    assert.equal(body.intent, "debrief");
    assert.equal(body.brief?.id, first.id);
    assert.equal(body.brief?.version, first.version + 1);
    assert.match(body.brief?.debrief ?? "", /email her about the sim team/);
    assert.equal(store.briefs.get(first.id)?.debrief, body.brief?.debrief);
    assert.deepEqual(body.recap, { sent: false, reason: "Photon not set up" });
  });
  test("a goal sets the goal and rewrites the angle card of the current brief", async () => {
    const first = (await say("Priya Shah, Anduril, recruiter")).body.brief!;
    const { body } = await say("I'm looking for a cofounder", first.id);
    assert.equal(body.intent, "goal"); assert.equal(body.goal, "cofounder");
    assert.equal(store.goal, "cofounder");
    assert.equal(body.brief?.id, first.id); assert.ok((body.brief?.version ?? 0) > first.version);
    store.goal = "internship";
  });
  test("recap without Photon, quiet, and unknown", async () => {
    const first = (await say("Priya Shah, Anduril, recruiter")).body.brief!;
    assert.deepEqual((await say("text me the recap", first.id)).body.recap, { sent: false, reason: "Photon not set up" });
    assert.equal((await say("never mind")).body.intent, "quiet");
    store.briefs.clear();
    const u = (await say("blah")).body;
    assert.equal(u.intent, "unknown"); assert.ok(u.say);
  });
});
