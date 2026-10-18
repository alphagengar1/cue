// Replies to the wearer's iMessages after a recap (design/photon-notes.md). Haiku writes the
// conversational parts (compose.ts); the functions here are the plain templates it falls back to,
// plus the pure "who did I meet" list. Only ever addressed to the wearer.
import type { Brief } from "../../shared/types.js";
import { startCoach } from "./coach.js";
import { composeAnswer, composeEmail, composeEventAnswer, extractEvent } from "./compose.js";
import { creaoEnabled } from "./creao.js";
import { createEvent } from "./events.js";
import { suggestFollowUp } from "./photon.js";
import { bookBubbles, holdMovedBubbles } from "./voice.js";
import { moveHold, pickSlot } from "./calendar.js";
import { handleSay } from "./say.js";
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

/**
 * Is the CREAO Follow-up agent's output ready for this brief? Returns a line to text when it is not
 * (still running, or no agent connected). Returns null when it is ready, or when the run failed, so
 * the caller falls back to the fast writer. This is what makes CREAO central, not an add-on.
 */
export function followUpGate(brief: Brief): string | null {
  // The brief's own run first: a re-debrief sets it back to pending, so an older draft never answers for a newer conversation.
  if (brief.followUp?.status === "pending") return "still writing it, give me a minute ✍️";
  if (store.followUpFor(brief)?.email) return null; // ready: this run, an earlier conversation, or a hand-loaded file
  if (!creaoEnabled("follow_up_writer")) return "the follow-up agent isn't connected, so there's no draft. connect it on agent.creao.ai and debrief again";
  if (!brief.debrief) return "no debrief yet for this person, so nothing to draft. hold the temple and say what happened";
  return null; // the run failed, or never started (restart, rate-limit pause): the fast writer covers
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

  // "hey, I'm going to LA Hacks tomorrow": create the event and start the Research agent on it.
  if (/\b(going to|heading to|headed to|attending|i'?ll be at|i'?m at|i am at)\b/.test(t) && !/^\s*(look ?up|prep|brief me|who is|who's)\b/.test(t)) {
    const ev = await extractEvent(text);
    if (ev) {
      const event = await createEvent({ name: ev.name, date: ev.date || new Date().toISOString().slice(0, 10), orgs: ev.orgs, sourceText: text }, { via: "imessage" });
      if (event.loadStatus === "loading") return `on it 👀 building your ${ev.name} pack: who's there, what they're focused on, who's hiring. couple of minutes`;
      return `got it, ${ev.name} is set${ev.orgs.length ? ` with ${ev.orgs.join(", ")}` : ""}. say "look up <name>, <company>" and i'll prep you (the research agent isn't connected, so i can't find the sponsor list myself)`;
    }
  }
  // Pre-event prep by text: "look up Tim Cook, Sentry" / "prep me for Priya Shah, Anduril" / "who is X at Y".
  const prep = /^\s*(look ?up|prep( me)?( for)?|brief me on|who is|who's)\s+(.+)$/i.exec(text.trim());
  if (prep) {
    let out;
    try { out = await handleSay(prep[4]); }
    catch (err) { return `couldn't look that up (${err instanceof Error ? err.message : String(err)}). load an event on the setup page first`; }
    const b = out.response.brief;
    if (out.response.intent !== "lookup" || !b) return out.response.say ?? "couldn't find a name and company in that. try: look up <name>, <company>";
    const who = [b.query.name, b.query.role, b.query.org].filter(Boolean).join(", ");
    return [
      `prep for ${who}${b.match.confidence === "low" ? " (nothing public found, so just the company)" : ""}`,
      ...b.cards.map((c) => `${c.title}: ${c.body.replace(/\s*\n\s*/g, " ")}${c.source ? ` (${c.source})` : ""}`),
    ];
  }
  if (/\b(who|met|today|everyone|list)\b/.test(t) && !/\b(at the event|is there|attending|should i)\b/.test(t)) {
    const briefs = metToday(now);
    if (!briefs.length) return "No one yet today. Hold a temple and say a name, company, role.";
    const lines = briefs.map((b) => {
      const who = [b.query.name, b.query.role, b.query.org].filter(Boolean).join(", ");
      const c = b.cards.find((x) => x.kind === "connect") ?? b.cards[0];
      return `${who}${c ? ` (${LABEL[c.kind] ?? c.kind}: ${c.title})` : ""}`;
    });
    return `Today (${briefs.length}):\n${lines.join("\n")}`;
  }
  // Event questions before anything is on file ("who should I talk to at the event?", "what is Sentry hiring for?").
  if (/\b(at the event|at the fair|is there|attending|who'?s (there|coming|here)|hiring for|should i talk to|who to talk to|prep me)\b/.test(t)) {
    return composeEventAnswer(text);
  }
  if (/\b(how (did|am|was) i|who should i (follow|email|contact|chase)|coach|patterns|how did today)\b/.test(t)) {
    const id = await startCoach(text, "text");
    return id ? "on it 🧠 looking at your whole day, give me about a minute" : "the coach isn't set up yet";
  }
  if (/^\s*(book|times?)\b/.test(t)) {
    const sched = last ? store.followUpFor(last)?.schedule : undefined;
    if (!sched) {
      if (!last) return "nothing to book yet. meet someone and debrief first";
      if (last.followUp?.status === "pending") return "still working out times, give me a minute 📅";
      if (!creaoEnabled("follow_up_writer")) return "the follow-up agent isn't connected, so there are no times. connect it on agent.creao.ai and debrief again";
      return last.debrief ? "no times for this one, the agent didn't propose any. say \"email\" for the draft" : "nothing to book yet. hold the temple and say what happened first";
    }
    const first = firstName(last!.query.name);
    // "book 2" / "book thu": move the tentative hold to that time (calendar.ts), then hand over the message.
    const pick = pickSlot(t, sched.proposedTimes);
    if (pick) {
      const r = await moveHold(sched, pick);
      if (!r.moved) return [`couldn't move the hold, ${r.reason}`, ...bookBubbles(sched, first)].slice(0, 5);
      const person = store.personFor(last!);
      if (person) store.putPerson({ ...person, followUp: { ...(person.followUp ?? {}), schedule: r.schedule } });
      if (last!.followUp) store.briefs.set(last!.id, { ...last!, followUp: { ...last!.followUp, schedule: r.schedule } });
      return holdMovedBubbles(r.schedule, first);
    }
    return bookBubbles(sched, first);
  }
  if (/\b(email|mail|draft)\b/.test(t)) {
    if (!last) return "No recap yet, so nothing to draft. Meet someone first.";
    // The CREAO Follow-up agent writes the follow-up. Haiku steps in only when its run actually failed.
    // "email, what should I lead with?": the second half is answered whether or not the draft is ready.
    const rest = t.replace(/\b(email|mail|draft|me|an?|the|please|pls)\b/g, " ").replace(/[^a-z' ]/g, " ").trim();
    const askedMore = rest.split(/\s+/).filter(Boolean).length >= 3;
    const gate = followUpGate(last);
    const bubbles: string[] = [];
    if (gate) bubbles.push(gate);
    else { const { subject, body } = await composeEmail(last); bubbles.push(`Subject: ${subject}`, body); }
    if (askedMore) bubbles.push(...(await composeAnswer(rest, last)).split("\n"));
    return bubbles.length === 1 ? bubbles[0] : bubbles;
  }
  if (/^(help|hi|hello|hey|yo|\?|what can you do)\b/.test(t) || t.length < 3) return HELP;
  return composeAnswer(text, last);
}
