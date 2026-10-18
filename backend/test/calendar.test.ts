import "./_env.js";
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Brief } from "../../shared/types.js";
import {
  __resetTokenForTests, __setFetchForTests, availabilityWithCalendar, calendarConfig, calendarConfigured, confirmSchedule,
  describeFree, freeWindows, fromWallClock, moveHold, parseSlot, pickSlot, slotString, wallClock,
} from "../src/calendar.js";
import { handleReply } from "../src/recap.js";
import { store } from "../src/store.js";

const TZ = "America/Los_Angeles";
const NOW = new Date("2026-10-17T20:00:00.000Z"); // Sat Oct 17 2026, 1pm PT
const la = (y: number, mo: number, d: number, h: number, mi = 0) => fromWallClock(y, mo, d, h, mi, TZ);

describe("calendar: wall clock without a date library", () => {
  test("round trips through a zone, across the DST edge", () => {
    const w = wallClock(new Date("2026-10-21T21:00:00.000Z"), TZ);
    assert.deepEqual(w, { y: 2026, mo: 10, d: 21, h: 14, mi: 0, dow: 3 });
    assert.equal(la(2026, 10, 21, 14).toISOString(), "2026-10-21T21:00:00.000Z");
    assert.equal(la(2026, 11, 2, 14).toISOString(), "2026-11-02T22:00:00.000Z"); // after Nov 1: PST
    assert.equal(la(2026, 10, 31, 24).toISOString(), la(2026, 11, 1, 0).toISOString()); // day overflow
    assert.equal(wallClock(new Date("2026-10-18T07:00:00.000Z"), TZ).h, 0); // midnight is 00, not 24
  });
  test("slot strings in the agent's format parse and print back", () => {
    const s = parseSlot("2026-10-21 14:00-14:30", TZ)!;
    assert.equal(s.start.toISOString(), "2026-10-21T21:00:00.000Z");
    assert.equal(slotString(s, TZ), "2026-10-21 14:00-14:30");
    assert.equal(parseSlot("tuesday afternoon", TZ), null);
  });
});

describe("calendar: free windows", () => {
  test("weekdays inside the hours, busy spans cut out, edges on the half hour, 30 minutes minimum", () => {
    const busy = [
      { start: la(2026, 10, 21, 14), end: la(2026, 10, 21, 15) },       // wed 2-3pm
      { start: la(2026, 10, 22, 12, 50), end: la(2026, 10, 22, 16, 40) }, // thu, ragged edges
      { start: la(2026, 10, 19, 9), end: la(2026, 10, 19, 18) },        // mon fully booked
    ];
    const out = freeWindows(busy, { now: NOW, tz: TZ, hours: [13, 17], days: 10, weekdaysOnly: true });
    const got = out.map((w) => slotString(w, TZ));
    assert.deepEqual(got, [
      "2026-10-20 13:00-17:00",
      "2026-10-21 13:00-14:00", "2026-10-21 15:00-17:00",
      "2026-10-23 13:00-17:00",
      "2026-10-26 13:00-17:00", "2026-10-27 13:00-17:00",
    ]);
    assert.ok(!got.some((s) => s.startsWith("2026-10-19")), "monday is fully booked");
    assert.ok(!got.some((s) => s.startsWith("2026-10-22")), "thursday has no 30-minute gap once snapped");
    assert.ok(!got.some((s) => s.startsWith("2026-10-24") || s.startsWith("2026-10-25")), "no weekends");
    assert.equal(describeFree(out, TZ, 2), "2026-10-20 13:00-17:00, 2026-10-21 13:00-14:00");
  });
  test("weekends allowed and no busy: every day from tomorrow", () => {
    const out = freeWindows([], { now: NOW, tz: TZ, hours: [10, 12], days: 3, weekdaysOnly: false });
    assert.deepEqual(out.map((w) => slotString(w, TZ)), ["2026-10-18 10:00-12:00", "2026-10-19 10:00-12:00", "2026-10-20 10:00-12:00"]);
  });
});

const SCHEDULE = {
  proposedTimes: ["2026-10-21 14:00-14:30", "2026-10-22 15:00-15:30", "2026-10-26 14:00-14:30"],
  inviteTitle: "Seer follow-up: David / Sam", inviteDescription: "30 min about Seer.",
  schedulingMessage: "Hi David, would Wed Oct 21 2pm, Thu Oct 22 3pm or Mon Oct 26 2pm work for a quick call? PT. Sam",
  calendarEventCreated: false, eventLink: null as string | null,
};

