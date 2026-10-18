// One-off CREAO /v2 check for a human with a real project key (design/creao-api-notes.md).
//   npm run creao:test -- --me                 -> probe the key (GET /v2/me, free)
//   npm run creao:test -- --list               -> list this project's hosted agents and agent_id values (free)
//   npm run creao:test -- --create <agent>     -> NL-create a hosted agent from agents/<agent>.md (BILLS USD)
//   npm run creao:test                         -> run the Event Loader on a small sample, poll, print (BILLS USD)
//   npm run creao:test -- person_researcher    -> same for the Person Researcher
//   npm run creao:test -- brief_writer         -> same for the Brief Writer
//   npm run creao:test -- --run <run_id>       -> fetch an existing run and print/validate it (free)
// <agent> is event_loader | person_researcher | brief_writer. Needs CREAO_API_KEY (a /v2 project key) and,
// for runs, the hosted agent id env var in backend/.env. Optional CREAO_MODEL picks the model.
import fs from "node:fs";
import path from "node:path";
import { config, REPO_DIR } from "./config.js";
import {
  agentIdFor, applyEventLoader, cleanFacts, createAgent, createRun, extractResult, getAgent, getAgentEdit,
  getMe, getRun, isTerminal, listAgents, usageSummary, type AgentKind, type CreaoRun,
} from "./creao.js";
import { store } from "./store.js";

