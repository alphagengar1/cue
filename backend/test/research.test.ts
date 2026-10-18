import "./_env.js";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildBrief, regenerateAngle } from "../src/brief.js";
import { config } from "../src/config.js";
import { store } from "../src/store.js";
import { assertValidCard, dataFile } from "./_helpers.js";

// An event file whose people carry hand-run CREAO Person Researcher output (agents/person-researcher.md).
const sample = JSON.parse(fs.readFileSync(dataFile("sample-event.json"), "utf8"));
const GOOD = "Jordan Lee gave a Sentry talk on tracing React Native apps at JSConf 2026.";
const researched = {
  ...sample,
  people: sample.people.map((p: { name: string }) => p.name !== "Jordan Lee" ? p : {
    ...p,
    headline: "Developer Advocate at Sentry",
    facts: [
      { text: GOOD, sourceUrl: "https://www.youtube.com/watch?v=abc", sourceKind: "talk", date: "2026-05" },
      { text: "Lee wrote about debugging.", sourceUrl: "https://example.com/post", sourceKind: "own_post" },
      { text: "Jordan Lee is a recruiter at Sentry.", sourceUrl: "https://www.linkedin.com/in/jlee", sourceKind: "article" },
      { text: "Jordan Lee lives in Oakland and works at Sentry.", sourceUrl: "https://example.com/bio", sourceKind: "article" },
      { text: "Jordan Lee shipped the Sentry session replay SDK.", sourceUrl: "not a url", sourceKind: "github" },
    ],
    match: "high",
    research: { agent: "creao-person-researcher", agentId: "agent-test", runLink: "https://agent.creao.ai/share/test" },
  }),
};

// The Anthropic SDK captures fetch when its client is built, so install the stub before any LLM call.
const realFetch = globalThis.fetch;
let llmBodies: { messages: { content: string }[] }[] = [];
let onLlm: () => void = () => {};
let file = "";

before(() => {
  file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cue-test-")), "researched.json");
  fs.writeFileSync(file, JSON.stringify(researched));
  config.anthropicKey = "test-not-a-real-key";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://api.anthropic.com/")) throw new Error(`blocked ${url}`);
    llmBodies.push(JSON.parse(String(init?.body ?? "{}")));
    onLlm();
    return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "stub" } }), {
      status: 500, headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  store.loadSample(file);
});
after(() => { config.anthropicKey = undefined; globalThis.fetch = realFetch; });

describe("event file with hand-run Person Researcher output", () => {
  test("facts go through the live-research checks on load", () => {
    const p = store.eventPeople().find((x) => x.name === "Jordan Lee")!;
    assert.deepEqual(p.facts.map((f) => f.text), [GOOD], "last-name-only, LinkedIn, sensitive and bad-URL facts dropped");
    assert.equal(p.headline, "Developer Advocate at Sentry");
    assert.equal(p.fromEventList, true);
    assert.ok(p.lastResearchedAt, "no second Person Researcher run");
  });

  test("loaded facts reach the brief writer input and the template connect card", async () => {
    llmBodies = [];
    const out = await buildBrief("Jordan, Sentry, developer advocate");
    assert.equal(out.brief.match.confidence, "high");
    assert.equal(llmBodies.length, 1, "one LLM call");
    const payload = JSON.parse(llmBodies[0].messages[0].content);
    assert.deepEqual(payload.person.facts.map((f: { text: string }) => f.text), [GOOD]);
    const connect = out.brief.cards.find((c) => c.kind === "connect");
    assert.ok(connect, "template connect card from the loaded fact");
    assert.equal(connect.source, "youtube.com/watch");
    out.brief.cards.forEach(assertValidCard);
  });

  test("goal change during the LLM call keeps a slow-path update that landed meanwhile", async () => {
    const { brief } = await buildBrief("Jordan, Sentry, developer advocate");
    const slowCard = { kind: "context" as const, title: "Context", body: "Slow path v2 card.", source: "sentry.io" };
    onLlm = () => {
      const b = store.briefs.get(brief.id)!;
      store.briefs.set(b.id, { ...b, cards: b.cards.map((c) => (c.kind === "context" ? slowCard : c)), version: b.version + 1 });
    };
    try {
      store.goal = "cofounder";
      const out = await regenerateAngle(brief.id);
      assert.equal(out.brief.version, brief.version + 2, "version = current + 1");
      assert.deepEqual(out.brief.cards.find((c) => c.kind === "context"), slowCard);
      assert.match(out.brief.cards.find((c) => c.kind === "angle")!.body, /start a company/);
    } finally {
      onLlm = () => {};
      store.goal = "internship";
    }
  });
});
