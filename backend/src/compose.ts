// Texting voice for the Photon follow-up (design/photon-notes.md). Haiku writes what Cue texts the
// wearer: a short recap in 2-3 iMessage bubbles, a follow-up email with real line breaks, and
// answers to free-form questions about the person. Off the live path, so it can take a few seconds.
// Every function falls back to the plain templates in recap.ts / photon.ts when the LLM is
// unavailable, so a missing key or a timeout never blocks a text.
import { z } from "zod";
import type { Brief, Fact } from "../../shared/types.js";
import { LlmUnavailable, parseWithModel } from "./llm.js";
import { formatRecap } from "./photon.js";
import { draftEmail, suggestText } from "./recap.js";
import { store } from "./store.js";

const SYSTEM = `You are Cue, texting a student on iMessage right after they met someone at an in-person event. You were the quiet voice in their smart glasses; now you are the sharp friend who was listening.

Voice: the way a close friend texts. Each bubble is ONE thought, one line, usually under 100 characters. Casual lowercase is fine, spelling correct. No labels ("Connect:", "Sources:"), no lists, no markdown, no hashtags. An emoji now and then is good, at most one per bubble, never in the email. First name after the first mention. Write to the wearer as "you". Never pad; if there is nothing more to say, stop.

Example recap bubbles (shape and length, not content to copy):
"just met david cramer, sentry cofounder"
"big one 👀 they're hiring summer interns, he said email him about seer"
"he also wants the cue demo video, put that in the email"
"want a draft? just say email ✍️"

Rules:
- Use ONLY the facts, cards and debrief in the input. Never invent details, titles, dates or quotes.
- Nothing private: no family, location, health, politics, age, appearance.
- Never write the raw card titles as if they were topics (not "keep talking about Ask about Seer"). Say what the thing is.
- Keep the event name short (for example "LA Hacks", not the full official title).
- If creaoFollowUp is present it was written earlier by the CREAO Follow-up Writer for this person: keep its substance and specifics, update it with the debrief, and shorten it to the format asked for.
- Say what to do, not what you observed ("send it tonight, lead with the video", not "this maps to your internship goal"). Never more than 5 bubbles. Style guide: agents/voice.md.`;

const RecapOut = z.object({ bubbles: z.array(z.string()) });
const EmailOut = z.object({ subject: z.string(), body: z.string() });
const AnswerOut = z.object({ text: z.string() });

const shortEvent = (name: string | undefined): string =>
  (name ?? "the event").replace(/\s*\([^)]*\)\s*$/, "").replace(/\s+(Fall|Spring|Summer|Winter)\s+\d{4}$/i, "").trim() || "the event";

const context = (brief: Brief, debrief?: string) => {
  const person = brief.match.personId ? store.people.get(brief.match.personId) : undefined;
  const org = person ? store.orgs.get(`${brief.eventId}:${person.orgId}`) ?? null : null;
  const p = store.profile;
  const facts: Fact[] = person?.facts ?? [];
  return {
    person: { name: brief.query.name, role: brief.query.role, org: brief.query.org, headline: person?.headline },
    facts: facts.map((f) => ({ text: f.text, source: f.sourceUrl, date: f.date })),
    cards: brief.cards.map((c) => ({ kind: c.kind, title: c.title, body: c.body.replace(/\n/g, " ") })),
    org: org ? { name: org.name, oneLiner: org.oneLiner, hiring: org.hiring } : null,
    event: shortEvent(store.events.get(brief.eventId)?.name),
    wearer: { name: p.name, school: p.school, goal: p.goal, goalNote: p.goalNote, summary: p.summary },
    debrief: debrief ?? brief.debrief ?? "",
    // Hand-run CREAO Follow-up Writer output, when the demo person has one: the base to adapt, not to copy.
    creaoFollowUp: person?.followUp?.email || person?.followUp?.message
      ? { email: person.followUp.email, message: person.followUp.message, nextSteps: person.followUp.nextSteps }
      : undefined,
  };
};

/** Texting shape: at most 5 bubbles, each under BUBBLE_MAX chars; long ones split at sentence ends. */
const BUBBLE_MAX = 140;
export function splitBubbles(bubbles: string[], max = BUBBLE_MAX, limit = 5): string[] {
  const out: string[] = [];
  for (const raw of bubbles) {
    let b = raw.replace(/\s+/g, " ").trim();
    while (b.length > max) {
      const cut = Math.max(b.lastIndexOf(". ", max), b.lastIndexOf("! ", max), b.lastIndexOf("? ", max), b.lastIndexOf(", ", max));
      const at = cut >= 30 ? cut + 1 : b.lastIndexOf(" ", max);
      if (at <= 0) break;
      out.push(b.slice(0, at).trim());
      b = b.slice(at).trim();
    }
    if (b) out.push(b);
  }
  return out.filter(Boolean).slice(0, limit);
}