describe("calendar: off by default", () => {
  test("no GOOGLE_* vars: availability is the wearer's words, the agent's schedule passes through, book 2 explains", async () => {
    assert.equal(calendarConfigured(), false);
    assert.equal(await availabilityWithCalendar("weekday afternoons", NOW), "weekday afternoons");
    const r = await confirmSchedule(SCHEDULE, NOW);
    assert.deepEqual(r, { schedule: SCHEDULE, note: "calendar off" });
    const m = await moveHold(SCHEDULE, 2);
    assert.equal(m.moved, false);
    assert.match(m.reason!, /isn't connected/);
    const a = await moveHold({ ...SCHEDULE, calendarEventCreated: true, eventLink: "https://cal/x", holdSource: "agent" }, 2);
    assert.equal(a.moved, false);
    assert.equal(a.reason, "the agent placed that hold, drag it in google calendar");
  });
  test("pickSlot reads a number, an ordinal or a weekday; plain book is null", () => {
    assert.equal(pickSlot("book", SCHEDULE.proposedTimes, TZ), null);
    assert.equal(pickSlot("book 2", SCHEDULE.proposedTimes, TZ), 2);
    assert.equal(pickSlot("book the third one", SCHEDULE.proposedTimes, TZ), 3);
    assert.equal(pickSlot("book thursday", SCHEDULE.proposedTimes, TZ), 2);
    assert.equal(pickSlot("book mon", SCHEDULE.proposedTimes, TZ), 3);
    assert.equal(pickSlot("book friday", SCHEDULE.proposedTimes, TZ), null);
  });
});

/** A fake Google: one busy span, records every call, hands out ids. */
function fakeGoogle(busy: { start: string; end: string }[]) {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  let n = 0;
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body instanceof URLSearchParams ? Object.fromEntries(init.body) : undefined;
    calls.push({ method, url, body });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
    if (url.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "ya29.test", expires_in: 3600 });
    if (url.endsWith("/freeBusy")) return json({ calendars: { primary: { busy } } });
    if (/\/calendars\/primary\/events$/.test(url) && method === "POST") { n++; return json({ id: `evt${n}`, htmlLink: `https://calendar.google.com/event?eid=evt${n}` }); }
    if (/\/calendars\/primary\/events\/evt\d+$/.test(url) && method === "DELETE") return new Response("", { status: 204 });
    return json({ error: "unexpected" }, 500);
  }) as typeof fetch;
  return { f, calls };
}

