// Texting voice for the CREAO agents' output (agents/voice.md). Pure functions: each takes the parsed,
// sanitized JSON an apply function in creao.ts already has and returns the bubbles Photon sends.
// Shape rules: one thought per bubble, under 100 characters, lowercase casual, no labels, no lists,
// at most 5 bubbles. The email and the scheduling message are the two things the wearer copies, so
// they are kept whole (one bubble each, never split).
import { splitBubbles } from "./compose.js";

export const LINE_MAX = 100;
export const MAX_BUBBLES = 5;

export interface FollowUpVoiceInput {
  email: { subject: string; body: string };
  message?: string;
  nextSteps?: string[];
}
export interface ScheduleVoiceInput {
  proposedTimes: string[];
  schedulingMessage: string;
  eventLink?: string | null;
}
export interface CoachVoiceInput {
  summary: string;
  patterns?: string[];
  priorities?: { name: string; why?: string; action?: string }[];
  coaching?: string[];
  nextTime?: string;
}

/** "David Cramer" -> "david"; undefined -> "". */
export const firstName = (name: string | undefined | null): string =>
  (name ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";

/**
 * One line in Cue's voice: markdown and list markers gone, one space between words, first letter
 * lowercased (acronyms kept), no trailing period. Does not touch the rest of the sentence.
 */
export function casual(s: string): string {
  let t = s
    .replace(/[*_`>#]+/g, "")
    .replace(/^\s*(?:[-•]|\d+[.)])\s+/, "")
    .replace(/^\s*(?:patterns?|priorit(?:y|ies)|coaching|next time|next steps?|summary|subject|action)\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  t = t.replace(/^([A-Z])(?=[a-z])/, (c) => c.toLowerCase());
  t = t.replace(/([^.])\.$/, "$1");
  return t;
}

/** Lines through casual() and splitBubbles at LINE_MAX, dropping empties; not yet capped. */
const lines = (xs: (string | undefined | null)[]): string[] =>
  splitBubbles(xs.map((x) => casual(x ?? "")).filter(Boolean), LINE_MAX, Number.MAX_SAFE_INTEGER)
    .map((b) => b.replace(/[,;]$/, "")); // a split at ", " leaves the comma on the first half

/** Mix of split lines and whole bubbles (email, scheduling message), capped at MAX_BUBBLES. */
const cap = (parts: ({ line: string } | { whole: string })[]): string[] => {
  const out: string[] = [];
  for (const p of parts) {
    if ("whole" in p) { if (p.whole.trim()) out.push(p.whole.trim()); }
    else out.push(...lines([p.line]));
  }
  return out.slice(0, MAX_BUBBLES);
};

/** Follow-up Writer: a lead-in, the email whole, its subject, then the first next steps. */
export function followUpBubbles(followUp: FollowUpVoiceInput, first: string): string[] {
  const who = first ? ` for ${first.toLowerCase()}` : "";
  const subject = followUp.email.subject.replace(/^\s*(re|subject)\s*:\s*/i, "").trim();
  const steps = (followUp.nextSteps ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 2);
  return cap([
    { line: `here's the email${who}, copy and tweak ✍️` },
    { whole: followUp.email.body },
    ...(subject ? [{ line: `subject line is ${subject}` }] : []),
    ...steps.map((s) => ({ line: s })),
    ...(followUp.message?.trim() ? [{ line: "want the short text version instead? just say text" }] : []),
  ]);
}

/**
 * One compact wave for the merged Follow-up agent (email + times in one run): lead-in, the email
 * whole, next steps on one line, the times and the hold on one line. At most 3 bubbles, so a
 * conversation costs the wearer 4 texts in total (one Haiku recap + these), not 17.
 */
export function followUpWave(followUp: FollowUpVoiceInput, schedule: ScheduleVoiceInput | undefined, first: string): string[] {
  const who = first ? first.toLowerCase() : "them";
  const steps = (followUp.nextSteps ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 2);
  const times = (schedule?.proposedTimes ?? []).map((t) => t.trim()).filter(Boolean).slice(0, 3);
  const timesLine = times.length
    ? `times for ${who}: ${times.map(friendlyTime).join(", ")}${schedule?.eventLink ? " · hold's on your calendar" : ""} · say book for the message`
    : (followUp.message?.trim() ? "say text for the short version" : "");
  return cap([
    { whole: followUp.email.body },
    ...(steps.length ? [{ line: `next: ${steps.join("; ")}` }] : []),
    ...(timesLine ? [{ whole: timesLine }] : []), // one bubble even when it runs past 100 chars
  ]).slice(0, 3);
}

const DAY = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTH = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const clock = (h: number, m: number): string => {
  const suffix = h >= 12 ? "pm" : "am";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return m ? `${hh}:${String(m).padStart(2, "0")}${suffix}` : `${hh}${suffix}`;
};
/** "2026-10-21 14:00-14:30" -> "wed oct 21 2-2:30pm". Anything else is passed through. */
export function friendlyTime(slot: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(slot.trim());
  if (!m) return slot.trim();
  const [, y, mo, d, h1, m1, h2, m2] = m.map(Number);
  const day = DAY[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
  const start = clock(h1, m1), end = clock(h2, m2);
  const sameHalf = start.slice(-2) === end.slice(-2);
  return `${day} ${MONTH[mo - 1]} ${d} ${sameHalf ? start.slice(0, -2) : start}-${end}`;
}

const COUNT = ["no", "one", "two", "three", "four", "five"];

/** Meeting Scheduler: the slots on one line, the hold if there is one, how to get the message. */
export function scheduleBubbles(schedule: ScheduleVoiceInput, first: string): string[] {
  const who = first ? first.toLowerCase() : "them";
  const times = schedule.proposedTimes.map((t) => t.trim()).filter(Boolean).slice(0, 3);
  const n = COUNT[times.length] ?? String(times.length);
  return cap([
    { line: times.length ? `${n} times you could meet ${who} 📅` : `a scheduling message for ${who} is ready 📅` },
    ...(times.length ? [{ line: times.map(friendlyTime).join(", ") }] : []),
    ...(schedule.eventLink ? [{ line: "i put a tentative hold on your calendar for the first one" }, { whole: schedule.eventLink }] : []),
    { line: `say book and i'll give you the message to send ${who}` },
  ]);
}

/** The "book" reply: the scheduling message whole, ready to paste. */
export function bookBubbles(schedule: ScheduleVoiceInput, first: string): string[] {
  const who = first ? first.toLowerCase() : "them";
  return cap([
    { line: `here's what to send ${who}, copy and tweak` },
    { whole: schedule.schedulingMessage },
    ...(schedule.eventLink ? [{ line: "your tentative hold is still on your calendar" }, { whole: schedule.eventLink }] : []),
  ]);
}

/** "book 2": the hold moved, then the message to send. */
export function holdMovedBubbles(schedule: ScheduleVoiceInput, first: string): string[] {
  const who = first ? first.toLowerCase() : "them";
  return cap([
    { line: `moved your hold to ${friendlyTime(schedule.proposedTimes[0] ?? "")} 📅` },
    ...(schedule.eventLink ? [{ whole: schedule.eventLink }] : []),
    { line: `here's what to send ${who}, copy and tweak` },
    { whole: schedule.schedulingMessage },
  ]);
}

/** Networking Coach: the answer, who to chase (why, then what to do), the line for next time, one pattern. */
export function coachBubbles(coaching: CoachVoiceInput): string[] {
  const summary = lines([coaching.summary]).slice(0, 2);
  const [p1, p2] = (coaching.priorities ?? []).filter((p) => p.name.trim());
  const why1 = casual(p1?.why ?? ""), action1 = casual(p1?.action ?? "");
  const next = coaching.nextTime?.trim() || coaching.coaching?.[0]?.trim() || "";
  const extra = coaching.nextTime?.trim() ? coaching.coaching?.[0]?.trim() : coaching.coaching?.[1]?.trim();
  const pattern = coaching.patterns?.[0]?.trim();
  const action2 = casual(p2?.action ?? p2?.why ?? "");
  return cap([
    ...summary.map((line) => ({ line })),
    // "david is the one to chase: he asked for the demo video" then "send it tonight, lead with the video"
    ...(p1 ? [{ line: why1 ? `${firstName(p1.name)} is the one to chase: ${why1}` : `${firstName(p1.name)} is the one to chase` }] : []),
    ...(action1 ? [{ line: action1 }] : []),
    ...(next ? [{ line: `next time, ${casual(next)}` }] : []),
    ...(pattern ? [{ line: pattern }] : []),
    ...(p2 && action2 ? [{ line: `then ${firstName(p2.name)}: ${action2}` }] : []),
    ...(extra ? [{ line: `also, ${casual(extra)}` }] : []),
  ]);
}
