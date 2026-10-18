import "./_env.js";
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  buildRequest, decide, DECISIONS_MODEL, DECISIONS_URL, factsForDecision, MAX_FACTS, parseResponse, Q,
  type DecideInput,
} from "../src/decide.js";

const input: DecideInput = {
  query: { name: "Priya Shah", org: "Anduril", role: "recruiter" },
  goal: "internship",
  goalNote: "summer 2027 SWE intern",
  facts: [
    { text: "Priya Shah spoke on autonomy testing at ROSCon 2025.", sourceUrl: "https://roscon.ros.org/2025/talks" },
    { text: "Anduril recruiter Priya Shah posted about Lattice intern roles.", sourceUrl: "https://anduril.com/careers" },
  ],
};

const okBody = {
  id: "dec_123",
  answers: [
    { type: "predicate", name: "match", probability: 0.91 },
    { type: "score", name: "goal_fit", score: 1.6, confidence: 0.8,
      probabilities: [{ value: 0, label: "not useful", probability: 0.1 }, { value: 1, label: "somewhat useful", probability: 0.2 }, { value: 2, label: "strongly useful", probability: 0.7 }] },
    { type: "choice", name: "lead", choice: "connect", confidence: 0.7,
      probabilities: [{ value: "connect", probability: 0.7 }, { value: "context", probability: 0.2 }, { value: "angle", probability: 0.1 }] },
    { type: "predicate", name: "sensitive_0", probability: 0.02 },
    { type: "predicate", name: "sensitive_1", probability: 0.05 },
  ],
};

describe("buildRequest", () => {
  test("exact JSON for a two-fact brief", () => {
    const req = buildRequest(input);
    assert.deepEqual(req, {
      model: "gpt-6-luna",
      input: [
        "Wearer named: Priya Shah, Anduril, recruiter",
        "Wearer's goal: internship (summer 2027 SWE intern)",
        "Facts found by web search (numbered, each with its source URL):",
        "0. Priya Shah spoke on autonomy testing at ROSCon 2025. [https://roscon.ros.org/2025/talks]",
        "1. Anduril recruiter Priya Shah posted about Lattice intern roles. [https://anduril.com/careers]",
      ].join("\n"),
      questions: [
        {
          type: "predicate", name: "match",
          instructions: "These facts describe the person the wearer named: the same name and the same organization.",
        },
        {
          type: "score", name: "goal_fit",
          instructions: "How useful is talking to this person for the wearer's goal, given only these facts?",
          levels: [
            { label: "not useful", description: "Nothing here helps the wearer's goal." },
            { label: "somewhat useful", description: "Some overlap with the goal, or a general conversation is possible." },
            { label: "strongly useful", description: "This person can directly help with the wearer's goal." },
          ],
        },
        {
          type: "choice", name: "lead",
          instructions: "Which card should the wearer see first?",
          choices: [
            { value: "connect", description: "A specific opener about something this person made, said or wrote." },
            { value: "context", description: "Who they are and what they and their organization focus on now." },
            { value: "angle", description: "How this conversation serves the wearer's goal and what to ask for." },
          ],
        },
        {
          type: "predicate", name: "sensitive_0",
          instructions: "Fact 0 mentions private matters: health, family, religion, politics, legal, home, age or appearance.",
        },
        {
          type: "predicate", name: "sensitive_1",
          instructions: "Fact 1 mentions private matters: health, family, religion, politics, legal, home, age or appearance.",
        },
      ],
    });
    // Round-trips through JSON unchanged (no undefined fields, no functions).
    assert.deepEqual(JSON.parse(JSON.stringify(req)), req);
  });

  test("no role, no goalNote, no facts", () => {
    const req = buildRequest({ query: { name: "Sam", org: "CREAO" }, goal: "learn", facts: [] });
    assert.equal(req.input, [
      "Wearer named: Sam, CREAO",
      "Wearer's goal: learn",
      "Facts found by web search (numbered, each with its source URL):",
      "(no facts found)",
    ].join("\n"));
    assert.deepEqual(req.questions.map((q) => q.name), ["match", "goal_fit", "lead"]);
  });

  test("facts capped at 12 and truncated to 140 chars; input stays small", () => {
    const facts = Array.from({ length: 20 }, (_, i) => ({
      text: `Fact ${i} ` + "x".repeat(300), sourceUrl: `https://example.com/${i}`,
    }));
    const sent = factsForDecision(facts);
    assert.equal(sent.length, MAX_FACTS);
    for (const f of sent) assert.ok(f.text.length <= 140, `${f.text.length}`);
    assert.ok(sent[0].text.endsWith("..."));
    const req = buildRequest({ query: { name: "A B", org: "C" }, goal: "learn", facts });
    assert.equal(req.questions.filter((q) => q.name.startsWith("sensitive_")).length, MAX_FACTS);
    assert.ok(req.input.length < 4000, `input ${req.input.length} chars (about 1k tokens)`);
  });

  test("whitespace in facts collapsed", () => {
    const [f] = factsForDecision([{ text: "  a\n\n  b\tc  ", sourceUrl: "https://x.y" }]);
    assert.equal(f.text, "a b c");
  });
});

