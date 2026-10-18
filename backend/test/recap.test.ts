import "./_env.js";
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Brief } from "../../shared/types.js";
import { composeAnswer, composeEmail, composeRecap } from "../src/compose.js";
import { draftEmail, handleReply, metToday } from "../src/recap.js";
import { clipText, formatRecap, photonConfig, photonConfigured, sendRecap } from "../src/photon.js";
import { store } from "../src/store.js";

const brief = (p: Partial<Brief> & { name: string; org: string; createdAt?: string }): Brief => ({
  id: `b_${p.name.replace(/\s/g, "")}`, version: 1, eventId: store.activeEventId ?? "ev",
  transcript: `${p.name}, ${p.org}`,
  query: { name: p.name, org: p.org, role: p.role ?? "engineer" },
  match: { personId: null, confidence: "high", candidates: [] },
  cards: [
    { kind: "connect", title: "Ask about Seer", body: "Shipped Seer, an AI debugger.\nAsk what was hardest.", source: "sentry.io/blog" },
    { kind: "context", title: "Who they are", body: "Error monitoring for 100k teams.", source: "sentry.io" },
    { kind: "angle", title: "Your angle", body: "Ask how they test agents.", source: null },
  ],
  slowPath: { status: "none" },
  createdAt: p.createdAt ?? new Date().toISOString(), updatedAt: p.createdAt ?? new Date().toISOString(),
  ...p,
});

describe("photon recap", () => {
  beforeEach(() => { store.briefs.clear(); });

  test("not configured in tests: sendRecap is a no-op and never throws", async () => {
    assert.equal(photonConfigured(), false);
    const r = await sendRecap(brief({ name: "Jordan Lee", org: "Sentry" }), "+13105550100");
    assert.equal(r.sent, false);
  });

  test("formatRecap fits the cap and names the person, cards and sources", () => {
    const text = formatRecap(brief({ name: "Jordan Lee", org: "Sentry", role: "developer advocate" }));
    assert.ok(text.length <= photonConfig.maxChars, `${text.length} chars`);
    assert.match(text, /^Cue recap: Jordan Lee, developer advocate, Sentry/);
    assert.match(text, /Connect: /); assert.match(text, /Ask: /);
    assert.match(text, /Sources: sentry\.io\/blog, sentry\.io/);
  });

  test("formatRecap survives a 200-char body on every card", () => {
    const b = brief({ name: "Jordan Lee", org: "Sentry" });
    b.cards = b.cards.map((c) => ({ ...c, body: "x".repeat(200) }));
    assert.ok(formatRecap(b).length <= photonConfig.maxChars);
  });

  test("clipText keeps line breaks (the email arrived as one blob once) and caps length", () => {
    assert.equal(clipText("Hi Tim,\n\nThanks   for  today.\n\n\n\nBest", 100), "Hi Tim,\n\nThanks for today.\n\nBest");
    assert.ok(clipText("word ".repeat(100), 50).length <= 50);
  });

  test("draftEmail uses first name, short event name, debrief and the angle ask", () => {
    const b = brief({ name: "Jordan Lee", org: "Sentry", debrief: "she said to email her about the sim talk" });
    const mail = draftEmail(b);
    assert.match(mail, /^Subject: Great meeting you at /);
    assert.doesNotMatch(mail, /\(CREAO\)/);
    assert.match(mail, /\nHi Jordan,\n/);
    assert.match(mail, /she said to email her about the sim talk\./);
    assert.match(mail, /Ask how they test agents\./);
    assert.doesNotMatch(mail, /undefined/);
  });
});

