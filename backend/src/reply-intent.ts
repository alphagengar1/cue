// Intent routing for the wearer's iMessages (recap.ts handleReply). The same decision model as the
// spoken path (intent.ts) classifies a text into one of the voice intents plus the texting-only
// ones (email, message, book, who_met, event_announce, event_question, question, help), given
// what the backend knows: the last person, whether the follow-up draft is ready, the event on file.
// The old regex waterfall is the rules fallback and the tie-breaker; bare commands ("email",
// "book 2", "help") skip the model. Nothing here generates text.
import type { Goal, Query, SayIntent } from "../../shared/types.js";
import { config } from "./config.js";
import { askDecisions, type DecisionsOpts, GOAL_CHOICES, goalFromText, pickChoice, rulesIntent } from "./intent.js";

export type ReplyIntent = SayIntent | "email" | "message" | "book" | "who_met" | "event_announce" | "event_question" | "question" | "help";
export const REPLY_INTENTS: ReplyIntent[] = [
  "lookup", "debrief", "correction", "goal", "recap", "coach", "quiet", "unknown",
  "email", "message", "book", "who_met", "event_announce", "event_question", "question", "help",
];

export interface ReplyContext {
  hasBrief: boolean;
  lastQuery?: Query;
  followUp: "none" | "pending" | "ready" | "failed"; // the Follow-up agent's draft for the last person
  hasSchedule: boolean;                                // proposed times exist for the last person
  slots?: string[];                                    // their labels ("Wed 2pm"), for "book 2" / "book thu"
  eventLoaded: boolean;
  eventName?: string;
}
export interface ReplyIntentResult {
  intent: ReplyIntent;
  confidence: number;
  goal?: Goal;
  source: "decisions" | "rules";
  probabilities?: Partial<Record<ReplyIntent, number>>;
}

// ---------------------------------------------------------------------------
// Rules (always available): the former handleReply waterfall, in its original order
// ---------------------------------------------------------------------------

