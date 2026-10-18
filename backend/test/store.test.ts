import "./_env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { findOrg } from "../src/parse.js";
import { norm, slug, store } from "../src/store.js";
import { DATA_DIR, dataFile } from "./_helpers.js";

const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".json") && !f.endsWith(".local.json"));

describe("bundled event files", () => {
  test("data/ has event files", () => { assert.ok(files.length >= 1); });
  for (const file of files) {
    test(`${file} loads and produces orgs and people`, () => {
      const raw = JSON.parse(fs.readFileSync(dataFile(file), "utf8"));
      const ev = store.loadSample(dataFile(file));
      assert.equal(store.activeEventId, ev.id);
      const orgs = store.eventOrgs();
      assert.ok(orgs.length >= raw.organizations.length, "all orgs present");
      for (const o of raw.organizations) {
        const got = store.getOrg(ev.id, o.id);
        assert.ok(got, `org ${o.id}`);
        assert.equal(got.eventId, ev.id);
        assert.ok(got.name && Array.isArray(got.aliases) && Array.isArray(got.focusNow));
        for (const f of got.focusNow) assert.ok(f.text && f.sourceUrl, `${o.id} focusNow has text + url`);
        // every org resolves by name and by each alias
        for (const label of [o.name, ...o.aliases]) assert.equal(findOrg(label)?.id, o.id, `${file}: "${label}" -> ${o.id}`);
      }
      for (const p of raw.people ?? []) {
        const got = store.eventPeople().find((x) => x.orgId === p.orgId && norm(x.name) === norm(p.name));
        assert.ok(got, `person ${p.name}`);
        assert.equal(got.match, "high");
        assert.ok(store.getOrg(ev.id, p.orgId), `${p.name}'s org ${p.orgId} exists`);
      }
    });
  }
  test("withProfile: false keeps the pasted profile", () => {
    store.profile = { ...store.profile, name: "Pasted" };
    store.loadSample(dataFile("sample-event.json"), { withProfile: false });
    assert.equal(store.profile.name, "Pasted");
    store.loadSample(dataFile("sample-event.json"));
    assert.notEqual(store.profile.name, "Pasted");
  });
  test("switching to another event only exposes that event's orgs", () => {
    store.loadSample(dataFile("sample-event.json"));
    store.loadSample(dataFile("creao-career-fair.json"));
    assert.deepEqual(store.eventOrgs().map((o) => o.id).sort(), ["anduril", "cloudflare", "vercel"]);
    assert.equal(findOrg("Sentry"), null);
  });
  test("reloading a file with the same event id does not keep the other file's people", () => {
    store.loadSample(dataFile("sample-event.json"));
    store.loadSample(dataFile("lahacks-f26.json"));
    assert.equal(store.eventPeople().length, 0);
  });
});

describe("store helpers", () => {
  test("slug / norm", () => {
    assert.equal(slug("Even Realities!"), "even-realities");
    assert.equal(slug("  José  Ñ "), "jose-n");
    assert.equal(norm("Sentry.io"), "sentryio");
  });
  test("upsertPerson dedupes by normalized name within an org", () => {
    store.loadSample(dataFile("sample-event.json"));
    const a = store.upsertPerson("lahacks-f26", "sentry", "jordan lee", { role: "x" });
    const b = store.eventPeople().filter((p) => p.orgId === "sentry" && norm(p.name) === "jordanlee");
    assert.equal(b.length, 1);
    assert.equal(a.id, b[0].id);
  });
});

describe("runtime events persist", () => {
  test("saveEventFile + loadLocalEvents restore an event, its orgs and researched people", async () => {
    const { createEvent } = await import("../src/events.js");
    const ev = await createEvent({ name: "Persist Test Expo", date: "2026-10-18", orgs: ["Sentry"], people: [{ name: "Steve Jobs", org: "Sentry", role: "co-founder" }] }, { via: "imessage" });
    const file = store.saveEventFile(ev.id);
    assert.ok(file && file.endsWith(`${ev.id}.local.json`));
    store.events.delete(ev.id);
    for (const [k, p] of store.people) if (p.eventId === ev.id) store.people.delete(k);
    const ids = store.loadLocalEvents();
    assert.ok(ids.includes(ev.id));
    assert.equal(store.events.get(ev.id)?.name, "Persist Test Expo");
    assert.ok(store.eventPeople(ev.id).some((p) => p.name === "Steve Jobs"));
    store.loadSample();
  });
});
