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
  creaoKey: env("CREAO_API_KEY"),
  creaoAgents: {
    eventLoader: env("CREAO_EVENT_LOADER_ID"),
    personResearcher: env("CREAO_PERSON_RESEARCHER_ID"),
    briefWriter: env("CREAO_BRIEF_WRITER_ID"),
  },
  publicBaseUrl: env("PUBLIC_BASE_URL"),
  sentryDsn: env("SENTRY_DSN"),
  sampleEventFile: env("SAMPLE_EVENT_FILE") ?? path.join(BACKEND_DIR, "data", "sample-event.json"),
  // Timeouts (01 section 7). STT is longer than 01's 2 s because there is no Groq fallback yet.
  sttTimeoutMs: num("STT_TIMEOUT_MS", 4000),
  searchTimeoutMs: num("SEARCH_TIMEOUT_MS", 1500),
  llmTimeoutMs: num("LLM_TIMEOUT_MS", 3000),
  maxAudioBytes: num("MAX_AUDIO_BYTES", 1_000_000), // ~31 s of s16le 16 kHz mono
  lookupsPerMinute: num("LOOKUPS_PER_MINUTE", 30),
};
