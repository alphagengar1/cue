import "./_env.js";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Brief } from "../../shared/types.js";
import { app } from "../src/app.js";
import { config } from "../src/config.js";
import { assertValidCard } from "./_helpers.js";

let server: Server;
let base = "";
before(async () => {
  assert.equal(config.anthropicKey, undefined);
  assert.equal(config.exaKey, undefined);
  assert.equal(config.deepgramKey, undefined);
  assert.equal(config.creaoKey, undefined);
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((r) => server.close(() => r())));

const call = (method: string, path: string, body?: unknown, raw?: string) =>
  fetch(base + path, {
    method,
    headers: body !== undefined || raw !== undefined ? { "content-type": "application/json" } : {},
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
async function expectError(res: Response, status: number, code: string, msg?: RegExp) {
  assert.equal(res.status, status);
  const j = (await res.json()) as { error: { code: string; message: string } };
  assert.equal(j.error.code, code);
  assert.ok(j.error.message.length > 0);
  if (msg) assert.match(j.error.message, msg);
}

describe("GET /api/state", () => {
  test("returns the sample event, goal, profile summary and orgs", async () => {
    const res = await call("GET", "/api/state");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    const s = await res.json();
    assert.equal(s.event.id, "lahacks-f26");
    assert.equal(s.goal, "internship");
    assert.ok(s.profile.name);
    assert.ok(s.orgs.some((o: { id: string }) => o.id === "sentry"));
  });
  test("CORS preflight -> 204 with Authorization allowed", async () => {
    const res = await call("OPTIONS", "/api/briefs/text");
    assert.equal(res.status, 204);
    assert.match(res.headers.get("access-control-allow-headers") ?? "", /Authorization/);
  });
});

describe("briefs", () => {
  let brief: Brief;
  test("POST /api/briefs/text -> template brief", async () => {
    const res = await call("POST", "/api/briefs/text", { text: "Jordan, Sentry, developer advocate" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-cue-fallback"), "template");
    assert.match(res.headers.get("server-timing") ?? "", /total;dur=/);
    brief = ((await res.json()) as { brief: Brief }).brief;
    assert.equal(brief.version, 1);
    assert.equal(brief.match.confidence, "high");
    assert.deepEqual(brief.query, { name: "Jordan Lee", org: "Sentry", role: "developer advocate" }); // resolved from the event list
    brief.cards.forEach(assertValidCard);
  });
  test("GET /api/briefs/:id -> 200, ?since=version -> 304, ?since=0 -> 200", async () => {
    const a = await call("GET", `/api/briefs/${brief.id}`);
    assert.equal(a.status, 200);
    assert.equal(((await a.json()) as { brief: Brief }).brief.id, brief.id);
    assert.equal((await call("GET", `/api/briefs/${brief.id}?since=${brief.version}`)).status, 304);
    assert.equal((await call("GET", `/api/briefs/${brief.id}?since=0`)).status, 200);
  });
  test("GET /api/briefs/latest -> latest brief", async () => {
    const res = await call("GET", "/api/briefs/latest");
    assert.equal(res.status, 200);
  });
  test("GET unknown brief -> 404 NOT_FOUND", async () => {
    await expectError(await call("GET", "/api/briefs/brf_nope"), 404, "NOT_FOUND", /brf_nope/);
  });

  test("PUT /api/goal with briefId -> new angle, version 2, other cards identical", async () => {
    const res = await call("PUT", "/api/goal", { goal: "cofounder", briefId: brief.id });
    assert.equal(res.status, 200);
    const j = (await res.json()) as { goal: string; brief: Brief };
    assert.equal(j.goal, "cofounder");
    assert.equal(j.brief.version, 2);
    assert.deepEqual(j.brief.cards.filter((c) => c.kind !== "angle"), brief.cards.filter((c) => c.kind !== "angle"));
    assert.match(j.brief.cards.find((c) => c.kind === "angle")!.body, /start a company/);
    assert.equal((await call("GET", `/api/briefs/${brief.id}?since=1`)).status, 200, "poll sees v2");
  });
  test("POST /api/goal without briefId only changes the goal", async () => {
    const res = await call("POST", "/api/goal", { goal: "learn" });
    assert.deepEqual(await res.json(), { goal: "learn" });
    assert.equal((await (await call("GET", "/api/state")).json()).goal, "learn");
  });
  test("goal with unknown briefId -> 404", async () => {
    await expectError(await call("PUT", "/api/goal", { goal: "learn", briefId: "brf_nope" }), 404, "NOT_FOUND");
  });
  test("confirm null -> org-only brief", async () => {
    const res = await call("POST", `/api/briefs/${brief.id}/confirm`, { personId: null });
    assert.equal(res.status, 200);
    const b = ((await res.json()) as { brief: Brief }).brief;
    assert.deepEqual(b.cards.map((c) => c.kind), ["context"]);
  });
  test("unknown org over HTTP -> angle-only brief", async () => {
    const res = await call("POST", "/api/briefs/text", { text: "Priya, Anduril, recruiter" });
    assert.equal(res.status, 200);
    const b = ((await res.json()) as { brief: Brief }).brief;
    assert.deepEqual(b.cards.map((c) => c.kind), ["angle"]);
  });
});

describe("bad input -> 400 with a clear error", () => {
  test("missing text", async () => {
    await expectError(await call("POST", "/api/briefs/text", {}), 400, "BAD_REQUEST", /text/);
  });
  test("empty / whitespace text", async () => {
    await expectError(await call("POST", "/api/briefs/text", { text: "   " }), 400, "BAD_REQUEST", /text/);
  });
  test("text over 300 chars", async () => {
    await expectError(await call("POST", "/api/briefs/text", { text: "a".repeat(301) }), 400, "BAD_REQUEST", /text/);
  });
  test("text with no name", async () => {
    await expectError(await call("POST", "/api/briefs/text", { text: "..." }), 400, "BAD_REQUEST", /name/);
  });
  test("malformed JSON", async () => {
    await expectError(await call("POST", "/api/briefs/text", undefined, "{not json"), 400, "BAD_REQUEST", /Invalid JSON/);
  });
  test("unknown goal", async () => {
    await expectError(await call("PUT", "/api/goal", { goal: "world_domination" }), 400, "BAD_REQUEST", /goal/);
  });
  test("confirm with a non-candidate personId", async () => {
    const b = ((await (await call("POST", "/api/briefs/text", { text: "Maya, Even Realities" })).json()) as { brief: Brief }).brief;
    await expectError(await call("POST", `/api/briefs/${b.id}/confirm`, { personId: "per_nobody" }), 400, "BAD_REQUEST", /candidate/);
  });
  test("unknown route -> 404 NOT_FOUND", async () => {
    await expectError(await call("GET", "/api/nope"), 404, "NOT_FOUND");
  });
});

describe("stt input checks", () => {
  test("bad X-Audio-Format rate/channels -> 400 BAD_REQUEST (not a 500)", async () => {
    for (const fmt of ["pcm_s16le;rate=99999999999", "pcm_s16le;rate=16000;channels=0", "pcm_s16le;channels=9", "pcm_s16le;rate=abc"]) {
      const res = await fetch(`${base}/api/stt`, {
        method: "POST", headers: { "content-type": "application/octet-stream", "x-audio-format": fmt }, body: new Uint8Array(320),
      });
      await expectError(res, 400, "BAD_REQUEST", /audio/);
    }
  });
});

describe("rate limit covers the LLM routes", () => {
  test("goal and confirm -> 429 when the limit is reached", async () => {
    const prev = config.lookupsPerMinute;
    config.lookupsPerMinute = 0;
    try {
      await expectError(await call("PUT", "/api/goal", { goal: "learn" }), 429, "RATE_LIMITED");
      await expectError(await call("POST", "/api/briefs/brf_x/confirm", { personId: null }), 429, "RATE_LIMITED");
    } finally {
      config.lookupsPerMinute = prev;
    }
  });
});

describe("auth", () => {
  test("DEVICE_TOKEN set -> 401 without bearer, 200 with it", async () => {
    config.deviceToken = "test-token";
    try {
      await expectError(await call("GET", "/api/state"), 401, "UNAUTHORIZED");
      const ok = await fetch(`${base}/api/state`, { headers: { authorization: "Bearer test-token" } });
      assert.equal(ok.status, 200);
    } finally {
      config.deviceToken = undefined;
    }
  });
});