describe("parseResponse", () => {
  test("full answer set -> Decision", () => {
    assert.deepEqual(parseResponse(okBody, 2), { match: 0.91, goalFit: 1.6, lead: "connect", sensitive: [0.02, 0.05] });
  });

  test("ignores extra answers and answer order", () => {
    const body = { answers: [...okBody.answers].reverse().concat([{ type: "predicate", name: "unused", probability: 1 }]) };
    assert.deepEqual(parseResponse(body, 2), { match: 0.91, goalFit: 1.6, lead: "connect", sensitive: [0.02, 0.05] });
  });

  test("refusal on a required answer -> null", () => {
    const body = { answers: okBody.answers.map((a) => (a.name === Q.match ? { type: "refusal", name: "match" } : a)) };
    assert.equal(parseResponse(body, 2), null);
  });

  test("refusal on one sensitive answer -> null", () => {
    const body = { answers: okBody.answers.map((a) => (a.name === "sensitive_1" ? { type: "refusal", name: "sensitive_1" } : a)) };
    assert.equal(parseResponse(body, 2), null);
  });

  test("missing answer -> null", () => {
    const body = { answers: okBody.answers.filter((a) => a.name !== Q.goalFit) };
    assert.equal(parseResponse(body, 2), null);
  });

  test("fewer sensitive answers than facts -> null; more facts than sent is not required", () => {
    assert.equal(parseResponse(okBody, 3), null);
    assert.deepEqual(parseResponse(okBody, 1)?.sensitive, [0.02]);
  });

  test("unknown lead choice -> null", () => {
    const body = { answers: okBody.answers.map((a) => (a.name === Q.lead ? { ...a, choice: "summary" } : a)) };
    assert.equal(parseResponse(body, 2), null);
  });

  test("non-numeric probability -> null", () => {
    const body = { answers: okBody.answers.map((a) => (a.name === Q.match ? { ...a, probability: "0.9" } : a)) };
    assert.equal(parseResponse(body, 2), null);
  });

  test("out-of-range numbers are clamped", () => {
    const body = { answers: okBody.answers.map((a) =>
      a.name === Q.match ? { ...a, probability: 1.2 } : a.name === Q.goalFit ? { ...a, score: -0.3 } : a) };
    const d = parseResponse(body, 2)!;
    assert.equal(d.match, 1);
    assert.equal(d.goalFit, 0);
  });

  for (const bad of [null, "text", 42, {}, { answers: "no" }, { answers: [null, 1, "x"] }, { error: { message: "nope" } }]) {
    test(`malformed body ${JSON.stringify(bad)} -> null`, () => { assert.equal(parseResponse(bad, 0), null); });
  }
});

