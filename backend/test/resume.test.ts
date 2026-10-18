import "./_env.js";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { app } from "../src/app.js";
import { config } from "../src/config.js";

let server: Server;
let base = "";
before(async () => {
  assert.equal(config.anthropicKey, undefined);
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((r) => server.close(() => r())));

const post = (type: string, body: BodyInit | null) =>
  fetch(`${base}/api/profile/resume`, { method: "POST", headers: type ? { "content-type": type } : {}, body });

describe("POST /api/profile/resume", () => {
  test("rejects an unsupported type", async () => {
    const res = await post("image/png", "xx");
    assert.equal(res.status, 400);
    const j = await res.json();
    assert.equal(j.error.code, "BAD_REQUEST");
    assert.match(j.error.message, /application\/pdf or text\/plain/);
  });
  test("rejects an empty body", async () => {
    const res = await post("text/plain", "");
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "BAD_REQUEST");
  });
  test("503 LLM_UNAVAILABLE when no model key (never a 500, never a fake draft)", async () => {
    const res = await post("text/plain", "Jordan Lee\nUCLA, Computer Science\nProjects: Cue, a glasses app");
    assert.equal(res.status, 503);
    const j = await res.json();
    assert.equal(j.error.code, "LLM_UNAVAILABLE");
    assert.match(j.error.message, /ANTHROPIC_API_KEY/);
  });
  test("profile is unchanged by an upload attempt", async () => {
    const before = await (await fetch(`${base}/api/profile`)).json();
    await post("text/plain", "Someone Else\nMIT");
    const afterP = await (await fetch(`${base}/api/profile`)).json();
    assert.deepEqual(afterP, before);
  });
});
