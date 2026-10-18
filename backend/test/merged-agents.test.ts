import "./_env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Brief } from "../../shared/types.js";
import { applyResult, extractResult, SHAPES } from "../src/creao.js";
import { store } from "../src/store.js";

// The three merged agents (agents/research.md, follow-up.md, coach.md) return the old split outputs
// in one object. The backend must accept both.
describe("merged agent outputs", () => {
  test("Follow-up output with an embedded schedule stores both on the person, no scheduler run", async () => {
    const ev = store.activeEventId!;
    const person = store.upsertPerson(ev, "sentry", "Steve Jobs", { role: "co-founder", facts: [], match: "high", matchReason: "test", fromEventList: true });
    const brief: Brief = {
      id: "b_merged", version: 1, eventId: ev, transcript: "Steve Jobs, Sentry",
      query: { name: "Steve Jobs", org: "Sentry", role: "co-founder" },
      match: { personId: person.id, confidence: "high", candidates: [] },
      cards: [{ kind: "connect", title: "Ask about Seer", body: "x", source: null }],
      slowPath: { status: "none" }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    store.briefs.set(brief.id, brief);
    const out = {
      email: { subject: "Seer and the demo video", body: "Hi Steve,\n\nThanks.\n\nSam" },
      message: "Hi Steve, great meeting you. Sam", nextSteps: ["email steve tonight"], draftLink: null,
      schedule: { proposedTimes: ["2026-10-22 14:00-14:30", "2026-10-23 15:00-15:30", "2026-10-26 14:00-14:30"], inviteTitle: "Seer: Steve / Sam", inviteDescription: "Follow-up on Seer.", schedulingMessage: "Hi Steve, 30 min on Seer? Wed 2pm, Thu 3pm or Mon 2pm PT. Sam", calendarEventCreated: false, eventLink: null },
    };
    assert.ok(SHAPES.follow_up_writer(out));
    await applyResult({ runId: "run_m1", agent: "follow_up_writer", briefId: brief.id, personId: person.id, status: "completed", startedAt: new Date().toISOString() }, out);
    const p = store.people.get(person.id)!;
    assert.equal(p.followUp?.email?.subject, "Seer and the demo video");
    assert.equal(p.followUp?.schedule?.proposedTimes.length, 3);
    assert.match(p.followUp?.schedule?.schedulingMessage ?? "", /Hi Steve/);
    assert.equal([...store.runs.values()].some((r) => r.agent === "meeting_scheduler"), false);
  });

  test("Research output with cards is the person_researcher shape and carries the cards through extraction", async () => {
    const out = {
      name: "Steve Jobs", orgId: "sentry", role: "co-founder", headline: "Co-founder of Sentry",
      facts: [{ text: "Steve Jobs of Sentry spoke at SREcon.", sourceUrl: "https://usenix.org/x", sourceKind: "talk" }],
      match: "high", matchReason: "x",
      cards: [{ kind: "connect", title: "Ask about Seer", body: "Seer debugs from traces.", source: "usenix.org/x" }],
      improvesOn: "uses his talk",
    };
    assert.ok(SHAPES.person_researcher(out));
    const found = (await extractResult({ run_id: "r", status: "completed", agent_id: "a", conversation_id: null, result: { chat_text: "```json\n" + JSON.stringify(out) + "\n```" } }, "person_researcher")) as { cards: unknown[] };
    assert.equal(found.cards.length, 1);
  });
});

describe("one wave per conversation (3 bubbles)", () => {
  test("followUpWave is at most 3 bubbles: email, next steps, times + book", async () => {
    const { followUpWave } = await import("../src/voice.js");
    const wave = followUpWave(
      { email: { subject: "Seer", body: "Hi Steve,\n\nThanks for the chat.\n\nSam" }, message: "hi", nextSteps: ["email steve tonight", "apply to sentry"] },
      { proposedTimes: ["2026-10-22 14:00-14:30", "2026-10-23 15:00-15:30", "2026-10-26 14:00-14:30"], schedulingMessage: "x", eventLink: "https://calendar.google.com/x" },
      "Steve",
    );
    assert.ok(wave.length <= 3, `${wave.length} bubbles`);
    assert.equal(wave[0], "Hi Steve,\n\nThanks for the chat.\n\nSam");
    assert.match(wave[1], /^next: email steve tonight; apply to sentry/);
    assert.match(wave[2], /times for steve: .*say book for the message/);
    assert.match(wave[2], /hold's on your calendar/);
  });
});
