import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// backend/ directory, whether running from src/ (tsx) or dist/backend/src/ (node).
const here = path.dirname(fileURLToPath(import.meta.url));
export const BACKEND_DIR = fs.existsSync(path.join(here, "..", "package.json"))
  ? path.resolve(here, "..")
  : path.resolve(here, "..", "..", "..");
export const REPO_DIR = path.resolve(BACKEND_DIR, "..");

// Load backend/.env if present (Node >= 20.12). Real env vars win.
const envFile = path.join(BACKEND_DIR, ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const env = (k: string): string | undefined => {
  const v = process.env[k]?.trim();
  return v ? v : undefined;
};
const num = (k: string, d: number): number => {
  const v = Number(env(k));
  return Number.isFinite(v) && v > 0 ? v : d;
};

export const config = {
  port: num("PORT", 8787),
  deviceToken: env("DEVICE_TOKEN"),
  deepgramKey: env("DEEPGRAM_API_KEY"),
  exaKey: env("EXA_API_KEY"),
  anthropicKey: env("ANTHROPIC_API_KEY"),
  anthropicWorkspaceId: env("ANTHROPIC_WORKSPACE_ID"),
  briefModel: env("BRIEF_MODEL") ?? "claude-haiku-5-5",
  creaoKey: env("CREAO_API_KEY"), // developer /v2 project key (cr_sk_), hosted agents only
  // Agent ids: the Cue agents built on agent.creao.ai (README.md). Used by both transports.
  creaoAgents: {
    // Three merged agents (agents/research.md, follow-up.md, coach.md) are the plan; the split names still work.
    eventLoader: env("CREAO_RESEARCH_ID") ?? env("CREAO_EVENT_LOADER_ID") ?? "5283bd7f-cc11-4b29-902b-2debe558b46f",
    personResearcher: env("CREAO_RESEARCH_ID") ?? env("CREAO_PERSON_RESEARCHER_ID") ?? "5283bd7f-cc11-4b29-902b-2debe558b46f",
    briefWriter: env("CREAO_RESEARCH_ID") ? undefined : env("CREAO_BRIEF_WRITER_ID"),
    followUpWriter: env("CREAO_FOLLOWUP_ID") ?? env("CREAO_FOLLOW_UP_WRITER_ID"),
    meetingScheduler: env("CREAO_FOLLOWUP_ID") ? undefined : env("CREAO_MEETING_SCHEDULER_ID"),
    networkingCoach: env("CREAO_COACH_ID") ?? env("CREAO_NETWORKING_COACH_ID"),
  },
  // Per-agent app keys (capi_, agent detail page -> API): run UI-built agents live through
  // agent.creao.ai/api/v1/apps/{agentId}/runs. Bills CREAO credits. See design/creao-api-notes.md.
  creaoAppKeys: {
    eventLoader: env("CREAO_RESEARCH_KEY") ?? env("CREAO_EVENT_LOADER_KEY"),
    personResearcher: env("CREAO_RESEARCH_KEY") ?? env("CREAO_PERSON_RESEARCHER_KEY"),
    briefWriter: env("CREAO_RESEARCH_KEY") ? undefined : env("CREAO_BRIEF_WRITER_KEY"),
    followUpWriter: env("CREAO_FOLLOWUP_KEY") ?? env("CREAO_FOLLOW_UP_WRITER_KEY"),
    meetingScheduler: env("CREAO_FOLLOWUP_KEY") ? undefined : env("CREAO_MEETING_SCHEDULER_KEY"),
    networkingCoach: env("CREAO_COACH_KEY") ?? env("CREAO_NETWORKING_COACH_KEY"),
  },
  wearerTimezone: env("WEARER_TIMEZONE") ?? "America/Los_Angeles",
  // LinkedIn as a fact source. On for the hackathon (professional-only still applies); ALLOW_LINKEDIN=0 restores the block.
  allowLinkedIn: env("ALLOW_LINKEDIN") !== "0",
  // Off by default (Oct 18 decision): Exa + LinkedIn + Haiku are the live cards; nobody waits two minutes
  // for a CREAO rewrite mid-conversation. RESEARCH_AFTER_LOOKUP=1 turns the background run back on.
  researchAfterLookup: env("RESEARCH_AFTER_LOOKUP") === "1",
  // Read access to the Cue Journal (/journal.md, /api/journal.json) for CREAO agents. Separate from the device token.
  journalToken: env("JOURNAL_TOKEN"),
  publicBaseUrl: env("PUBLIC_BASE_URL"),
  sentryDsn: env("SENTRY_DSN"),
  // Relative to backend/ (systemd and nohup start elsewhere). Demo default: the CREAO sponsors event.
  sampleEventFile: path.resolve(BACKEND_DIR, env("SAMPLE_EVENT_FILE") ?? "data/creao-lahacks-sponsors.json"),
  // Timeouts (01 section 7). STT is longer than 01's 2 s because there is no Groq fallback yet.
  sttTimeoutMs: num("STT_TIMEOUT_MS", 4000),
  searchTimeoutMs: num("SEARCH_TIMEOUT_MS", 1500),
  llmTimeoutMs: num("LLM_TIMEOUT_MS", 4500), // Haiku p50 ~2.2 s, p95 ~2.8 s; 3 s cut real briefs to templates
  // Decision gate cap. Measured 290 ms for 2 facts; the first call of a process and 13-fact inputs ran over 700 ms.
  decideTimeoutMs: num("DECIDE_TIMEOUT_MS", 1200),
  replyIntentTimeoutMs: num("REPLY_INTENT_TIMEOUT_MS", 4000), // iMessage intent: off the live path, seconds are fine
  maxAudioBytes: num("MAX_AUDIO_BYTES", 1_000_000), // ~31 s of s16le 16 kHz mono
  lookupsPerMinute: num("LOOKUPS_PER_MINUTE", 30),
};
