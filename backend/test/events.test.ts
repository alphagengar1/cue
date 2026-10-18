import "./_env.js";
import { test, describe, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { createEvent } from "../src/events.js";
import { store } from "../src/store.js";

// "I'm going to <event> tomorrow" with no sponsor list: one Exa search for "<event> sponsors" rides
// along to the Research agent as sourceText. With orgs given, the current path is unchanged.
describe("createEvent: sponsor search when no orgs are given", () => {
  const realFetch = globalThis.fetch;
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const eventLoaderId = config.creaoAgents.eventLoader!;
  const exaResults = {
    results: [
      { title: "LA Hacks 2026 Sponsors", url: "https://lahacks.com/sponsors", highlights: ["Sponsors: Even Realities, CREAO, Sentry, Photon."] },
      { title: "LA Hacks on Devpost", url: "https://la-hacks.devpost.com", text: "Hosted at UCLA. Sponsored by CREAO and Sentry." },
    ],
  };
  const stub = (exa: { status: number; body: unknown }) => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      calls.push({ url, body });
      if (url.startsWith("https://api.exa.ai/")) return new Response(JSON.stringify(exa.body), { status: exa.status });
      if (url.includes(`/apps/${eventLoaderId}/runs`)) return new Response(JSON.stringify({ id: "run1", status: "pending", appId: eventLoaderId }), { status: 200 });
      return new Response(JSON.stringify({ error: "NOT_FOUND" }), { status: 404 });
    }) as typeof fetch;
  };
  const exaCalls = () => calls.filter((c) => c.url.startsWith("https://api.exa.ai/"));
  const runInputs = () => {
    const c = calls.find((x) => x.url.includes(`/apps/${eventLoaderId}/runs`));
    assert.ok(c, "the Research agent run was started");
    return c.body.inputs as { orgs: string[]; sourceText: string };
  };

  beforeEach(() => { calls.length = 0; config.exaKey = "exa_test"; config.creaoAppKeys.eventLoader = "capi_test"; });
  afterEach(() => { globalThis.fetch = realFetch; config.exaKey = undefined; config.creaoAppKeys.eventLoader = undefined; store.runs.clear(); });

  test("no orgs: one Exa search for '<event> sponsors', its text goes to the agent as sourceText", async () => {
    stub({ status: 200, body: exaResults });
    const text = "hey im going to LA Hacks tomorrow";
    const ev = await createEvent({ name: "LA Hacks", date: "2026-10-19", orgs: [], sourceText: text }, { via: "imessage" });

    assert.equal(exaCalls().length, 1);
    assert.equal(exaCalls()[0].body.query, "LA Hacks sponsors");
    const inputs = runInputs();
    assert.deepEqual(inputs.orgs, []);
    assert.ok(inputs.sourceText.startsWith(text), "the wearer's own words come first");
    assert.match(inputs.sourceText, /Web search results for "LA Hacks sponsors"/);
    assert.match(inputs.sourceText, /https:\/\/lahacks\.com\/sponsors/);
    assert.match(inputs.sourceText, /Even Realities, CREAO, Sentry, Photon/);
    assert.match(inputs.sourceText, /Sponsored by CREAO and Sentry/);
    assert.equal(ev.loadStatus, "loading");
    assert.ok(ev.sources.some((s) => s.kind === "url" && s.raw.includes("lahacks.com/sponsors")), "the search is recorded as an event source");
    assert.equal(store.eventOrgs(ev.id).length, 0, "orgs come from the agent, not from the raw search");
  });

  test("orgs given: no sponsor search, sourceText is passed through unchanged", async () => {
    stub({ status: 200, body: exaResults });
    const text = "going to LA Hacks tomorrow, sponsors are Sentry and CREAO";
    const ev = await createEvent({ name: "LA Hacks", date: "2026-10-19", orgs: ["Sentry", "CREAO"], sourceText: text }, { via: "imessage" });

    assert.equal(exaCalls().length, 0);
    const inputs = runInputs();
    assert.deepEqual(inputs.orgs, ["Sentry", "CREAO"]);
    assert.equal(inputs.sourceText, text);
    assert.ok(!ev.sources.some((s) => s.kind === "url"));
    assert.deepEqual(store.eventOrgs(ev.id).map((o) => o.id).sort(), ["creao", "sentry"]);
  });

  test("Exa down: the run still starts with the wearer's words alone", async () => {
    stub({ status: 500, body: { error: "boom" } });
    const text = "I'm going to LA Hacks tomorrow";
    const ev = await createEvent({ name: "LA Hacks", date: "2026-10-19", orgs: [], sourceText: text }, { via: "imessage" });

    assert.equal(exaCalls().length, 1);
    assert.equal(runInputs().sourceText, text);
    assert.equal(ev.loadStatus, "loading");
    assert.ok(!ev.sources.some((s) => s.kind === "url"));
  });

  test("no Exa key: no search at all", async () => {
    config.exaKey = undefined;
    stub({ status: 200, body: exaResults });
    await createEvent({ name: "LA Hacks", date: "2026-10-19", orgs: [] }, { via: "setup" });
    assert.equal(exaCalls().length, 0);
    assert.equal(runInputs().sourceText, "");
  });
});
