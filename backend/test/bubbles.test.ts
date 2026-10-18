import "./_env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_SEND_BUBBLES, foldBubbles } from "../src/photon.js";
import { RECAP_BUBBLES, splitBubbles } from "../src/compose.js";
import { SHORT_BUBBLES, bookBubbles, coachBubbles, followUpBubbles, holdMovedBubbles, scheduleBubbles } from "../src/voice.js";

const src = (f: string) => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src", f), "utf8");

describe("every outbound iMessage is at most three bubbles", () => {
  test("foldBubbles: up to three pass through, the rest fold into the third on their own lines", () => {
    assert.equal(MAX_SEND_BUBBLES, 3);
    assert.deepEqual(foldBubbles([]), []);
    assert.deepEqual(foldBubbles(["a"]), ["a"]);
    assert.deepEqual(foldBubbles(["a", "b", "c"]), ["a", "b", "c"]);
    assert.deepEqual(foldBubbles(["a", "b", "c", "d", "e"]), ["a", "b", "c\nd\ne"]);
    assert.deepEqual(foldBubbles(["a", "", "  ", "b", "c", "d"]), ["a", "b", "c\nd"], "empty bubbles never count");
  });
  test("foldBubbles keeps the email's own line breaks and stays under 1500 characters", () => {
    const email = "Hi Tim,\n\nThanks for the chat.\n\nBest,\nSam";
    const out = foldBubbles(["here's the email", email, "subject line is Seer", "next: send it tonight", "say text for the short one"]);
    assert.equal(out.length, 3);
    assert.equal(out[1], email);
    assert.equal(out[2], "subject line is Seer\nnext: send it tonight\nsay text for the short one");
    const long = foldBubbles(["a", "b", ...Array(20).fill("x".repeat(100))]);
    assert.equal(long.length, 3);
    assert.ok(long[2].length <= 1500, `${long[2].length} chars`);
    assert.ok(long[2].endsWith("…"));
  });
  test("sendText, sendRecap and the reply listener all go through foldBubbles; nothing sends raw", () => {
    const s = src("photon.ts");
    assert.equal((s.match(/foldBubbles\(/g) ?? []).length, 4, "the definition and three call sites");
    assert.doesNotMatch(s, /send\(clipText\(/);
  });
  test("the producers fit without folding: recap, coach, book, and the event-pack text", () => {
    assert.equal(RECAP_BUBBLES, 3);
    assert.equal(SHORT_BUBBLES, 3);
    assert.equal(splitBubbles(["a", "b", "c", "d", "e"], 140, RECAP_BUBBLES).length, 3);
    assert.match(src("compose.ts"), /splitBubbles\(out\.bubbles\.map\(clean\), BUBBLE_MAX, RECAP_BUBBLES\)/);
    assert.match(src("compose.ts"), /Never more than 3 bubbles/);
    const coach = coachBubbles({
      summary: "x ".repeat(200), patterns: ["p1", "p2"], coaching: ["c1", "c2"], nextTime: "ask for a next step",
      priorities: [{ name: "Tim Cook", why: "why", action: "do it" }, { name: "Alex Kim", action: "dm him" }],
    });
    assert.ok(coach.length <= 3, coach.join(" | "));
    assert.ok(bookBubbles({ proposedTimes: [], schedulingMessage: "m", eventLink: "https://x.test/e" }, "tim").length <= 3);
    // notifyEventReady: headline, the answer lines kept together, how to use it
    const creao = src("creao.ts");
    assert.match(creao, /const lines = answer\.split\("\\n"\)\.filter\(Boolean\)\.slice\(0, 3\)\.join\("\\n"\);/);
    assert.match(creao, /sendText\(\[`your \$\{ev\.name\} pack is ready: \$\{orgs\.length\} orgs`, \.\.\.\(lines \? \[lines\] : \[\]\), "say/);
  });
  test("longer producers still arrive as three bubbles once folded", () => {
    const schedule = { proposedTimes: ["2026-10-21 14:00-14:30", "2026-10-22 15:00-15:30"], schedulingMessage: "Hi Tim, Wed or Thu? Sam", eventLink: "https://calendar.google.com/event?eid=abc" };
    const followUp = { email: { subject: "Seer", body: "Hi Tim,\n\nThanks.\n\nBest,\nSam" }, message: "hi", nextSteps: ["email tim tonight", "apply this week"] };
    for (const bubbles of [followUpBubbles(followUp, "tim"), scheduleBubbles(schedule, "tim"), holdMovedBubbles(schedule, "tim")]) {
      const folded = foldBubbles(bubbles);
      assert.equal(folded.length, Math.min(3, bubbles.length));
      assert.equal(folded.join("\n"), bubbles.join("\n"), "folding drops nothing, it only regroups");
    }
  });
});
