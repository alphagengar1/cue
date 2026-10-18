import "./_env.js";
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { classifyIntent, decisionsIntent, goalFromText, rulesIntent } from "../src/intent.js";

const noBrief = { hasBrief: false };
const withBrief = { hasBrief: true, lastQuery: { name: "Steve Jobes", org: "Sentry", role: "co-founder" } };

describe("rulesIntent", () => {
  test("name, org, role is a lookup", () => {
    const r = rulesIntent("Priya Shah, Anduril, recruiter", noBrief);
    assert.equal(r.intent, "lookup"); assert.ok(r.confidence >= 0.85);
    assert.equal(rulesIntent("Steve from Sentry", noBrief).intent, "lookup");
  });
  test("what they said is a debrief when a brief is open, unknown otherwise", () => {
    assert.equal(rulesIntent("he said to email him about Seer, they're hiring summer interns", withBrief).intent, "debrief");
    assert.notEqual(rulesIntent("he said to email him about Seer, they're hiring summer interns", noBrief).intent, "debrief");
  });
  test("corrections need an open brief", () => {
    assert.equal(rulesIntent("Jobs with a C", withBrief).intent, "correction");
    assert.equal(rulesIntent("no, it's Priya not Maya", withBrief).intent, "correction");
    assert.notEqual(rulesIntent("Jobs with a C", noBrief).intent, "correction");
  });
  test("goals", () => {
    const r = rulesIntent("I'm looking for a cofounder", noBrief);
    assert.equal(r.intent, "goal"); assert.equal(r.goal, "cofounder");
    assert.equal(rulesIntent("switch my goal to mentorship", withBrief).goal, "mentorship");
    assert.equal(rulesIntent("internship", noBrief).goal, "internship");
    assert.equal(goalFromText("looking for teammates for the hackathon"), "teammates_sponsors");
  });
  test("recap and quiet", () => {
    assert.equal(rulesIntent("text me the recap", withBrief).intent, "recap");
    assert.equal(rulesIntent("never mind", withBrief).intent, "quiet");
    assert.equal(rulesIntent("", noBrief).intent, "unknown");
  });
});

describe("decisionsIntent", () => {
  const realFetch = globalThis.fetch;
  const realKey = process.env.OPENAI_API_KEY;
  afterEach(() => { globalThis.fetch = realFetch; process.env.OPENAI_API_KEY = realKey; });

  const stub = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  const answers = (intent: string, p: Record<string, number>, goal = "internship") => ({
    answers: [
      { type: "choice", name: "intent", choice: intent, probabilities: Object.entries(p).map(([value, probability]) => ({ value, probability })), confidence: 0.7 },
      { type: "choice", name: "goal", choice: goal, probabilities: [], confidence: 0.5 },
    ],
  });

  test("null without a key, on non-200, on bad JSON", async () => {
    assert.equal(await decisionsIntent("hi", noBrief, { apiKey: "" }), null);
    assert.equal(await decisionsIntent("hi", noBrief, { apiKey: "k", fetch: stub(500, {}) }), null);
    assert.equal(await decisionsIntent("hi", noBrief, { apiKey: "k", fetch: stub(200, { answers: [] }) }), null);
  });
  test("parses the intent answer and its probability; goal only when valid", async () => {
    const r = await decisionsIntent("he said email him", withBrief, { apiKey: "k", fetch: stub(200, answers("debrief", { debrief: 0.82, lookup: 0.1 })) });
    assert.equal(r?.intent, "debrief"); assert.equal(r?.confidence, 0.82); assert.equal(r?.source, "decisions"); assert.equal(r?.goal, "internship");
    const bad = await decisionsIntent("x", noBrief, { apiKey: "k", fetch: stub(200, answers("goal", { goal: 0.9 }, "nonsense")) });
    assert.equal(bad?.goal, undefined);
  });
  test("classifyIntent: a confident rules lookup beats a weak model answer; a weak model falls back to rules", async () => {
    process.env.OPENAI_API_KEY = "k";
    globalThis.fetch = stub(200, answers("debrief", { debrief: 0.5, lookup: 0.45 }));
    assert.equal((await classifyIntent("Priya Shah, Anduril, recruiter", withBrief)).intent, "lookup");
    globalThis.fetch = stub(200, answers("goal", { goal: 0.3, unknown: 0.3 }));
    assert.equal((await classifyIntent("text me the recap", withBrief)).source, "rules");
    globalThis.fetch = stub(200, answers("debrief", { debrief: 0.9 }));
    assert.equal((await classifyIntent("he mentioned the robotics team", noBrief)).intent, "unknown"); // no brief to attach it to
  });
});