describe("calendar: connected (fake Google)", () => {
  beforeEach(() => {
    Object.assign(calendarConfig, { clientId: "id", clientSecret: "secret", refreshToken: "rt", calendarId: "primary", timezone: TZ, hours: [13, 17] as [number, number], weekdaysOnly: true });
    __resetTokenForTests();
  });
  afterEach(() => {
    Object.assign(calendarConfig, { clientId: undefined, clientSecret: undefined, refreshToken: undefined });
    __setFetchForTests(null);
  });

  test("availability gets the free windows from free/busy, and the token is fetched once", async () => {
    const g = fakeGoogle([{ start: "2026-10-21T21:00:00Z", end: "2026-10-21T22:00:00Z" }]);
    __setFetchForTests(g.f);
    const text = await availabilityWithCalendar("weekday afternoons, not Tuesdays", NOW);
    assert.match(text, /^weekday afternoons, not Tuesdays\. Free windows from Google Calendar in America\/Los_Angeles, pick the three slots from inside these: 2026-10-19 13:00-17:00, 2026-10-20 13:00-17:00, 2026-10-21 13:00-14:00, 2026-10-21 15:00-17:00/);
    await availabilityWithCalendar("x", NOW);
    assert.equal(g.calls.filter((c) => c.url.includes("oauth2")).length, 1, "access token cached");
    const fb = g.calls.find((c) => c.url.endsWith("/freeBusy"))!;
    assert.equal((fb.body as { items: { id: string }[] }).items[0].id, "primary");
  });

  test("confirmSchedule drops the busy time and places a tentative hold with no attendees at the first free one", async () => {
    const g = fakeGoogle([{ start: "2026-10-21T21:00:00Z", end: "2026-10-21T22:00:00Z" }]); // wed 2-3pm PT
    __setFetchForTests(g.f);
    const { schedule, note } = await confirmSchedule(SCHEDULE, NOW);
    assert.deepEqual(schedule.proposedTimes, ["2026-10-22 15:00-15:30", "2026-10-26 14:00-14:30"]);
    assert.equal(schedule.calendarEventCreated, true);
    assert.equal(schedule.holdSource, "backend");
    assert.equal(schedule.holdEventId, "evt1");
    assert.equal(schedule.eventLink, "https://calendar.google.com/event?eid=evt1");
    assert.equal(note, "calendar: dropped 1 busy time, hold placed at 2026-10-22 15:00-15:30");
    const ins = g.calls.find((c) => c.method === "POST" && /events$/.test(c.url))!.body as Record<string, unknown>;
    assert.equal(ins.status, "tentative");
    assert.equal(ins.summary, SCHEDULE.inviteTitle);
    assert.equal((ins.start as { dateTime: string }).dateTime, "2026-10-22T22:00:00.000Z");
    assert.equal((ins.end as { dateTime: string }).dateTime, "2026-10-22T22:30:00.000Z");
    assert.ok(!("attendees" in ins), "never invites anyone");
  });

  test("the agent's own hold is kept; all-busy means no hold; a Google error keeps the agent's schedule", async () => {
    const g = fakeGoogle([]);
    __setFetchForTests(g.f);
    const r1 = await confirmSchedule({ ...SCHEDULE, calendarEventCreated: true, eventLink: "https://cal/x", holdSource: "agent" }, NOW);
    assert.equal(r1.schedule.eventLink, "https://cal/x");
    assert.equal(r1.note, "calendar: all times free, hold from the agent kept");
    assert.ok(!g.calls.some((c) => c.method === "POST" && /events$/.test(c.url)));

    const g2 = fakeGoogle([{ start: "2026-10-19T00:00:00Z", end: "2026-10-30T00:00:00Z" }]);
    __setFetchForTests(g2.f);
    const r2 = await confirmSchedule(SCHEDULE, NOW);
    assert.deepEqual(r2.schedule.proposedTimes, []);
    assert.equal(r2.schedule.calendarEventCreated, false);
    assert.equal(r2.note, "calendar: dropped 3 busy times, no hold");

    __setFetchForTests((async () => new Response("boom", { status: 500 })) as typeof fetch);
    __resetTokenForTests();
    const r3 = await confirmSchedule(SCHEDULE, NOW);
    assert.deepEqual(r3.schedule, SCHEDULE);
    assert.equal(r3.note, "calendar: error, agent schedule kept");
  });

  test("moveHold deletes the backend's hold and creates one at the chosen time; the chosen time moves first", async () => {
    const g = fakeGoogle([]);
    __setFetchForTests(g.f);
    const held = { ...SCHEDULE, calendarEventCreated: true, eventLink: "https://calendar.google.com/event?eid=evt0", holdEventId: "evt0", holdSource: "backend" as const };
    const r = await moveHold(held, 2);
    assert.equal(r.moved, true);
    assert.deepEqual(r.schedule.proposedTimes, ["2026-10-22 15:00-15:30", "2026-10-21 14:00-14:30", "2026-10-26 14:00-14:30"]);
    assert.equal(r.schedule.holdEventId, "evt1");
    assert.deepEqual(g.calls.filter((c) => c.method !== "POST" || !c.url.includes("oauth2")).map((c) => c.method), ["DELETE", "POST"]);
    assert.equal((await moveHold(held, 4)).reason, "there is no time 4");
  });

  test("'book 2' over iMessage moves the hold and answers in the texting voice; plain 'book' hands over the message", async () => {
    const g = fakeGoogle([]);
    __setFetchForTests(g.f);
    store.briefs.clear();
    store.putPerson({ id: "p_cal", eventId: "ev-cal", orgId: "sentry", name: "David Cramer", facts: [], match: "high", matchReason: "test",
      followUp: { schedule: { ...SCHEDULE, calendarEventCreated: true, eventLink: "https://calendar.google.com/event?eid=evt0", holdEventId: "evt0", holdSource: "backend" } } });
    const b: Brief = {
      id: "b_cal", version: 1, eventId: "ev-cal", transcript: "David Cramer, Sentry",
      query: { name: "David Cramer", org: "Sentry", role: "co-founder" }, match: { personId: "p_cal", confidence: "high", candidates: [] },
      cards: [{ kind: "connect", title: "Ask about Seer", body: "x", source: null }], slowPath: { status: "none" },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    store.briefs.set(b.id, b);
    const out = (await handleReply("book thursday", b.id)) as string[];
    assert.deepEqual(out, [
      "moved your hold to thu oct 22 3-3:30pm 📅",
      "https://calendar.google.com/event?eid=evt1",
      "here's what to send david, copy and tweak",
      SCHEDULE.schedulingMessage,
    ]);
    assert.equal(store.people.get("p_cal")!.followUp!.schedule!.holdEventId, "evt1");
    const plain = (await handleReply("book", b.id)) as string[];
    assert.equal(plain[0], "here's what to send david, copy and tweak");
    assert.equal(plain[1], SCHEDULE.schedulingMessage);
    assert.equal(((await handleReply("book 3", b.id)) as string[])[0], "moved your hold to mon oct 26 2-2:30pm 📅");
  });
});