export const LOOKUP_PREFIX = /^\s*(look ?up|prep( me)?( for)?|brief me on|who is|who's)\s+(.+)$/i;
const EVENT_ANNOUNCE = /\b(going to|heading to|headed to|attending|i'?ll be at|i'?m at|i am at)\b/i;
const WHO_MET = /\b(who|met|today|everyone|list)\b/i;
const NOT_WHO_MET = /\b(at the event|is there|attending|should i)\b/i;
const EVENT_Q = /\b(at the event|at the fair|is there|attending|who'?s (there|coming|here)|hiring for|should i talk to|who to talk to|prep me)\b/i;
const COACH = /\b(how (did|am|was) i|who should i (follow|email|contact|chase)|coach|patterns|how did today)\b/i;
const BOOK = /^\s*(book|times?)\b/i;
const EMAIL = /\b(email|mail|draft)\b/i;
const MESSAGE = /^\s*(text|message|dm|sms)\b|\b(short|quick) (text|message)\b|\btext to send\b/i;
const HELP = /^(help|hi|hello|hey|yo|\?|what can you do)\b/i;
// A texted debrief: what the person said or wants, not a question about them.
const DEBRIEF = /\b(he|she|they)\s+(said|told|wants?|mentioned|asked|suggested|offered|liked)\b|\b(just )?(talked|spoke|chatted) (to|with)\b|\bemail (him|her|them) about\b/i;
const QUESTION_START = /^\s*(who|what|how|when|where|why|did|does|do|is|are|can|could|should|would|will)\b/i;

/** Exact commands the wearer types most: route without the model. Null when not a bare command. */
export function bareCommand(text: string): ReplyIntent | null {
  const t = text.trim().toLowerCase().replace(/[.!]+$/, "");
  if (/^(email|mail|draft|draft (me )?(an? )?email|email draft|email pls|email please)$/.test(t)) return "email";
  if (/^(text|message|dm|short text|short message)$/.test(t)) return "message";
  if (/^(book|times?|book \S+|times? \S+)$/.test(t)) return "book";
  if (/^(help|hi|hello|hey|yo|\?|what can you do)$/.test(t)) return "help";
  if (/^(who did i meet( today)?|who have i met( today)?|today'?s list)\??$/.test(t)) return "who_met";
  if (/^(recap|text me the recap|send (me )?the recap)$/.test(t)) return "recap";
  return null;
}

export function rulesReplyIntent(text: string, ctx: ReplyContext): ReplyIntentResult {
  const raw = text.trim();
  const t = raw.toLowerCase();
  const r = (intent: ReplyIntent, confidence: number, goal?: Goal): ReplyIntentResult => ({ intent, confidence, goal, source: "rules" });
  if (!raw) return r("unknown", 1);
  const bare = bareCommand(raw);
  if (bare) return r(bare, 0.95);
  if (EVENT_ANNOUNCE.test(t) && !LOOKUP_PREFIX.test(raw)) return r("event_announce", 0.6);
  if (LOOKUP_PREFIX.test(raw)) return r("lookup", 0.9);
  // Shared spoken intents (quiet, recap, correction, goal) via the voice rules.
  const voice = rulesIntent(raw, { hasBrief: ctx.hasBrief, lastQuery: ctx.lastQuery });
  if (voice.intent === "quiet" || voice.intent === "recap") return r(voice.intent, voice.confidence);
  if (voice.intent === "correction" && ctx.hasBrief) return r("correction", voice.confidence);
  if (voice.intent === "goal" && voice.goal) return r("goal", voice.confidence, voice.goal);
  if (ctx.hasBrief && DEBRIEF.test(t) && !QUESTION_START.test(t)) return r("debrief", 0.65);
  if (WHO_MET.test(t) && !NOT_WHO_MET.test(t)) return r("who_met", 0.6);
  if (EVENT_Q.test(t)) return r("event_question", 0.7);
  if (COACH.test(t)) return r("coach", 0.7);
  if (BOOK.test(t)) return r("book", 0.85);
  if (MESSAGE.test(t) && !QUESTION_START.test(t)) return r("message", 0.7);
  if (EMAIL.test(t)) return r("email", 0.7);
  if (HELP.test(t) || t.length < 3) return r("help", 0.8);
  return r("question", 0.4);
}

// ---------------------------------------------------------------------------
// Decision model
// ---------------------------------------------------------------------------

const CHOICES: { value: ReplyIntent; description: string }[] = [
  { value: "email", description: "Wants the follow-up EMAIL draft for the last person, or asks about that draft, e.g. 'email', 'draft the email', 'send me the email, what should I lead with?'. Not a question about the person's email address." },
  { value: "message", description: "Wants a short TEXT or DM to send the last person (not an email), e.g. 'text', 'write me a short message for him', 'draft a text to send her'." },
  { value: "book", description: "About meeting times or the calendar hold for the last person: see the proposed times, pick or move one, e.g. 'book', 'book 2', 'book thursday', 'move the hold to the 3pm slot', 'what times did you propose'." },
  { value: "who_met", description: "Wants the list of people met today, e.g. 'who did I meet', 'today's list', 'everyone from today'." },
  { value: "event_announce", description: "Tells Cue about an event they are going to or are at, so Cue can prepare, e.g. 'hey I'm going to LA Hacks tomorrow, sponsors are Sentry and Anduril', 'I'm at the UCLA career fair'." },
  { value: "event_question", description: "A question about the event or its companies before or between conversations, e.g. 'who's hiring for interns?', 'who should I talk to at the event?', 'what is Sentry focused on?'." },
  { value: "lookup", description: "Names a person and/or a company to prep for before talking to them, e.g. 'look up Priya Shah, Anduril', 'who is Tim Cook at Sentry', 'prep me for Jordan Lee, Exa'." },
  { value: "debrief", description: "Notes about a conversation that already happened with the last person: what they said, want, offered, what to send them, e.g. 'she said email her about Seer, they're hiring interns', 'just talked to him, he wants the demo video'." },
  { value: "correction", description: "Fixes how the last name or company was heard, e.g. 'it's Priya not Maya', 'Cook with a C', 'wrong company, it's Anduril'." },
  { value: "goal", description: "States what the wearer is looking for at the event now: an internship or job, a cofounder, mentorship, learning, teammates or sponsors, e.g. 'I'm looking for a cofounder now'." },
  { value: "recap", description: "Wants the recap or summary of the last person texted again, e.g. 'text me the recap', 'send the summary again'." },
  { value: "coach", description: "Asks for reflection or advice across the whole day: how did I do, who should I follow up with first, what patterns, coach me." },
  { value: "question", description: "Any other question or request about the last person or what they said, e.g. 'what was his talk about?', 'what's her role again?', 'how did I come across to her?', 'does he have a blog?'." },
  { value: "help", description: "Greets Cue or asks what it can do, e.g. 'hi', 'help', 'what can you do'." },
  { value: "quiet", description: "Cancel, never mind, stop, thanks, ok, nothing." },
  { value: "unknown", description: "Too garbled or empty to tell." },
];

const describe = (ctx: ReplyContext): string => {
  const lines: string[] = [];
  lines.push(ctx.lastQuery ? `The last person Cue briefed and recapped: ${ctx.lastQuery.name}${ctx.lastQuery.role ? `, ${ctx.lastQuery.role}` : ""} at ${ctx.lastQuery.org}.` : "No one has been met or recapped yet.");
  if (ctx.hasBrief) {
    const fu = { none: "no follow-up draft exists for them yet", pending: "the follow-up email and times are still being written", ready: "the follow-up email draft is ready", failed: "the follow-up agent failed for them" }[ctx.followUp];
    lines.push(`Follow-up: ${fu}.`);
    lines.push(ctx.hasSchedule && ctx.slots?.length ? `Proposed meeting times, numbered: ${ctx.slots.map((s, i) => `${i + 1}) ${s}`).join(", ")}.` : "No meeting times proposed yet.");
  }
  lines.push(ctx.eventLoaded ? `Event on file: ${ctx.eventName ?? "one event"}.` : "No event is loaded yet.");
  return lines.join(" ");
};

/** One Decisions call for a texted message. Null (-> rules) without a key, on timeout, non-200, or bad JSON. */
export async function decisionsReplyIntent(text: string, ctx: ReplyContext, opts: DecisionsOpts = {}): Promise<ReplyIntentResult | null> {
  const byName = await askDecisions(
    `A student texts Cue, the assistant behind their smart glasses, on iMessage after or between networking conversations. ` +
    `Cue can only act on the wearer's own messages and never contacts the people they met.\n` +
    `Their text: "${text.slice(0, 500)}"\nContext: ${describe(ctx)}`,
    [
      { type: "choice", name: "intent", instructions: "What does the wearer want Cue to do with this text? Pick the single best fit; a message that mentions the word 'email' or 'text' in passing is not a request for a draft.", choices: CHOICES },
      { type: "choice", name: "goal", instructions: "If they are stating what they are looking for, which goal is it?", choices: GOAL_CHOICES },
    ],
    { timeoutMs: config.replyIntentTimeoutMs, ...opts },
  );
  if (!byName) return null;
  const intent = pickChoice(byName.get("intent"), REPLY_INTENTS);
  if (!intent) return null;
  const goal = pickChoice(byName.get("goal"), GOAL_CHOICES.map((g) => g.value))?.value;
  return { intent: intent.value, confidence: intent.confidence, goal, source: "decisions", probabilities: intent.probabilities };
}

/**
 * Bare commands by rules; everything else to the decision model with the rules as fallback and
 * tie-breaker. Intents that need a person (email, message, book, debrief, correction, question) are
 * still accepted without one: each branch in recap.ts answers with what is missing.
 */
export async function classifyReply(text: string, ctx: ReplyContext, opts: DecisionsOpts = {}): Promise<ReplyIntentResult> {
  const rules = rulesReplyIntent(text, ctx);
  if (rules.confidence >= 0.9) return rules; // bare command or an explicit "look up" prefix
  const model = await decisionsReplyIntent(text, ctx, opts);
  if (!model) return rules;
  if (model.confidence < 0.45) return rules;
  if (model.intent === "goal" && !model.goal) model.goal = rules.goal ?? goalFromText(text);
  if (model.intent === "goal" && !model.goal) return { ...model, intent: "question" };
  if ((model.intent === "debrief" || model.intent === "correction") && !ctx.hasBrief) return rules.intent === "lookup" ? rules : { ...model, intent: "question" };
  return model;
}