describe("decide (stubbed fetch, no network)", () => {
  const realFetch = globalThis.fetch;
  const realKey = process.env.OPENAI_API_KEY;
  let calls: { url: string; init: RequestInit }[] = [];
  const stub = (handler: (init: RequestInit) => Promise<Response> | Response) => {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return handler(init ?? {});
    }) as typeof fetch;
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  beforeEach(() => { calls = []; process.env.OPENAI_API_KEY = "sk-test"; });
  afterEach(() => { globalThis.fetch = realFetch; process.env.OPENAI_API_KEY = realKey; });

  test("no key -> null without calling fetch", async () => {
    stub(() => json(okBody));
    process.env.OPENAI_API_KEY = "";
    assert.equal(await decide(input), null);
    delete process.env.OPENAI_API_KEY;
    assert.equal(await decide(input), null);
    process.env.OPENAI_API_KEY = "   ";
    assert.equal(await decide(input), null);
    assert.equal(await decide(input, { apiKey: "" }), null);
    assert.equal(calls.length, 0);
  });

  test("200 -> Decision; request is POST with bearer key and the exact body", async () => {
    stub(() => json(okBody));
    const d = await decide(input);
    assert.deepEqual(d, { match: 0.91, goalFit: 1.6, lead: "connect", sensitive: [0.02, 0.05] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, DECISIONS_URL);
    assert.equal(calls[0].init.method, "POST");
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer sk-test");
    assert.equal(headers["Content-Type"], "application/json");
    const sent = JSON.parse(calls[0].init.body as string);
    assert.equal(sent.model, DECISIONS_MODEL);
    assert.deepEqual(sent, buildRequest(input));
    assert.ok(calls[0].init.signal instanceof AbortSignal, "request carries an abort signal");
  });

  test("opts.apiKey and opts.fetch override env and global", async () => {
    stub(() => json({ answers: [] })); // global stub would yield null
    let seen = "";
    const d = await decide(input, {
      apiKey: "sk-opt",
      fetch: (async (_u: string | URL | Request, init?: RequestInit) => {
        seen = (init?.headers as Record<string, string>).Authorization;
        return json(okBody);
      }) as typeof fetch,
    });
    assert.equal(seen, "Bearer sk-opt");
    assert.ok(d);
    assert.equal(calls.length, 0);
  });

  test("500 -> null", async () => {
    stub(() => json({ error: { message: "server error" } }, 500));
    assert.equal(await decide(input), null);
  });

  for (const status of [400, 401, 429]) {
    test(`${status} -> null`, async () => {
      stub(() => json({ error: { message: "nope" } }, status));
      assert.equal(await decide(input), null);
    });
  }

  test("200 with a refusal -> null", async () => {
    stub(() => json({ answers: okBody.answers.map((a) => (a.name === Q.match ? { type: "refusal", name: "match" } : a)) }));
    assert.equal(await decide(input), null);
  });

  test("200 with a non-JSON body -> null", async () => {
    stub(() => new Response("<html>gateway</html>", { status: 200 }));
    assert.equal(await decide(input), null);
  });

  test("fetch rejects (network error) -> null", async () => {
    stub(() => Promise.reject(new TypeError("fetch failed")));
    assert.equal(await decide(input), null);
  });

  test("timeout: fetch never settles until aborted -> null within the budget", async () => {
    stub((init) => new Promise<Response>((_, reject) => {
      init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const t0 = Date.now();
    assert.equal(await decide(input, { timeoutMs: 50 }), null);
    const ms = Date.now() - t0;
    assert.ok(ms >= 40 && ms < 700, `took ${ms}ms`);
    assert.equal(calls[0].init.signal!.aborted, true);
  });

  test("sensitive array matches the capped fact count", async () => {
    const many = { ...input, facts: Array.from({ length: 15 }, (_, i) => ({ text: `f${i}`, sourceUrl: `https://e.com/${i}` })) };
    stub(() => json({
      answers: [
        { type: "predicate", name: "match", probability: 0.8 },
        { type: "score", name: "goal_fit", score: 0.4 },
        { type: "choice", name: "lead", choice: "context" },
        ...Array.from({ length: MAX_FACTS }, (_, i) => ({ type: "predicate", name: `sensitive_${i}`, probability: i / 100 })),
      ],
    }));
    const d = await decide(many);
    assert.equal(d?.sensitive.length, MAX_FACTS);
    assert.equal(d?.lead, "context");
  });
});
