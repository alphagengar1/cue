// Test setup: import FIRST in every test file (before any src/ module).
// config.ts loads backend/.env, but process.loadEnvFile never overrides a variable that is
// already set, even to "". config treats "" as unset, so every paid API stays disabled.
for (const k of [
  "DEEPGRAM_API_KEY", "EXA_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_WORKSPACE_ID",
  "CREAO_API_KEY", "CREAO_EVENT_LOADER_ID", "CREAO_PERSON_RESEARCHER_ID", "CREAO_BRIEF_WRITER_ID",
  "SENTRY_DSN", "DEVICE_TOKEN", "PUBLIC_BASE_URL", "SAMPLE_EVENT_FILE", "PORT",
  "PHOTON_PROJECT_ID", "PHOTON_PROJECT_SECRET", "SPECTRUM_PROJECT_ID", "SPECTRUM_PROJECT_SECRET", "WEARER_PHONE", "OPENAI_API_KEY",
]) process.env[k] = "";
process.env.LOOKUPS_PER_MINUTE = "10000";
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
