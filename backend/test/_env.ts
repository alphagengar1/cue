// Test setup: import FIRST in every test file (before any src/ module).
// config.ts loads backend/.env, but process.loadEnvFile never overrides a variable that is
// already set, even to "". config treats "" as unset, so every paid API stays disabled.
for (const k of [
  "DEEPGRAM_API_KEY", "EXA_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_WORKSPACE_ID",
  "CREAO_API_KEY", "CREAO_EVENT_LOADER_ID", "CREAO_PERSON_RESEARCHER_ID", "CREAO_BRIEF_WRITER_ID",
  "CREAO_EVENT_LOADER_KEY", "CREAO_PERSON_RESEARCHER_KEY", "CREAO_BRIEF_WRITER_KEY", "CREAO_FOLLOW_UP_WRITER_KEY", "CREAO_FOLLOW_UP_WRITER_ID",
  "CREAO_MEETING_SCHEDULER_KEY", "CREAO_MEETING_SCHEDULER_ID", "CREAO_NETWORKING_COACH_KEY", "CREAO_NETWORKING_COACH_ID",
  "CREAO_RESEARCH_KEY", "CREAO_RESEARCH_ID", "CREAO_FOLLOWUP_KEY", "CREAO_FOLLOWUP_ID", "CREAO_COACH_KEY", "CREAO_COACH_ID",
  "SENTRY_DSN", "DEVICE_TOKEN", "PUBLIC_BASE_URL", "SAMPLE_EVENT_FILE", "PORT",
  "PHOTON_PROJECT_ID", "PHOTON_PROJECT_SECRET", "SPECTRUM_PROJECT_ID", "SPECTRUM_PROJECT_SECRET", "WEARER_PHONE", "OPENAI_API_KEY",
  "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "GOOGLE_CALENDAR_ID", "WEARER_HOURS", "WEARER_WEEKENDS",
]) process.env[k] = "";
process.env.LOOKUPS_PER_MINUTE = "10000";
process.env.ALLOW_LINKEDIN = "0"; // tests cover the strict mode; one test flips it
process.env.RESEARCH_LOADED_PEOPLE = "0"; // tests keep the "loaded research blocks a paid run" rule
process.env.JOURNAL_FILE = `/tmp/cue-test-journal-${process.pid}.jsonl`; // never the real journal
process.env.JOURNAL_TOKEN = "";
process.env.LOCAL_EVENTS_DIR = `/tmp/cue-test-events-${process.pid}`; // never the real runtime events
process.env.LOCAL_STATE_FILE = `/tmp/cue-test-local-${process.pid}.json`; // never the real profile file
process.env.SAMPLE_EVENT_FILE = "data/sample-event.json"; // the demo default is the CREAO file

// Backstop: any network call that is not to this machine fails loudly instead of costing money.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error(`test blocked outbound fetch to ${url.host}`);
  }
  return realFetch(input, init);
}) as typeof fetch;
