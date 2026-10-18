import "./_env.js";
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { app } from "../src/app.js";
import { config } from "../src/config.js";
import { journal, journalEntries, journalMarkdown, journalPeople, journalReset } from "../src/journal.js";
import { store } from "../src/store.js";

let server: Server;
let base = "";
before(async () => {
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { journalReset(); store.briefs.clear(); });

const david = { name: "David Cramer", org: "Sentry", role: "co-founder" };

describe("journal: append, aggregate, render", () => {
  test("entries persist in order and aggregate per person", () => {
    journal({ type: "brief", briefId: "b1", person: david, data: { confidence: "high", cards: [{ kind: "connect", title: "Ask about Seer", body: "x" }] } });
    journal({ type: "debrief", briefId: "b1", person: david, data: { text: "he said email him about seer" } });
    journal({ type: "transcript", briefId: "b1", person: david, data: { text: "so what are you building these days" } });
    journal({ type: "follow_up", briefId: "b1", person: david, data: { subject: "Seer", body: "Hi David,\n\nx", message: "hi", nextSteps: ["email david"] } });
    journal({ type: "coaching", data: { summary: "solid day", patterns: ["asks worked"], priorities: [{ name: "David Cramer", action: "email tonight" }], coaching: [], nextTime: "ask for a next step" } });
    journal({ type: "goal", data: { goal: "cofounder" } });
    assert.equal(journalEntries().length, 6);
    const people = journalPeople();
    assert.equal(people.length, 1);
    assert.equal(people[0].conversations, 1);
    assert.deepEqual(people[0].debriefs, ["he said email him about seer"]);
    assert.ok(people[0].transcriptChars > 0);
    assert.equal(people[0].followUp?.subject, "Seer");
    const md = journalMarkdown();
    assert.match(md, /^# Cue Journal/);
    assert.match(md, /### David Cramer, co-founder, Sentry/);
    assert.match(md, /debrief \(the wearer's own words\): he said email him about seer/);
    assert.match(md, /conversation transcript \(recorded with consent/);
    assert.match(md, /## Coaching/);
    assert.match(md, /- summary: solid day/);
    assert.match(md, /goal: cofounder/);
  });
});

describe("journal routes (JOURNAL_TOKEN, not the device token)", () => {
  test("503 when no journal token is configured; 401 wrong token; 200 markdown and json with the right one", async () => {
    journal({ type: "brief", briefId: "b1", person: david, data: { confidence: "high", cards: [] } });
    const was = config.journalToken;
    (config as { journalToken?: string }).journalToken = undefined;
    try {
      assert.equal((await fetch(`${base}/journal.md?token=x`)).status, 503);
      (config as { journalToken?: string }).journalToken = "jt_test";
      assert.equal((await fetch(`${base}/journal.md?token=nope`)).status, 401);
      assert.equal((await fetch(`${base}/journal.md`)).status, 401);
      const md = await fetch(`${base}/journal.md?token=jt_test`);
      assert.equal(md.status, 200);
      assert.match(md.headers.get("content-type") ?? "", /text\/markdown/);
      assert.match(await md.text(), /David Cramer/);
      const json = await fetch(`${base}/api/journal.json`, { headers: { authorization: "Bearer jt_test" } });
      assert.equal(json.status, 200);
      const body = (await json.json()) as { entries: unknown[]; people: unknown[] };
      assert.equal(body.entries.length, 1); assert.equal(body.people.length, 1);
      const ppl = await fetch(`${base}/api/journal/people.json?token=jt_test`);
      assert.equal(ppl.status, 200);
    } finally { (config as { journalToken?: string }).journalToken = was; }
  });

  test("a lookup and a debrief through /api/say are journaled", async () => {
    const say = (text: string, briefId?: string) =>
      fetch(`${base}/api/say`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, briefId }) }).then((r) => r.json());
    const first = (await say("Priya Shah, Anduril, recruiter")) as { brief: { id: string } };
    await say("she said apply online and mention the fair", first.brief.id);
    const types = journalEntries().map((e) => e.type);
    assert.ok(types.includes("brief"), types.join(","));
    assert.ok(types.includes("debrief"), types.join(","));
    assert.equal(journalPeople()[0].name, "Priya Shah");
  });
});
