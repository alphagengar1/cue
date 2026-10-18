import "./_env.js";
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Goal } from "../../shared/types.js";
import { buildBrief, confirmPerson, regenerateAngle, templateCard } from "../src/brief.js";
import { config } from "../src/config.js";
import { enforceCards } from "../src/safety.js";
import { store } from "../src/store.js";
import { assertValidCard, dataFile } from "./_helpers.js";

const GOALS: Goal[] = ["internship", "cofounder", "learn", "teammates_sponsors", "mentorship"];
const GOAL_WORD: Record<Goal, RegExp> = {
  internship: /interns/, cofounder: /start a company/, learn: /hardest/,
  teammates_sponsors: /APIs, credits or\s+mentors/, mentorship: /wish they knew/,
};

before(() => {
  assert.equal(config.anthropicKey, undefined, "tests must run without ANTHROPIC_API_KEY");
  assert.equal(config.exaKey, undefined, "tests must run without EXA_API_KEY");
  assert.equal(config.creaoKey, undefined, "tests must run without CREAO_API_KEY");
  store.loadSample(dataFile("sample-event.json"));
});
beforeEach(() => { store.goal = "internship"; });

describe("template fallback (no keys)", () => {
  for (const goal of GOALS) {
    test(`goal ${goal}: stored person -> valid context + angle cards`, async () => {
      store.goal = goal;
      const out = await buildBrief("Jordan, Sentry, developer advocate");
      assert.equal(out.fallback, true);
      assert.equal(out.brief.match.confidence, "high");
      assert.equal(out.brief.query.name, "Jordan");
      const kinds = out.brief.cards.map((c) => c.kind);
      assert.deepEqual(kinds, ["context", "angle"], "connect needs a sourced fact, so the template omits it");
      out.brief.cards.forEach(assertValidCard);
      const angle = out.brief.cards.find((c) => c.kind === "angle")!;
      assert.match(angle.body, GOAL_WORD[goal]);
      assert.ok(out.notes.some((n) => n.includes("ANTHROPIC_API_KEY not set")));
      assert.equal(out.brief.slowPath.status, "none", "no CREAO run without a key");
    });
  }

  for (const text of ["Maya Chen, Even Realities", "Sam Park CREAO engineer", "jordan sentry developer advocate"]) {
    test(`"${text}" -> high match, valid cards`, async () => {
      const out = await buildBrief(text);
      assert.equal(out.brief.match.confidence, "high");
      assert.ok(out.brief.cards.length >= 2);
      out.brief.cards.forEach(assertValidCard);
    });
  }

  test("known org, unknown person, search down -> one context card 'Person lookup unavailable.'", async () => {
    const out = await buildBrief("Zed, Photon");
    assert.equal(out.brief.match.confidence, "low");
    assert.equal(out.brief.cards.length, 1);
    const [c] = out.brief.cards;
    assertValidCard(c);
    assert.equal(c.kind, "context");
    assert.ok(c.body.startsWith("Person lookup unavailable."), c.body);
  });

  test("unknown org -> single generic angle card", async () => {
    const out = await buildBrief("Priya, Anduril, recruiter");
    assert.equal(out.brief.match.confidence, "low");
    assert.deepEqual(out.brief.cards.map((c) => c.kind), ["angle"]);
    assertValidCard(out.brief.cards[0]);
    assert.match(out.brief.cards[0].body, /Anduril/);
  });

  test("no name -> BAD_REQUEST", async () => {
    await assert.rejects(buildBrief(" ... "), (e: { code?: string }) => e.code === "BAD_REQUEST");
  });

  test("templateCard + enforceCards: every goal, org-less query, stays valid", () => {
    for (const goal of GOALS) {
      const cards = enforceCards([templateCard("angle", { name: "A", org: "" }, null, null, goal)!]);
      assert.equal(cards.length, 1);
      assertValidCard(cards[0]);
    }
  });
});

describe("low match with search up but no results (Exa stubbed offline)", () => {
  const realFetch = globalThis.fetch;
  before(() => {
    config.exaKey = "test-not-a-real-key";
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith("https://api.exa.ai/")) throw new Error(`blocked ${url}`);
      return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
  });
  after(() => { config.exaKey = undefined; globalThis.fetch = realFetch; });

  test("context card starts with 'No public info found for <name>.'", async () => {
    const out = await buildBrief("Zed, Photon, founder");
    assert.equal(out.brief.match.confidence, "low");
    assert.equal(out.brief.cards.length, 1);
    const [c] = out.brief.cards;
    assertValidCard(c);
    assert.equal(c.kind, "context");
    assert.ok(c.body.replace(/\n/g, " ").startsWith("No public info found for Zed."), c.body);
    assert.ok(out.notes.some((n) => n.startsWith("search ") && n.includes("kept 0/0")));
  });
});

describe("goal switch and confirm", () => {
  test("regenerateAngle changes only the angle card and bumps version", async () => {
    const { brief } = await buildBrief("Jordan, Sentry, developer advocate");
    store.goal = "cofounder";
    const out = await regenerateAngle(brief.id);
    assert.equal(out.brief.version, brief.version + 1);
    const before = brief.cards.filter((c) => c.kind !== "angle");
    const afterCards = out.brief.cards.filter((c) => c.kind !== "angle");
    assert.deepEqual(afterCards, before);
    assert.match(out.brief.cards.find((c) => c.kind === "angle")!.body, GOAL_WORD.cofounder);
  });
  test("org-only brief is returned unchanged", async () => {
    const { brief } = await buildBrief("Zed, Photon");
    const out = await regenerateAngle(brief.id);
    assert.equal(out.brief.version, brief.version);
  });
  test("confirm null with an unknown org -> generic angle card, not zero cards", async () => {
    const { brief } = await buildBrief("Priya, Anduril, recruiter");
    const out = await confirmPerson(brief.id, null);
    assert.deepEqual(out.brief.cards.map((c) => c.kind), ["angle"]);
    out.brief.cards.forEach(assertValidCard);
  });
  test("confirm null -> org-only context card, version + 1", async () => {
    const { brief } = await buildBrief("Jordan, Sentry, developer advocate");
    const out = await confirmPerson(brief.id, null);
    assert.equal(out.brief.version, brief.version + 1);
    assert.equal(out.brief.match.confidence, "low");
    assert.deepEqual(out.brief.cards.map((c) => c.kind), ["context"]);
    assert.ok(out.brief.cards[0].body.startsWith("Jordan not confirmed."));
    out.brief.cards.forEach(assertValidCard);
  });
});