const SAMPLES: Record<AgentKind, unknown> = {
  event_loader: {
    eventId: "lahacks-f26",
    eventName: "LA Hacks Fall 2026",
    orgs: ["Even Realities", "CREAO", "Sentry"],
    people: [],
    sourceText: "Sponsors: Even Realities (G2 glasses track), CREAO (agents track), Sentry (best use of Sentry).",
  },
  person_researcher: {
    name: "David Cramer", org: "Sentry", role: "co-founder", orgAliases: ["Sentry.io", "Getsentry"],
  },
  follow_up_writer: {
    brief: { person: { name: "David Cramer", role: "co-founder", org: "Sentry" }, cards: [{ kind: "connect", title: "Ask about Seer", body: "Seer debugs from errors and traces.", source: "blog.sentry.io" }] },
    debrief: "he said email him about Seer, they are hiring summer interns",
    goal: "internship",
    wearer: { name: "Test Student", school: "UCLA", major: "CS", summary: "CS student building a smart-glasses networking app.", interests: ["observability"], projects: ["Cue"], goalNote: "summer 2027 SWE intern" },
    eventName: "LA Hacks Fall 2026",
  },
  meeting_scheduler: {
    person: { name: "David Cramer", role: "co-founder", org: "Sentry" },
    followUp: { email: { subject: "Following up on Seer", body: "Hi David,\n\nThanks for the chat.\n\nSam" }, message: "Hi David, great meeting you. Sam", nextSteps: ["Email David about Seer"] },
    debrief: "he said email him about seer", conversation: "",
    wearer: { name: "Sam Lee", school: "UCLA", availability: "weekday afternoons", timezone: "America/Los_Angeles" },
    eventName: "LA Hacks Fall 2026",
  },
  networking_coach: {
    wearer: { name: "Sam Lee", school: "UCLA", goal: "internship", goalNote: "summer 2027 SWE intern", summary: "CS student building Cue." },
    today: "2026-10-17",
    history: [{ date: "2026-10-17", person: { name: "David Cramer", role: "co-founder", org: "Sentry" }, cards: [{ kind: "connect", title: "Ask about Seer", body: "Seer debugs from traces." }], debrief: "he said email him about seer", conversation: "", followUpSent: true, goal: "internship" }],
    question: "how did I do today?",
  },
  brief_writer: {
    person: {
      name: "David Cramer", role: "co-founder", match: "high",
      facts: [{ text: "Co-founded Sentry, the open-source error monitoring project.", sourceUrl: "https://sentry.io/about/", sourceKind: "org_site" }],
    },
    organization: { name: "Sentry", oneLiner: "Application monitoring: errors, tracing, logs and replay.", focusNow: [] },
    wearer: { name: "Test Student", summary: "CS student building a smart-glasses networking app.", interests: ["observability"], projects: ["Cue"], goal: "internship" },
    goal: "internship",
    eventName: "LA Hacks Fall 2026",
  },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const NAMES: Record<AgentKind, string> = {
  event_loader: "Cue Event Loader", person_researcher: "Cue Person Researcher", brief_writer: "Cue Brief Writer",
  follow_up_writer: "Cue Follow-up Writer", meeting_scheduler: "Cue Meeting Scheduler", networking_coach: "Cue Networking Coach",
};
const ENV_VARS: Record<AgentKind, string> = {
  event_loader: "CREAO_EVENT_LOADER_ID", person_researcher: "CREAO_PERSON_RESEARCHER_ID", brief_writer: "CREAO_BRIEF_WRITER_ID",
  follow_up_writer: "CREAO_FOLLOW_UP_WRITER_ID", meeting_scheduler: "CREAO_MEETING_SCHEDULER_ID", networking_coach: "CREAO_NETWORKING_COACH_ID",
};

/** The ```text block under "## Instructions (paste this)" in agents/<kind>.md. */
function instructionsFor(agent: AgentKind): string {
  const md = fs.readFileSync(path.join(REPO_DIR, "agents", `${agent.replace("_", "-")}.md`), "utf8");
  const m = md.match(/## Instructions \(paste this\)\s*```text\n([\s\S]*?)\n```[ \t]*$/m);
  if (!m) throw new Error(`No Instructions block in agents/${agent}.md`);
  return m[1].trim();
}

function usageLine(run: Pick<CreaoRun, "usage">): string {
  const u = usageSummary(run);
  const per = (run.usage?.models ?? []).map((m) => `${m.model}(${m.kind}) in=${m.input_tokens ?? 0} out=${m.output_tokens ?? 0}`).join("; ");
  return `tokens in=${u.inTok} out=${u.outTok} usd~${u.usd?.toFixed(4) ?? "? (rate unknown)"}${per ? ` [${per}]` : ""}`;
}

async function create(agent: AgentKind): Promise<void> {
  const instructions = instructionsFor(agent);
  const input = `Create a hosted agent named "${NAMES[agent]}". Output format: Markdown. Use the instructions below as the agent's skill, keeping every rule word for word (especially the safety rules and the output format). The run input is a JSON object with the fields described under INPUT. The final reply must always end with one \`\`\`json block in the output format, and nothing after it.\n\n${instructions}`;
  console.log(`Creating hosted agent "${NAMES[agent]}" (${input.length} chars of instructions). This bills the USD wallet.`);
  const run = await createAgent(input);
  console.log(`create run_id=${run.run_id} agent_id=${run.agent_id ?? "(not yet known)"} status=${run.status}`);
  if (!run.agent_id) { console.log("agent_id not in the 202 response. Check `--list` in a minute."); return; }
  const t0 = Date.now();
  for (;;) {
    const e = await getAgentEdit(run.agent_id, run.run_id);
    process.stdout.write(`\r${Math.round((Date.now() - t0) / 1000)}s status=${e.status}      `);
    if (["succeeded", "failed", "cancelled"].includes(e.status)) {
      console.log(`\n${usageLine(e)}`);
      if (e.status !== "succeeded") { console.log(`error: ${JSON.stringify(e.error ?? null)}`); process.exitCode = 1; return; }
      const a = await getAgent(e.agent_id);
      const skill = a.skill_content ?? "";
      const kept = ["sourceUrl", "```json"].filter((k) => skill.includes(k));
      console.log(`agent_id=${a.agent_id} name=${a.name}\nskill_content keeps ${kept.length}/2 output markers (sourceUrl, \`\`\`json). Read it with care.`);
      console.log(`Put this in backend/.env: ${ENV_VARS[agent]}=${a.agent_id}`);
      return;
    }
    if (Date.now() - t0 > 20 * 60_000) { console.log("\nGave up after 20 min."); return; }
    await sleep(10_000);
  }
}

async function show(run: CreaoRun, agent: AgentKind): Promise<void> {
  console.log(`\nstatus=${run.status} model=${run.model ?? "?"} conversation_id=${run.conversation_id}\n${usageLine(run)}`);
  if (run.error) console.log(`error: ${JSON.stringify(run.error)}`);
  console.log(`result keys: ${Object.keys(run.result ?? {}).join(", ") || "(none)"}`);
  console.log(`result.text (first 800 chars):\n${(run.result?.text ?? "").slice(0, 800)}\n`);
  const out = await extractResult(run, agent);
  if (!out) { console.log("NO matching JSON found in result. Tighten the agent's output instructions."); process.exitCode = 1; return; }
  console.log("Extracted JSON:\n" + JSON.stringify(out, null, 2).slice(0, 6000));
  if (agent === "event_loader") {
    // Apply to a scratch copy of the sample store to show what the fast path would get.
    store.loadSample();
    console.log("\nApplied to sample store: " + applyEventLoader({ eventId: store.activeEventId ?? undefined }, out));
    for (const o of store.eventOrgs()) console.log(`  ${o.id}: ${o.oneLiner} | facts=${o.focusNow.length} | ${o.hiring ?? ""}`);
  } else if (agent === "person_researcher") {
    const facts = cleanFacts((out as { facts: unknown }).facts, 8, "article");
    console.log(`\n${facts.length} facts pass the backend safety/URL filter.`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (!config.creaoKey) { console.error("CREAO_API_KEY is not set (backend/.env)."); process.exit(2); }

  if (args.includes("--me")) {
    const me = await getMe();
    console.log(`projectId=${me.projectId} keyId=${me.keyId}`);
    return;
  }

  if (args.includes("--list")) {
    const { agents } = await listAgents();
    for (const a of agents) console.log(`${a.agent_id}  v${a.version}  ${a.status}  ${a.name}`);
    if (!agents.length) console.log("No hosted agents on this project. Create one with --create <agent>.");
    return;
  }

  const agent = (args.find((a) => !a.startsWith("--") && a in SAMPLES) ?? "event_loader") as AgentKind;
  if (args.includes("--create")) { await create(agent); return; }
  const runIdx = args.indexOf("--run");
  let runId = runIdx >= 0 ? args[runIdx + 1] : undefined;

  if (!runId) {
    const agentId = agentIdFor(agent);
    if (!agentId) { console.error(`Agent id env var for ${agent} is not set.`); process.exit(2); }
    console.log(`Starting ${agent} (${agentId}) with:\n${JSON.stringify(SAMPLES[agent], null, 2)}`);
    const run = await createRun(agentId, SAMPLES[agent]);
    runId = run.run_id;
    console.log(`run_id=${run.run_id} conversation_id=${run.conversation_id} status=${run.status}`);
  }

  const t0 = Date.now();
  for (;;) {
    const run = await getRun(runId);
    process.stdout.write(`\r${Math.round((Date.now() - t0) / 1000)}s status=${run.status}      `);
    if (isTerminal(run.status)) { await show(run, agent); return; }
    if (Date.now() - t0 > 20 * 60_000) { console.log("\nGave up after 20 min. Re-check later with --run " + runId); return; }
    await sleep(10_000);
  }
}

main().catch((err) => { console.error("\n" + (err instanceof Error ? err.message : String(err))); process.exit(1); });
