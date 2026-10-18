// Resume -> profile draft (setup page "Read resume"). One Haiku call reads the PDF (Claude reads
// PDFs natively, so no parser dependency) or plain text and returns the profile fields the wearer
// then reviews and saves. Nothing is stored here; PUT /api/profile does that. The resume text is
// never sent to Sentry and never to the fast brief writer (01: only `summary` goes there).
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { config } from "./config.js";
import { getClient, LlmUnavailable } from "./llm.js";

export const RESUME_MAX_BYTES = 8 * 1024 * 1024;
export const RESUME_TYPES = ["application/pdf", "text/plain"] as const;
export type ResumeType = (typeof RESUME_TYPES)[number];

const Draft = z.object({
  name: z.string(),
  school: z.string(),
  major: z.string(),
  summary: z.string(),
  interests: z.array(z.string()),
  projects: z.array(z.string()),
  text: z.string(),
});
export type ResumeDraft = z.infer<typeof Draft>;

const SYSTEM = `You read a student's resume and fill a short networking profile. Return exactly the fields asked for, nothing else.
- name: as written on the resume.
- school: current school (short form, e.g. "UCLA"). major: current major or program. Empty string if absent.
- summary: 2-3 plain sentences, under 300 characters, in first person ("I'm a ..."): who they are, what they build, what they're looking for. This is read by an assistant writing conversation openers, so make it concrete.
- interests: 3-6 short topics (2-4 words each) drawn from the resume.
- projects: up to 5 one-line entries, each "Name: what it does" under 100 characters.
- text: the resume as plain text, sections in order, under 6000 characters. Keep email and phone out of it.
Use only what is in the resume. Never invent.`;

const trim = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);

/** Throws LlmUnavailable when the key is missing, on timeout, refusal, or a bad response. */
export async function readResume(data: Buffer, type: ResumeType): Promise<ResumeDraft> {
  const c = getClient();
  if (!c) throw new LlmUnavailable("ANTHROPIC_API_KEY not set");
  if (!data.length) throw new LlmUnavailable("empty file");
  const content: Anthropic.ContentBlockParam[] = type === "application/pdf"
    ? [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: data.toString("base64") } },
        { type: "text", text: "Fill the profile from this resume." },
      ]
    : [{ type: "text", text: `Fill the profile from this resume:\n\n${data.toString("utf8").slice(0, 30_000)}` }];
  let parsed: ResumeDraft | null;
  try {
    const response = await c.messages.parse({
      model: config.briefModel,
      max_tokens: 3000,
      system: SYSTEM,
      thinking: { type: "disabled" },
      output_config: { effort: "low", format: zodOutputFormat(Draft) },
      messages: [{ role: "user", content }],
    }, { timeout: 30_000 });
    if (response.stop_reason === "refusal") throw new LlmUnavailable("model refused");
    parsed = response.parsed_output;
  } catch (err) {
    if (err instanceof LlmUnavailable) throw err;
    if (err instanceof Anthropic.APIError) throw new LlmUnavailable(`Anthropic ${err.status ?? "connection"}: ${err.message}`);
    throw new LlmUnavailable(String(err));
  }
  if (!parsed) throw new LlmUnavailable("no parsed output");
  return {
    name: trim(parsed.name, 80),
    school: trim(parsed.school, 80),
    major: trim(parsed.major, 80),
    summary: trim(parsed.summary, 400),
    interests: parsed.interests.map((s) => trim(s, 40)).filter(Boolean).slice(0, 6),
    projects: parsed.projects.map((s) => trim(s, 120)).filter(Boolean).slice(0, 5),
    text: parsed.text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, 6000),
  };
}
