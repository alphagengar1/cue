// One-off CREAO check for a human with real keys (design/creao-api-notes.md).
//   npm run creao:test                      -> run the Event Loader on a small sample, poll, print the result
//   npm run creao:test -- person_researcher -> same for the Person Researcher
//   npm run creao:test -- brief_writer      -> same for the Brief Writer
//   npm run creao:test -- --list            -> list your agents and their agent_id values
//   npm run creao:test -- --run <run_id>    -> fetch an existing run and print/validate it
// Needs CREAO_API_KEY (+ the agent id env var) in backend/.env. Each run spends CREAO credits.
import { config } from "./config.js";
import {
  agentIdFor, applyEventLoader, cleanFacts, createRun, extractResult, getRun, isTerminal, listAgents,
  type AgentKind, type CreaoRun,
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

async function show(run: CreaoRun, agent: AgentKind): Promise<void> {
  console.log(`\nstatus=${run.status} credits=${run.usage?.credits ?? "?"} model=${run.model ?? "?"} conversation_id=${run.conversation_id}`);
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

  if (args.includes("--list")) {
    const { agents } = await listAgents();
    for (const a of agents) console.log(`${a.agent_id}  v${a.version}  ${a.status}  ${a.name}`);
    if (!agents.length) console.log("No personal agents visible to this key.");
    return;
  }

  const agent = (args.find((a) => !a.startsWith("--") && a in SAMPLES) ?? "event_loader") as AgentKind;
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