const clean = (s: string): string => s.replace(/[*_#`>]+/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

/** 2-3 short bubbles. Falls back to the one-bubble template recap. */
export async function composeRecap(brief: Brief, debrief?: string): Promise<string[]> {
  try {
    const out = await parseWithModel(SYSTEM, {
      task: "recap",
      format: "Return bubbles: 3 to 5 strings, each ONE line under 100 characters. " +
        "First: who you just met (first and last name, role, org). " +
        "Then one bubble per thing worth remembering, most useful first: what they said they wanted (debrief first), then one hook from the facts. " +
        "Last: a short offer ending with: just say email. No sources, no card titles.",
      ...context(brief, debrief),
    }, RecapOut, { maxTokens: 600, timeoutMs: 8000 });
    const bubbles = splitBubbles(out.bubbles.map(clean));
    if (bubbles.length >= 1) return bubbles;
  } catch (err) {
    console.warn(`[compose] recap fell back: ${err instanceof LlmUnavailable ? err.message : String(err)}`);
  }
  return [formatRecap(brief)];
}

/** Follow-up email with real paragraphs. Falls back to the template in recap.ts. */
export async function composeEmail(brief: Brief, debrief?: string): Promise<{ subject: string; body: string }> {
  // The CREAO Follow-up agent is the engine: its email wins whenever it has landed.
  const ready = (brief.match.personId ? store.people.get(brief.match.personId) : undefined)?.followUp?.email;
  if (ready?.subject && ready.body) return ready;
  try {
    const out = await parseWithModel(SYSTEM, {
      task: "email",
      format: "Return subject (under 60 characters, no 'Re:') and body. Body: 60-90 words in 3 short paragraphs separated by one blank line. " +
        "Open 'Hi <first name>,'. Paragraph 1: thanks, name the event, the one specific thing they said (debrief first, then facts). " +
        "Paragraph 2: the one ask, or the thing they asked for (for example the demo video, a 15-minute call, how to apply). " +
        "Paragraph 3: one line sign-off 'Best,' then the wearer's name and school on the next line. " +
        "Plain and specific, normal capitalization, not texting voice. No cover-letter phrases: never 'I would be glad to be considered', " +
        "'I wanted to reach out', 'while the conversation is fresh', 'I am passionate about'.",
      ...context(brief, debrief),
    }, EmailOut, { maxTokens: 700, timeoutMs: 8000 });
    const subject = clean(out.subject).replace(/\n/g, " ").slice(0, 80);
    const body = clean(out.body);
    if (subject && body.length > 40) return { subject, body };
  } catch (err) {
    console.warn(`[compose] email fell back: ${err instanceof LlmUnavailable ? err.message : String(err)}`);
  }
  const pre = (brief.match.personId ? store.people.get(brief.match.personId) : undefined)?.followUp?.email;
  if (pre) return pre; // CREAO Follow-up Writer's email, loaded from the event file
  const t = draftEmail(brief);
  const [subjectLine, ...rest] = t.split("\n");
  return { subject: subjectLine.replace(/^Subject:\s*/, ""), body: rest.join("\n").trim() };
}

/** Answer a free-form text ("what was his talk about?", "write me a short text to send him"). */
export async function composeAnswer(question: string, brief: Brief | null): Promise<string> {
  // "text" -> the CREAO Follow-up agent's message when it has landed.
  const readyMsg = brief?.match.personId ? store.people.get(brief.match.personId)?.followUp?.message : undefined;
  if (brief && readyMsg && /\b(text|message|dm)\b/i.test(question) && !/\b(what|why|how|should)\b/i.test(question)) return `here's one to send ${brief.query.name.split(/\s+/)[0]}:\n${readyMsg}`;
  if (!brief) return "I don't have anyone on file yet. Hold a temple and say a name, company, role, and I'll keep notes.";
  try {
    const out = await parseWithModel(SYSTEM, {
      task: "answer",
      format: "Reply in texting voice: 1 to 3 short lines, under 100 characters each, separated by line breaks (each becomes a bubble). " +
        "Answer only from the input. If the input does not cover it, say so in one line and suggest what they could ask the person directly. " +
        "If they ask for a text or message to send the person, write it ready to copy, in the wearer's voice, under 240 characters, as the last line.",
      question,
      ...context(brief),
    }, AnswerOut, { maxTokens: 400, timeoutMs: 8000 });
    const text = clean(out.text);
    if (text) return splitBubbles(text.split("\n")).join("\n");
  } catch (err) {
    console.warn(`[compose] answer fell back: ${err instanceof LlmUnavailable ? err.message : String(err)}`);
  }
  const pre = (brief.match.personId ? store.people.get(brief.match.personId) : undefined)?.followUp?.message;
  if (/\b(text|message|dm)\b/i.test(question)) return pre ? `Here's one to send ${brief.query.name.split(/\s+/)[0]}:\n${pre}` : suggestText(brief);
  return `I only have what's in the brief for ${brief.query.name}. Say "email" for a draft, or "who did I meet" for today's list.`;
}
