import "./_env.js";
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Brief } from "../../shared/types.js";
import { handleReply } from "../src/recap.js";
import { store } from "../src/store.js";
import {
  LINE_MAX, MAX_BUBBLES, bookBubbles, casual, coachBubbles, firstName, followUpBubbles, friendlyTime, scheduleBubbles,
} from "../src/voice.js";

const EMAIL = {
  subject: "Following up on Seer from LA Hacks",
  body: "Hi Tim,\n\nThanks for talking at LA Hacks. You said to email you about Seer and that Sentry is hiring summer interns.\n\n" +
    "Here is the Cue demo video you asked for. I would like to try Seer on Cue's Sentry traces and hear who to talk to about summer 2027.\n\n" +
    "Best,\nSam, UCLA",
};
const FOLLOW_UP = {
  email: EMAIL,
  message: "Hi Tim, great meeting you at LA Hacks. Emailing you about Seer tonight, demo video included. Sam",
  nextSteps: ["Email Tim about Seer tonight with the demo video.", "Apply to Sentry's summer internship and mention the conversation.", "Read about the Open Source Pledge."],
};
const SCHEDULE = {
  proposedTimes: ["2026-10-21 14:00-14:30", "2026-10-22 15:00-15:30", "2026-10-26 14:00-14:30"],
  inviteTitle: "Cue x Sentry: Seer follow-up", inviteDescription: "30 min about Seer",
  schedulingMessage: "Hi Tim, would any of these work for a quick 30 min call about Seer? Wed Oct 21 2pm, Thu Oct 22 3pm or Mon Oct 26 2pm, all PT. Sam",
  calendarEventCreated: true, eventLink: "https://calendar.google.com/event?eid=abc123",
};
// The real coach run the wearer called too cooked.
const COOKED_COACH = {
  summary: "He offered an email thread about Seer, said Sentry is hiring summer interns, and asked for the Cue demo video. That is the strongest lead of the day and it maps straight to your internship goal.",
  patterns: ["You did not ask for a next step in two of three conversations.", "Every conversation touched on Cue's demo."],
  priorities: [
    { name: "Tim Cook", why: "He asked for the demo video and said they are hiring.", action: "Send the email tonight, lead with the video." },
    { name: "Alex Kim", why: "", action: "DM him on GitHub with the demo link" },
  ],
  coaching: ["Ask for a next step before you walk away.", "Keep the Cue pitch to one sentence."],
  nextTime: "Before you leave, ask what the next step is.",
};

const LABEL = /^(subject|patterns?|priorities|next steps?|follow up first|next conversation|coach|coaching|summary|action)\s*[:🧠]/i;
const LIST = /(^|\n)\s*(?:[-•*]|\d+[.)])\s/;
const EMOJI = /\p{Extended_Pictographic}/gu;

