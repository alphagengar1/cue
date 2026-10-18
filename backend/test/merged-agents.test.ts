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
    const person = store.upsertPerson(ev, "sentry", "David Cramer", { role: "co-founder", facts: [], match: "high", matchReason: "test", fromEventList: true });
    const brief: Brief = {
      id: "b_merged", version: 1, eventId: ev, transcript: "David Cramer, Sentry",
      query: { name: "David Cramer", org: "Sentry", role: "co-founder" },
      match: { personId: person.id, confidence: "high", candidates: [] },
      cards: [{ kind: "connect", title: "Ask about Seer", body: "x", source: null }],
      slowPath: { status: "none" }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    store.briefs.set(brief.id, brief);
    const out = {
      email: { subject: "Seer and the demo video", body: "Hi David,\n\nThanks.\n\nSam" },
      message: "Hi David, great meeting you. Sam", nextSteps: ["email david tonight"], draftLink: null,
      schedule: { proposedTimes: ["2026-10-22 14:00-14:30", "2026-10-23 15:00-15:30", "2026-10-26 14:00-14:30"], inviteTitle: "Seer: David / Sam", inviteDescription: "Follow-up on Seer.", schedulingMessage: "Hi David, 30 min on Seer? Wed 2pm, Thu 3pm or Mon 2pm PT. Sam", calendarEventCreated: false, eventLink: null },
    };
    assert.ok(SHAPES.follow_up_writer(out));
    await applyResult({ runId: "run_m1", agent: "follow_up_writer", briefId: brief.id, personId: person.id, status: "completed", startedAt: new Date().toISOString() }, out);
    const p = store.people.get(person.id)!;
    assert.equal(p.followUp?.email?.subject, "Seer and the demo video");
    assert.equal(p.followUp?.schedule?.proposedTimes.length, 3);
    assert.match(p.followUp?.schedule?.schedulingMessage ?? "", /Hi David/);
    assert.equal([...store.runs.values()].some((r) => r.agent === "meeting_scheduler"), false);
  });

  test("Research output with cards is the person_researcher shape and carries the cards through extraction", async () => {
    const out = {
      name: "David Cramer", orgId: "sentry", role: "co-founder", headline: "Co-founder of Sentry",
      facts: [{ text: "David Cramer of Sentry spoke at SREcon.", sourceUrl: "https://usenix.org/x", sourceKind: "talk" }],
      match: "high", matchReason: "x",
      cards: [{ kind: "connect", title: "Ask about Seer", body: "Seer debugs from traces.", source: "usenix.org/x" }],
      improvesOn: "uses his talk",
    };
    assert.ok(SHAPES.person_researcher(out));
    const found = (await extractResult({ run_id: "r", status: "completed", agent_id: "a", conversation_id: null, result: { chat_text: "```json\n" + JSON.stringify(out) + "\n```" } }, "person_researcher")) as { cards: unknown[] };
    assert.equal(found.cards.length, 1);
  });
});
