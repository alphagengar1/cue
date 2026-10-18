// Fast brief writer: one Claude call -> cards JSON (03 section 5).
// Model: BRIEF_MODEL (default "claude-haiku-5-5"), output_config.effort "low",
// structured outputs via output_config.format. Haiku 5.5 runs adaptive thinking by default;
// no assistant prefill.
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Card, Goal, Organization, Person, WearerProfile } from "../../shared/types.js";
import { config, REPO_DIR } from "./config.js";
import { enforceCards, hostOf } from "./safety.js";

// Length limits are enforced in code (safety.enforceCards), not in the schema,
// because structured outputs do not support string length constraints.
const CardSchema = z.object({
  kind: z.enum(["connect", "context", "angle"]),
  title: z.string(),
  body: z.string(),
  source: z.string().nullable(),
});
const BriefOutput = z.object({ cards: z.array(CardSchema) });

const FALLBACK_PROMPT =
  "You write a 3-card conversation brief (connect, context, angle) for a student at a networking event. " +
  "Use ONLY facts in the input. Output ONLY JSON: {\"cards\":[{\"kind\",\"title\",\"body\",\"source\"}]}.";

function loadPrompt(): string {
  try {
    const md = fs.readFileSync(path.join(REPO_DIR, "agents", "fast-brief.md"), "utf8");
    const i = md.indexOf("<!-- prompt -->");
    return i >= 0 ? md.slice(i + "<!-- prompt -->".length).trim() : md.trim();
  } catch {
    return FALLBACK_PROMPT;
  }
}
const SYSTEM_TEMPLATE = loadPrompt();

let client: Anthropic | null = null;
export const getClient = (): Anthropic | null => {
  if (!config.anthropicKey) return null;
  client ??= new Anthropic({
    apiKey: config.anthropicKey, maxRetries: 0, timeout: config.llmTimeoutMs,
    // Keys not scoped to a workspace must name one on every request.
    defaultHeaders: config.anthropicWorkspaceId ? { "anthropic-workspace-id": config.anthropicWorkspaceId } : undefined,
  });
  return client;
};

export class LlmUnavailable extends Error {}

export interface BriefInput {
  person: Pick<Person, "name" | "role" | "headline" | "facts" | "match">;
  organization: Pick<Organization, "name" | "oneLiner" | "focusNow" | "eventRole" | "hiring"> | null;
  wearer: WearerProfile;
  goal: Goal;
  eventName: string;
}

const GOAL_TEXT: Record<Goal, string> = {
  internship: "internship",
  cofounder: "find a cofounder",
  learn: "learn",
  teammates_sponsors: "find teammates or sponsors",
  mentorship: "mentorship",
};

/**
 * Generic structured call for the off-path writers (compose.ts): same model and client, no
 * thinking, a longer per-request timeout. Throws LlmUnavailable exactly like writeCards.
 */
export async function parseWithModel<T extends z.ZodType>(
  system: string, payload: unknown, schema: T, opts: { maxTokens?: number; timeoutMs?: number } = {},
): Promise<z.infer<T>> {
  const c = getClient();
  if (!c) throw new LlmUnavailable("ANTHROPIC_API_KEY not set");
  try {
    const response = await c.messages.parse({
      model: config.briefModel,
      max_tokens: opts.maxTokens ?? 800,
      system,
      thinking: { type: "disabled" },
      output_config: { effort: "low", format: zodOutputFormat(schema) },
      messages: [{ role: "user", content: JSON.stringify(payload) }],
    }, { timeout: opts.timeoutMs ?? 8000 });
    if (response.stop_reason === "refusal") throw new LlmUnavailable("model refused");
    if (!response.parsed_output) throw new LlmUnavailable("no parsed output");
    return response.parsed_output as z.infer<T>;
  } catch (err) {
    if (err instanceof LlmUnavailable) throw err;
    if (err instanceof Anthropic.APIError) throw new LlmUnavailable(`Anthropic ${err.status ?? "connection"}: ${err.message}`);
    throw new LlmUnavailable(String(err));
  }
}

/**
 * One LLM call. `only` restricts the output to the given card kinds (used by PUT /api/goal
 * to regenerate only the angle card). Throws LlmUnavailable on missing key, timeout,
 * refusal, or unparseable output; the caller falls back to the template brief.
 */
export async function writeCards(input: BriefInput, only?: Card["kind"][]): Promise<Card[]> {
  const c = getClient();
  if (!c) throw new LlmUnavailable("ANTHROPIC_API_KEY not set");

  const system = SYSTEM_TEMPLATE
    .replaceAll("{goal}", GOAL_TEXT[input.goal])
    .replaceAll("{name}", input.person.name);

  // The fast LLM gets the profile summary, not the resume (01 section 5).
  const payload = {
    person: input.person,
    organization: input.organization,
    wearer: {
      summary: input.wearer.summary,
      interests: input.wearer.interests,
      projects: input.wearer.projects,
      goalNote: input.wearer.goalNote,
      pastConversations: input.wearer.pastConversations ?? [],
    },
    goal: input.goal,
    eventName: input.eventName,
  };
  const ask = only
    ? `Return only these cards: ${only.join(", ")}.\n\n`
    : "";

  let parsed: z.infer<typeof BriefOutput> | null;
  try {
    const response = await c.messages.parse({
      model: config.briefModel,
      max_tokens: 2000,
      system,
      // Haiku 5.5 thinks by default (~900 tokens, +3-4 s). Cards are short; skip it.
      thinking: { type: "disabled" },
      output_config: { effort: "low", format: zodOutputFormat(BriefOutput) },
      messages: [{ role: "user", content: `${ask}${JSON.stringify(payload)}` }],
    });
    if (response.stop_reason === "refusal") throw new LlmUnavailable("model refused");
    parsed = response.parsed_output;
  } catch (err) {
    if (err instanceof LlmUnavailable) throw err;
    if (err instanceof Anthropic.APIError) {
      throw new LlmUnavailable(`Anthropic ${err.status ?? "connection"}: ${err.message}`);
    }
    throw new LlmUnavailable(String(err));
  }
  if (!parsed) throw new LlmUnavailable("no parsed output");
  // Cited sources must be hosts of facts we sent; anything else was invented (dropped, template fills).
  const allowedHosts = [...input.person.facts, ...(input.organization?.focusNow ?? [])].map((f) => hostOf(f.sourceUrl));
  let cards = enforceCards(parsed.cards, { allowedHosts });
  if (only) cards = cards.filter((k) => only.includes(k.kind));
  return cards;
}