/** Every bubble that is not a copy-paste whole (the email, the scheduling message, a link) obeys the texting shape. */
const checkShape = (bubbles: string[], wholes: string[] = []) => {
  assert.ok(bubbles.length >= 1 && bubbles.length <= MAX_BUBBLES, `${bubbles.length} bubbles`);
  for (const b of bubbles) {
    assert.doesNotMatch(b, LABEL, `label in "${b}"`);
    assert.doesNotMatch(b, /[*_#`]/, `markdown in "${b}"`);
    assert.ok((b.match(EMOJI) ?? []).length <= 1, `more than one emoji in "${b}"`);
    if (wholes.includes(b) || /^https?:\/\/\S+$/.test(b)) continue;
    assert.ok(b.length < LINE_MAX, `"${b}" is ${b.length} chars`);
    assert.doesNotMatch(b, /\n/, `line break in "${b}"`);
    assert.doesNotMatch(b, LIST, `list in "${b}"`);
    assert.doesNotMatch(b, /[.,;]$/, `trailing punctuation in "${b}"`);
    assert.match(b, /^[^A-Z]/, `starts with a capital: "${b}"`);
  }
};

describe("voice: casual lines", () => {
  test("lowercases the first letter, keeps acronyms, drops bullets, labels, markdown and the trailing period", () => {
    assert.equal(casual("Email Tim about Seer this week."), "email Tim about Seer this week");
    assert.equal(casual("UCLA is where you met."), "UCLA is where you met");
    assert.equal(casual("- **Ask** for a next step"), "ask for a next step");
    assert.equal(casual("patterns: you never ask for a next step"), "you never ask for a next step");
    assert.equal(casual("  two   spaces\nand a break "), "two spaces and a break");
    assert.equal(casual("really?"), "really?");
    assert.equal(casual("wait..."), "wait...");
  });
  test("firstName", () => {
    assert.equal(firstName("Tim Cook"), "tim");
    assert.equal(firstName("  Priya "), "priya");
    assert.equal(firstName(undefined), "");
  });
  test("friendlyTime turns the agent's slot format into a short human time and passes anything else through", () => {
    assert.equal(friendlyTime("2026-10-21 14:00-14:30"), "wed oct 21 2-2:30pm");
    assert.equal(friendlyTime("2026-10-22 09:30-10:00"), "thu oct 22 9:30-10am");
    assert.equal(friendlyTime("2026-10-26 11:30-12:00"), "mon oct 26 11:30am-12pm");
    assert.equal(friendlyTime("next tuesday afternoon"), "next tuesday afternoon");
  });
});

describe("voice: follow-up writer bubbles", () => {
  test("lead-in, the email whole, its subject, then next steps; max 5; no Subject: label", () => {
    const out = followUpBubbles(FOLLOW_UP, "tim");
    checkShape(out, [EMAIL.body]);
    assert.equal(out.length, 5);
    assert.equal(out[0], "here's the email for tim, copy and tweak ✍️");
    assert.equal(out[1], EMAIL.body, "the email is one bubble, kept intact with its line breaks");
    assert.equal(out[2], "subject line is Following up on Seer from LA Hacks");
    assert.equal(out[3], "email Tim about Seer tonight with the demo video");
    assert.equal(out[4], "apply to Sentry's summer internship and mention the conversation");
    assert.ok(out.every((b) => !/^Subject:/.test(b)));
  });
  test("no first name, no steps: still a lead-in and the email, and the offer of the short text", () => {
    const out = followUpBubbles({ email: EMAIL, message: "hi", nextSteps: [] }, "");
    assert.equal(out[0], "here's the email, copy and tweak ✍️");
    assert.equal(out[1], EMAIL.body);
    assert.equal(out.at(-1), "want the short text version instead? just say text");
    checkShape(out, [EMAIL.body]);
  });
  test("a long next step is split at a sentence end, never truncated mid-word, and the cap still holds", () => {
    const long = "Email Tim about Seer tonight and attach the Cue demo video he asked for, then apply to the Sentry summer internship and mention the conversation in the application.";
    const out = followUpBubbles({ email: EMAIL, nextSteps: [long, long, long] }, "tim");
    assert.equal(out.length, MAX_BUBBLES);
    checkShape(out, [EMAIL.body]);
  });
});

describe("voice: meeting scheduler bubbles", () => {
  test("times on one line in human form, the hold, and how to get the message; no list, no label", () => {
    const out = scheduleBubbles(SCHEDULE, "Tim");
    checkShape(out);
    assert.deepEqual(out, [
      "three times you could meet tim 📅",
      "wed oct 21 2-2:30pm, thu oct 22 3-3:30pm, mon oct 26 2-2:30pm",
      "i put a tentative hold on your calendar for the first one",
      "https://calendar.google.com/event?eid=abc123",
      "say book and i'll give you the message to send tim",
    ]);
    assert.ok(!out.includes(SCHEDULE.schedulingMessage), "the message to paste comes on 'book', not in the proactive text");
  });
  test("no link, two times, unknown name", () => {
    const out = scheduleBubbles({ proposedTimes: SCHEDULE.proposedTimes.slice(0, 2), schedulingMessage: "x", eventLink: null }, "");
    checkShape(out);
    assert.equal(out[0], "two times you could meet them 📅");
    assert.equal(out.length, 3);
  });
  test("book: the scheduling message whole, ready to paste", () => {
    const out = bookBubbles(SCHEDULE, "tim");
    checkShape(out, [SCHEDULE.schedulingMessage]);
    assert.equal(out[0], "here's what to send tim, copy and tweak");
    assert.equal(out[1], SCHEDULE.schedulingMessage);
    assert.equal(out[3], SCHEDULE.eventLink);
  });
});

describe("voice: networking coach bubbles", () => {
  test("the cooked run becomes: the answer, who to chase and why, what to do, next time; the 'maps to your goal' sentence is gone", () => {
    const out = coachBubbles(COOKED_COACH);
    checkShape(out);
    assert.equal(out.length, 5);
    assert.ok(out.includes("tim is the one to chase: he asked for the demo video and said they are hiring"), out.join("\n"));
    assert.ok(out.includes("send the email tonight, lead with the video"), out.join("\n"));
    assert.ok(out.includes("next time, before you leave, ask what the next step is"), out.join("\n"));
    assert.ok(!out.some((b) => /maps straight to your internship goal/.test(b)));
    assert.ok(!out.some((b) => /^coach/.test(b)));
  });
  test("already in voice: summary, chase, action, next time, one pattern", () => {
    const out = coachBubbles({
      summary: "solid day, three real conversations and one hot lead",
      patterns: ["you walked away without a next step twice today"],
      priorities: [{ name: "Tim Cook", why: "he asked for the demo video and said they're hiring", action: "send it tonight, lead with the video" }],
      coaching: ["ask for a next step before you walk away"],
      nextTime: "ask for a next step before you walk away",
    });
    checkShape(out);
    assert.deepEqual(out, [
      "solid day, three real conversations and one hot lead",
      "tim is the one to chase: he asked for the demo video and said they're hiring",
      "send it tonight, lead with the video",
      "next time, ask for a next step before you walk away",
      "you walked away without a next step twice today",
    ]);
  });
  test("empty day: just the summary; a summary longer than two lines is cut to two", () => {
    assert.deepEqual(coachBubbles({ summary: "nobody yet today, go meet someone and i'll keep score" }), ["nobody yet today, go meet someone and i'll keep score"]);
    const out = coachBubbles({ summary: Array(6).fill("this is a sentence that is long enough to need its own bubble on the phone.").join(" ") });
    assert.equal(out.length, 2);
    checkShape(out);
  });
});

describe("voice: wired into the texts", () => {
  const brief = (personId: string): Brief => ({
    id: "b_book", version: 1, eventId: "ev-voice", transcript: "Tim Cook, Sentry",
    query: { name: "Tim Cook", org: "Sentry", role: "co-founder" },
    match: { personId, confidence: "high", candidates: [] },
    cards: [{ kind: "connect", title: "Ask about Seer", body: "x", source: null }],
    slowPath: { status: "none" }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  beforeEach(() => { store.briefs.clear(); });

  test("'book' reply uses the voice", async () => {
    assert.equal(await handleReply("book", null), "nothing to book yet. meet someone and debrief first");
    store.putPerson({ id: "p_voice", eventId: "ev-voice", orgId: "sentry", name: "Tim Cook", facts: [], match: "high", matchReason: "test",
      followUp: { schedule: SCHEDULE } });
    const b = brief("p_voice");
    store.briefs.set(b.id, b);
    const out = (await handleReply("book", b.id)) as string[];
    assert.deepEqual(out, bookBubbles(SCHEDULE, "tim"));
    assert.equal(out[0], "here's what to send tim, copy and tweak");
  });

  test("creao.ts texts through voice.ts; the prose fallback is unchanged", () => {
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/creao.ts"), "utf8");
    assert.match(src, /sendText\(followUpBubbles\(/);
    assert.match(src, /sendText\(scheduleBubbles\(/);
    assert.match(src, /sendText\(coachBubbles\(/);
    assert.match(src, /sendText\(\[`\$\{label\} \(no structured output this run\)`, prose\.slice\(0, 1500\)\]\)/);
    assert.doesNotMatch(src, /`Subject: \$\{subject\}`|"full follow-up from CREAO is ready|`coach 🧠|patterns:\\n/);
  });
});
