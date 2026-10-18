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
    assert.equal(clipText("Hi David,\n\nThanks   for  today.\n\n\n\nBest", 100), "Hi David,\n\nThanks for today.\n\nBest");
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
    const b = brief({ name: "Jordan Lee", org: "Sentry" });
    store.briefs.set(b.id, b);
    const out = (await handleReply("draft email pls", b.id)) as string[];
    assert.equal(out.length, 2);
    assert.match(out[0], /^Subject: /);
    assert.match(out[1], /^Hi Jordan,/);
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
    assert.deepEqual(splitBubbles(["just met david cramer, sentry cofounder"]), ["just met david cramer, sentry cofounder"]);
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
      people: [{ name: "David Cramer", orgId: "sentry", role: "co-founder", followUp: {
        agent: "creao-follow-up-writer", agentId: "x", runLink: "https://agent.creao.ai/share/x",
        email: { subject: "Following up on Seer from LA Hacks", body: "Hi David,\n\nThanks for the pointer on Seer.\n\nBest,\nSam" },
        message: "Hi David, great meeting you at LA Hacks. Sam", nextSteps: ["Email David about Seer this week"],
      } }],
    }));
    const ev = store.loadSample(file, { withProfile: false });
    assert.equal(ev.id, "fu-test");
    const person = [...store.people.values()].find((p) => p.name === "David Cramer" && p.eventId === "fu-test")!;
    assert.equal(person.followUp?.email?.subject, "Following up on Seer from LA Hacks");
    const b = brief({ name: "David Cramer", org: "Sentry", eventId: "fu-test", match: { personId: person.id, confidence: "high", candidates: [] } });
    store.briefs.set(b.id, b);
    const { subject, body } = await composeEmail(b);
    assert.equal(subject, "Following up on Seer from LA Hacks");
    assert.match(body, /^Hi David,\n\nThanks/);
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
