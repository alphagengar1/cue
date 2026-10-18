import "./_env.js";
import { test, describe, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { appKeyFor, createRun, creaoEnabled, extractResult, getRun } from "../src/creao.js";

// The per-agent app API (agent.creao.ai, capi_ keys) next to the developer /v2 transport.
describe("CREAO app transport (per-agent capi_ keys)", () => {
  const realFetch = globalThis.fetch;
  const calls: { url: string; init: RequestInit }[] = [];
  beforeEach(() => { calls.length = 0; config.creaoAppKeys.personResearcher = "capi_test"; });
  afterEach(() => { globalThis.fetch = realFetch; config.creaoAppKeys.personResearcher = undefined; });

  const stub = (responses: Record<string, unknown>) => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, init: init ?? {} });
      const key = Object.keys(responses).find((k) => url.includes(k));
      return new Response(JSON.stringify(key ? responses[key] : { error: "NOT_FOUND" }), { status: key ? 200 : 404 });
    }) as typeof fetch;
  };

  test("enabled with an app key alone; off with neither key", () => {
    assert.equal(appKeyFor("person_researcher"), "capi_test");
    assert.equal(creaoEnabled("person_researcher"), true);
    assert.equal(creaoEnabled("brief_writer"), false);
    assert.equal(creaoEnabled("follow_up_writer"), false); // no id and no key
  });

  test("createRun posts {inputs} to the app URL with the agent key; getRun maps chatText; extractResult finds the JSON", async () => {
    const appId = "e496e45b-c8eb-4079-9aff-876071501d67";
    const chatText = "Researched Steve Jobs.\n\n```json\n" + JSON.stringify({
      name: "Steve Jobs", role: "co-founder", headline: "Co-founder of Sentry",
      facts: [{ text: "Steve Jobs of Sentry spoke at SREcon.", sourceUrl: "https://usenix.org/x", sourceKind: "talk" }],
      match: "high", matchReason: "x",
    }) + "\n```";
    stub({
      [`/runs/a28c`]: { id: "a28c", status: "completed", appId, threadId: "t1", result: { text: '{"name":"Steve Jobs","factsCount":1}', chatText } },
      [`/apps/${appId}/runs`]: { id: "a28c", status: "pending", appId, appName: "Cue Person Researcher" },
    });
    const created = await createRun(appId, { name: "Steve Jobs", org: "Sentry", role: "co-founder", orgAliases: [] }, undefined, "person_researcher");
    assert.equal(created.run_id, "a28c"); assert.equal(created.status, "pending"); assert.equal(created.agent_id, appId);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `https://agent.creao.ai/api/v1/apps/${appId}/runs`);
    assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer capi_test");
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { inputs: { name: "Steve Jobs", org: "Sentry", role: "co-founder", orgAliases: [] } });

    const run = await getRun("a28c");
    assert.equal(calls[1].url, `https://agent.creao.ai/api/v1/apps/${appId}/runs/a28c`);
    assert.equal(run.status, "completed"); assert.equal(run.conversation_id, "t1");
    assert.equal(run.result?.chat_text, chatText);
    const out = (await extractResult(run, "person_researcher")) as { name: string; facts: unknown[] };
    assert.equal(out.name, "Steve Jobs"); assert.equal(out.facts.length, 1);
  });

  test("createRun without an app key for that agent uses the /v2 transport (and fails closed without a key)", async () => {
    stub({});
    await assert.rejects(createRun("x", { a: 1 }, undefined, "brief_writer"), /NO_KEY/);
    assert.equal(calls.length, 0);
  });
});
