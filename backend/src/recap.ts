// Replies to the wearer's iMessages after a recap (design/photon-notes.md). Haiku writes the
// conversational parts (compose.ts); the functions here are the plain templates it falls back to,
// plus the pure "who did I meet" list. Only ever addressed to the wearer.
import type { Brief } from "../../shared/types.js";
import { startCoach } from "./coach.js";
import { composeAnswer, composeEmail } from "./compose.js";
import { suggestFollowUp } from "./photon.js";
import { bookBubbles, holdMovedBubbles } from "./voice.js";
import { moveHold, pickSlot } from "./calendar.js";
import { store } from "./store.js";

const LABEL: Record<string, string> = { connect: "Connect", context: "Context", angle: "Ask" };
const firstName = (s: string): string => s.trim().split(/\s+/)[0] || "there";
const sameDay = (iso: string, now: Date): boolean => {
  const d = new Date(iso);
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
};

/** Briefs created today, newest first, one per person (later brief wins). */
export function metToday(now = new Date()): Brief[] {
  const seen = new Set<string>();
  const out: Brief[] = [];
  const all = [...store.briefs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const b of all) {
    if (!sameDay(b.createdAt, now) || !b.cards.length) continue;
    const key = `${b.query.name}|${b.query.org}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(b);
  }
  return out;
}

/** Template follow-up email (fallback when the LLM is unavailable). */
export function draftEmail(brief: Brief): string {
  const q = brief.query;
  const event = (store.events.get(brief.eventId)?.name ?? "the event").replace(/\s*\([^)]*\)\s*$/, "");
  const me = store.profile.name || "a student";
  const school = store.profile.school ? ` at ${store.profile.school}` : "";
  const angle = brief.cards.find((c) => c.kind === "angle");
  const note = brief.debrief ? ` ${brief.debrief.trim().replace(/[.!?]?$/, ".")}` : "";
  const ask = angle ? ` ${angle.body.replace(/\s+/g, " ").trim()}` : "";
  return [
    `Subject: Great meeting you at ${event}`,
    "",
    `Hi ${firstName(q.name)},`,
    "",
    `Thanks for taking the time to talk at ${event} today.${note}${ask}`,
    "",
    "Would you be open to a 15-minute call sometime next week? Happy to work around your schedule.",
    "",
    `Best,\n${me}${school}`,
  ].join("\n");
}

/** Template short follow-up text (fallback). */
export function suggestText(brief: Brief): string {
  return `Follow-up for ${brief.query.name}:\n"${suggestFollowUp(brief)}"`;
}

const HELP = [
  "I can do a few things:",
  "- say \"email\" for a follow-up email draft",
  "- say \"text\" for a short message to send them",
  "- say \"book\" for the meeting message, or \"book 2\" to move the calendar hold",
  "- say \"who did I meet\" for today's list",
  "- or just ask me something about them",
].join("\n");

/**
 * Turn an inbound text from the wearer into a reply (one string or several bubbles).
 * `lastBriefId` is the brief of the most recent recap. Returns null for nothing to say.
 */
export async function handleReply(text: string, lastBriefId: string | null, now = new Date()): Promise<string | string[] | null> {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  const last = lastBriefId ? store.briefs.get(lastBriefId) ?? null : null;

  if (/\b(who|met|today|everyone|list)\b/.test(t)) {
    const briefs = metToday(now);
    if (!briefs.length) return "No one yet today. Hold a temple and say a name, company, role.";
    const lines = briefs.map((b) => {
      const who = [b.query.name, b.query.role, b.query.org].filter(Boolean).join(", ");
      const c = b.cards.find((x) => x.kind === "connect") ?? b.cards[0];
      return `${who}${c ? ` (${LABEL[c.kind] ?? c.kind}: ${c.title})` : ""}`;
    });
    return `Today (${briefs.length}):\n${lines.join("\n")}`;
  }
  if (/\b(how (did|am|was) i|who should i|coach|patterns|how did today)\b/.test(t)) {
    const id = await startCoach(text, "text");
    return id ? "on it 🧠 looking at your whole day, give me about a minute" : "the coach isn't set up yet";
  }
  if (/^\s*book\b/.test(t)) {
    const person = last?.match.personId ? store.people.get(last.match.personId) : undefined;
    const sched = person?.followUp?.schedule;
    if (!sched) return "nothing to book yet. meet someone and debrief first";
    const first = firstName(last!.query.name);
    // "book 2" / "book thu": move the tentative hold to that time (calendar.ts), then hand over the message.
    const pick = pickSlot(t, sched.proposedTimes);
    if (pick) {
      const r = await moveHold(sched, pick);
      if (!r.moved) return [`couldn't move the hold, ${r.reason}`, ...bookBubbles(sched, first)].slice(0, 5);
      store.putPerson({ ...person!, followUp: { ...(person!.followUp ?? {}), schedule: r.schedule } });
      return holdMovedBubbles(r.schedule, first);
    }
    return bookBubbles(sched, first);
  }
  if (/\b(email|mail|draft)\b/.test(t)) {
    if (!last) return "No recap yet, so nothing to draft. Meet someone first.";
    const { subject, body } = await composeEmail(last);
    const bubbles = [`Subject: ${subject}`, body];
    // "email, what should I lead with?": answer the rest too.
    const rest = t.replace(/\b(email|mail|draft|me|an?|the|please|pls)\b/g, " ").replace(/[^a-z' ]/g, " ").trim();
    if (rest.split(/\s+/).filter(Boolean).length >= 3) bubbles.push(...(await composeAnswer(rest, last)).split("\n"));
    return bubbles;
  }
  if (/^(help|hi|hello|hey|yo|\?|what can you do)\b/.test(t) || t.length < 3) return HELP;
  return composeAnswer(text, last);
}
