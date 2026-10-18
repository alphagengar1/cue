// Canonical Cue data types. Source of truth: design/01-architecture.md section 5.
// Used by both app/ and backend/. Types only (no runtime code), so either side can
// `import type { ... } from "../../shared/types"` without a build step.
// If you change a type here, change 01 section 5 in the same commit.

export type Goal = "internship" | "cofounder" | "learn" | "teammates_sponsors" | "mentorship";
export type Confidence = "high" | "medium" | "low";
export type SourceKind = "talk" | "podcast" | "own_post" | "personal_site" | "github"
  | "article" | "school_page" | "team_page" | "org_site" | "search_snippet";

export interface Fact {
  text: string;                                     // one sentence, <= 140 chars, professional only
  sourceUrl: string;
  sourceKind: SourceKind;
  date?: string;                                    // ISO date if known
}

export interface Event {
  id: string; name: string; date: string;           // ISO date
  sources: { kind: "employers" | "speakers" | "luma" | "url" | "imessage"; raw: string }[];
  loadStatus: "empty" | "loading" | "ready" | "failed";
  creaoRunId?: string;
}

export interface Organization {
  id: string;                                       // lowercase slug, e.g. "anduril"
  eventId: string;
  name: string; aliases: string[];                  // "Anduril", "Anduril Industries"
  oneLiner: string;                                 // <= 120 chars, what they do
  focusNow: Fact[];                                 // max 5: launches, priorities, hiring areas
  eventRole?: string;                               // "sponsor table 12", "speaker: 2pm panel"
  hiring?: string;                                  // roles/programs, if public
  people: string[];                                 // known attendee names from the event list
}

export interface Person {
  id: string; eventId: string; orgId: string;
  name: string; role?: string;
  headline?: string;                                // from a search title/snippet; LinkedIn headline allowed
  facts: Fact[];                                    // max 8, sorted by source priority (03 section 4)
  match: Confidence; matchReason: string;           // "3 sources mention both name and Anduril"
  lastResearchedAt?: string;
  fromEventList?: boolean;                          // loaded from an event file / event list (a known attendee)
  confirmed?: boolean;                              // the wearer picked them on the Confirm screen
  // Hand-run CREAO Follow-up Writer output (agents/follow-up-writer.md). The texting voice builds on it.
  followUp?: {
    agent?: string; agentId?: string; runLink?: string; debrief?: string;
    email?: { subject: string; body: string }; message?: string; nextSteps?: string[];
    draftLink?: string | null;                       // Gmail draft link from the Follow-up Writer (never sent)
    // Meeting Scheduler output (agents/meeting-scheduler.md), chained after the Follow-up Writer.
    // holdEventId/holdSource: the backend placed (and can move) the tentative hold through Google Calendar (backend/src/calendar.ts).
    schedule?: { proposedTimes: string[]; inviteTitle: string; inviteDescription: string; schedulingMessage: string; calendarEventCreated: boolean; eventLink: string | null; holdEventId?: string; holdSource?: "agent" | "backend" };
  };
}

export interface WearerProfile {
  id: string; name: string;
  school?: string; major?: string;
  resumeText: string;                               // pasted on setup page; not sent to the fast LLM
  summary: string;                                  // 2-3 lines, typed on setup page; sent to the LLM
  interests: string[];
  projects: string[];
  goal: Goal; goalNote?: string;                    // "summer 2027 SWE intern"
  availability?: string;                            // for the Meeting Scheduler: "weekday afternoons, not Tuesdays"
  pastConversations?: { personName: string; orgId: string; note: string }[];  // later phase
}

export interface Card {
  kind: "connect" | "context" | "angle";
  title: string;                                    // <= 20 chars; laptop mirror only, the HUD header is built by the app (02)
  body: string;                                     // <= 200 chars, <= 5 lines of <= 40 chars
  source: string | null;                            // bare domain/path, <= 34 chars, e.g. "anduril.com/blog"; the app adds "src: ". null only on "angle"
}

export interface Brief {
  id: string; version: number; eventId: string;
  transcript: string;
  query: { name: string; org: string; role?: string };
  match: { personId: string | null; confidence: Confidence; candidates: { personId: string; label: string }[] };
  cards: Card[];                                    // high/medium: 3 cards. low or "Neither": only "context" for the org. Org unknown too: only "angle" (generic ask)
  slowPath: { status: "none" | "running" | "done" | "failed"; runId?: string };
  debrief?: string;                                 // the wearer's own spoken note after the conversation (Photon follow-up)
  conversation?: string;                            // transcript recorded with the other person's consent (HUD asks first); never logged
  decision?: { match: number; goalFit: number; lead: Card["kind"] };  // decision gate (agents/decision-gate.md); absent when the gate is off
  createdAt: string; updatedAt: string;
}

// ---------------------------------------------------------------------------
// API envelopes (01 section 4.2). Not data models, but shared so the app's
// api.ts and the backend agree on request/response shapes.
// ---------------------------------------------------------------------------

export type ErrorCode =
  | "STT_EMPTY" | "STT_FAILED" | "NO_EVENT" | "SEARCH_FAILED" | "LLM_FAILED" | "UNAUTHORIZED"
  // backend-only extras (not in 01's list): bad input, unknown id, rate limit, server bug
  | "BAD_REQUEST" | "NOT_FOUND" | "RATE_LIMITED" | "INTERNAL"
  | "LLM_UNAVAILABLE";                              // resume read needs the model; nothing to fall back to

export interface ApiError { error: { code: ErrorCode; message: string } }

export type Query = Brief["query"];

export interface SttResponse { transcript: string; query: Query }
export interface BriefTextRequest { text: string }
export interface BriefResponse { brief: Brief }
export interface ConfirmRequest { personId: string | null }
export interface GoalRequest { goal: Goal; briefId?: string }
export interface GoalResponse { goal: Goal; brief?: Brief }
export interface StateResponse {
  event: Event | null;
  goal: Goal;
  profile: { name: string; school?: string };
  orgs: Organization[];
}
export type ProfileRequest = Omit<WearerProfile, "id">;
export interface CreateEventRequest {
  name: string; date: string;
  orgs: string[];
  people: { name: string; org: string; role?: string }[];
  sourceText: string;
}
export interface EventResponse { event: Event }
/** POST /api/say: hold the temple and say anything; the backend decides what it was (say.ts). */
export type SayIntent = "lookup" | "debrief" | "correction" | "goal" | "recap" | "coach" | "quiet" | "unknown";
export interface SayRequest { text: string; briefId?: string }
export interface SayResponse {
  intent: SayIntent;
  intentConfidence?: number;
  intentSource?: "decisions" | "rules";
  brief?: Brief;                                    // lookup/correction: new; debrief: note stored; goal: angle rewritten
  goal?: Goal;
  recap?: { sent: true; chars: number } | { sent: false; reason: string };
  say?: string;                                     // one HUD line when nothing else applies (<= 2 lines of 40)
  creaoRunId?: string;                              // debrief: the live CREAO Follow-up Writer run, if started
}
/** POST /api/briefs/:id/recap (Photon add-on). sent=false is a normal answer, not an error. */
export type RecapResponse =
  | { sent: true; chars: number }
  | { sent: false; reason: string; configured: boolean };