describe("compose (no LLM key in tests: every writer falls back, never throws)", () => {
  test("composeRecap -> one template bubble", async () => {
    const out = await composeRecap(brief({ name: "Jordan Lee", org: "Sentry" }));
    assert.equal(out.length, 1);
    assert.match(out[0], /^Cue recap: Jordan Lee/);
  });
  test("composeEmail -> template subject and body with paragraphs", async () => {
    const { subject, body } = await composeEmail(brief({ name: "Jordan Lee", org: "Sentry" }));
    assert.match(subject, /^Great meeting you at /);
    assert.match(body, /^Hi Jordan,\n\n/);
  });
  test("composeAnswer -> honest fallback, and a text template when asked for a message", async () => {
    assert.match(await composeAnswer("what did he say about seer", null), /don't have anyone on file|No event loaded|look up <name>/);
    const b = brief({ name: "Jordan Lee", org: "Sentry" });
    assert.match(await composeAnswer("what did he say about seer", b), /only have what's in the brief/);
    assert.match(await composeAnswer("write me a text to send him", b), /^Follow-up for Jordan Lee:/);
  });
});

describe("handleReply", () => {
  beforeEach(() => { store.briefs.clear(); });

  test("'who did I meet' lists today's people once each, newest first", async () => {
    const old = new Date(Date.now() - 36 * 3600_000).toISOString();
    for (const b of [
      brief({ name: "Jordan Lee", org: "Sentry", createdAt: "2026-10-17T18:00:00.000Z" }),
      brief({ name: "Jordan Lee", org: "Sentry", id: "b_dup", createdAt: "2026-10-17T19:00:00.000Z" }),
      brief({ name: "Priya Shah", org: "Anduril", createdAt: "2026-10-17T17:00:00.000Z" }),
      brief({ name: "Old Person", org: "Vercel", createdAt: old }),
    ]) store.briefs.set(b.id, b);
    const now = new Date("2026-10-17T20:00:00.000Z");
    assert.equal(metToday(now).length, 2);
    const out = (await handleReply("who did I meet today?", null, now)) as string;
    assert.match(out, /^Today \(2\):/);
    assert.ok(out.indexOf("Jordan Lee") < out.indexOf("Priya Shah"));
    assert.doesNotMatch(out, /Old Person/);
  });

  test("'email' with no recap explains; with one, two bubbles: subject then body", async () => {
    assert.match((await handleReply("email", null)) as string, /No recap yet/);
    const b = brief({ name: "Jordan Lee", org: "Sentry", debrief: "she said email her about Seer" });
    store.briefs.set(b.id, b);
    // No agent connected in tests: the reply says so instead of writing with Haiku (CREAO is central).
    assert.match((await handleReply("draft email pls", b.id)) as string, /follow-up agent isn't connected/);
    // A failed agent run: the fast writer covers.
    store.briefs.set(b.id, { ...b, followUp: { status: "failed", runId: "run_failed" } });
    const { config } = await import("../src/config.js");
    const wasKey = config.creaoAppKeys.followUpWriter; const wasId = config.creaoAgents.followUpWriter;
    config.creaoAppKeys.followUpWriter = "capi_test"; config.creaoAgents.followUpWriter = "agent_test";
    let out: string[];
    try { out = (await handleReply("draft email pls", b.id)) as string[]; }
    finally { config.creaoAppKeys.followUpWriter = wasKey; config.creaoAgents.followUpWriter = wasId; store.runs.delete("run_failed"); }
    assert.equal(out.length, 2);
    assert.match(out[0], /^Subject: /);
    assert.match(out[1], /^Hi Jordan,/);
  });

  test("followUpGate reads the brief: pending waits (even over an older draft), no run but a debrief falls back, ready on the brief alone is served, a blocked gate still answers the rest", async () => {
    const { config } = await import("../src/config.js");
    const wasKey = config.creaoAppKeys.followUpWriter; const wasId = config.creaoAgents.followUpWriter;
    config.creaoAppKeys.followUpWriter = "capi_test"; config.creaoAgents.followUpWriter = "agent_test";
    try {
      // pending: a re-debrief restarted the run; the older email on the matched person must not answer
      store.loadSample();
      const jordan = [...store.people.values()].find((p) => p.name === "Jordan Lee")!;
      store.putPerson({ ...jordan, followUp: { email: { subject: "Old draft", body: "Hi Jordan,\n\nold" }, message: "old msg" } });
      const pending = brief({ name: "Jordan Lee", org: "Sentry", debrief: "second chat, she wants the demo video", match: { personId: jordan.id, confidence: "high", candidates: [] }, followUp: { status: "pending", runId: "run_p" } });
      store.briefs.set(pending.id, pending);
      assert.match((await handleReply("email", pending.id)) as string, /still writing/);
      assert.match((await handleReply("book", pending.id)) as string, /still working out times/);
      // a blocked gate still answers the second half of a compound question
      const both = (await handleReply("email, what should i lead with?", pending.id)) as string[];
      assert.ok(Array.isArray(both) && both.length >= 2, JSON.stringify(both));
      assert.match(both[0], /still writing/);
      // no run record at all (backend restarted, or the start failed) but a debrief: the fast writer covers
      const norun = brief({ name: "Priya Shah", org: "Anduril", debrief: "she said apply online" });
      store.briefs.set(norun.id, norun);
      const fb = (await handleReply("email", norun.id)) as string[];
      assert.equal(fb.length, 2); assert.match(fb[0], /^Subject: /); assert.match(fb[1], /^Hi Priya,/);
      // no debrief yet: says so
      const nod = brief({ name: "Sam Park", org: "Vercel" });
      store.briefs.set(nod.id, nod);
      assert.match((await handleReply("email", nod.id)) as string, /no debrief yet/);
      assert.match((await handleReply("book", nod.id)) as string, /hold the temple/);
      // ready on the brief with no matched person (a walk-up): the agent's email is what gets served
      const walkup = brief({ name: "Alex Kim", org: "Nobody Labs", debrief: "cool chat", followUp: { status: "ready", runId: "run_w", email: { subject: "From the agent", body: "Hi Alex,\n\nagent body" }, message: "agent text", schedule: { proposedTimes: ["2026-10-21 14:00-14:30"], inviteTitle: "t", inviteDescription: "d", schedulingMessage: "Hi Alex, would Wed 2pm work?", calendarEventCreated: false, eventLink: null } } });
      store.briefs.set(walkup.id, walkup);
      const ready = (await handleReply("email", walkup.id)) as string[];
      assert.deepEqual(ready, ["Subject: From the agent", "Hi Alex,\n\nagent body"]);
      assert.match(await composeAnswer("write me a text to send him", walkup), /agent text/);
      assert.match(((await handleReply("book", walkup.id)) as string[]).join("\n"), /would Wed 2pm work/);
    } finally { config.creaoAppKeys.followUpWriter = wasKey; config.creaoAgents.followUpWriter = wasId; }
  });

  test("help, empty, and free-form questions", async () => {
    assert.equal(await handleReply("   ", null), null);
    assert.match((await handleReply("help", null)) as string, /I can do a few things/);
    assert.match((await handleReply("what was his talk about", null)) as string, /don't have anyone on file|No event loaded|look up <name>/);
  });
});

describe("splitBubbles: texting shape", () => {
  test("short bubbles pass through, long ones split at sentence ends, max 5", async () => {
    const { splitBubbles } = await import("../src/compose.js");
    assert.deepEqual(splitBubbles(["just met tim cramer, sentry cofounder"]), ["just met tim cramer, sentry cofounder"]);
    const long = "He said to email him about Seer, they are hiring interns this summer. He also wants to see the Cue demo video before deciding anything. Reply email for a draft.";
    const out = splitBubbles([long], 80);
    assert.ok(out.length >= 2);
    for (const b of out) assert.ok(b.length <= 80, `"${b}" is ${b.length}`);
    assert.equal(splitBubbles(["a", "b", "c", "d", "e", "f", "g"]).length, 5);
  });
});

describe("CREAO Follow-up Writer output (followUp in the event file)", () => {
  test("loads, is used as the email fallback and the text-to-send fallback, and answers both halves of 'email, what should I lead with'", async () => {
    const os = await import("node:os"); const fs = await import("node:fs"); const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cue-followup-"));
    const file = path.join(dir, "ev.json");
    fs.writeFileSync(file, JSON.stringify({
      event: { id: "fu-test", name: "LA Hacks Fall 2026 (CREAO)", date: "2026-10-17", sources: [], loadStatus: "ready" },
      organizations: [{ id: "sentry", name: "Sentry", aliases: [], oneLiner: "", focusNow: [], people: [] }],
      people: [{ name: "Tim Cook", orgId: "sentry", role: "co-founder", followUp: {
        agent: "creao-follow-up-writer", agentId: "x", runLink: "https://agent.creao.ai/share/x",
        email: { subject: "Following up on Seer from LA Hacks", body: "Hi Tim,\n\nThanks for the pointer on Seer.\n\nBest,\nSam" },
        message: "Hi Tim, great meeting you at LA Hacks. Sam", nextSteps: ["Email Tim about Seer this week"],
      } }],
    }));
    const ev = store.loadSample(file, { withProfile: false });
    assert.equal(ev.id, "fu-test");
    const person = [...store.people.values()].find((p) => p.name === "Tim Cook" && p.eventId === "fu-test")!;
    assert.equal(person.followUp?.email?.subject, "Following up on Seer from LA Hacks");
    const b = brief({ name: "Tim Cook", org: "Sentry", eventId: "fu-test", match: { personId: person.id, confidence: "high", candidates: [] } });
    store.briefs.set(b.id, b);
    const { subject, body } = await composeEmail(b);
    assert.equal(subject, "Following up on Seer from LA Hacks");
    assert.match(body, /^Hi Tim,\n\nThanks/);
    assert.match(await composeAnswer("write me a text to send him", b), /great meeting you at LA Hacks/);
    const out = (await handleReply("email, what should i lead with?", b.id)) as string[];
    assert.ok(out.length >= 3, `expected subject, body and an answer, got ${out.length}`);
    assert.match(out[0], /^Subject: Following up on Seer/);
  });
});

describe("pre-event texting", () => {
  test("'look up <name>, <company>' runs a lookup and texts the cards; event questions answer from the pack", async () => {
    store.briefs.clear();
    store.loadSample(); // an active event (earlier tests may have switched it)
    const out = (await handleReply("look up Priya Shah, Anduril, recruiter", null)) as string[];
    assert.ok(Array.isArray(out) && out.length >= 2, JSON.stringify(out));
    assert.match(out[0], /^prep for Priya Shah, recruiter, Anduril/);
    const ev = await handleReply("who should I talk to at the event?", null);
    assert.match(String(ev), /look up <name>, <company>|people on the list|No event loaded/);
  });
});

describe("announcing an event over iMessage", () => {
  test("'hey, I'm going to LA Hacks tomorrow' creates the event (no agent in tests) and answers", async () => {
    const { parseEventText } = await import("../src/events.js");
    const now = new Date("2026-10-17T20:00:00.000Z");
    assert.deepEqual(parseEventText("hey, I'm going to LA Hacks tomorrow", now), { name: "LA Hacks", date: "2026-10-18", orgs: [] });
    assert.equal(parseEventText("hey, I'm going to the UCLA Engineering Career Fair on Friday with Sentry, Anduril", now)?.name, "UCLA Engineering Career Fair");
    assert.equal(parseEventText("what time is it", now), null);
    const out = await handleReply("hey im going to LA Hacks tomorrow", null);
    assert.match(String(out), /LA Hacks is set|building your LA Hacks pack/);
    assert.equal(store.activeEvent()?.name, "LA Hacks");
    store.loadSample();
  });
});
