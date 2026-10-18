// Card prompt experiments: run N system-prompt variants over the same people with the real pipeline
// (store facts or live Exa search, the real wearer profile, the real writer) and write the results to
// a JSON file for a comparison page. Spends Anthropic (and Exa) credit: variants x people calls.
//   $HOME/.nvm/versions/node/v22.18.0/bin/node node_modules/tsx/dist/cli.mjs scripts/card-variants.ts out.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Card, Goal } from "../../shared/types.js";
import type { BriefInput } from "../src/llm.js";

process.loadEnvFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env"));
process.env.SENTRY_DSN = "";
process.env.RESEARCH_AFTER_LOOKUP = "0";

const { store } = await import("../src/store.js");
const { config } = await import("../src/config.js");
const { writeCards } = await import("../src/llm.js");
const { searchPerson, filterResults, resultsToFacts } = await import("../src/search.js");
const { findOrg, findStoredPerson } = await import("../src/parse.js");
const { enforceCards } = await import("../src/safety.js");

const out = process.argv[2] ?? "card-variants.json";
store.loadSample(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "creao-lahacks-sponsors.json"), { withProfile: false });
store.loadLocal();
const goal: Goal = store.goal;

// People: a rich public profile from the loaded pack, a mid-profile public engineer found live, a made-up person.
const PEOPLE: { name: string; org: string; role?: string }[] = [
  { name: "David Cramer", org: "Sentry", role: "co-founder" },
  { name: "Armin Ronacher", org: "Sentry", role: "engineer" },
  { name: "Maya Lin", org: "Even Realities", role: "recruiter" },
];
if (process.argv[3]) { const [name, org, role] = process.argv[3].split(",").map((s) => s.trim()); if (name && org) PEOPLE.push({ name, org, role }); }

const BASE_RULES = `Rules: use ONLY facts in the input. Never invent facts, titles or events. Never mention family, home, health, religion or politics. Plain text, no emoji, no markdown. title at most 20 characters, 2-3 words. body at most 200 characters, at most 5 lines of at most 40 characters, separated by "\\n". source is the bare domain and path of the main fact used, at most 34 characters, no "src:" prefix; it may be null only for the angle card when it uses no person fact. If person.match is "low", return only the context card about the organization and begin its body with "No public info found for {name}." If the organization is also unknown, return only the angle card with a generic ask for the goal.
Output ONLY JSON: { "cards": [{ "kind", "title", "body", "source" }] }.`;
const INPUT = `You get JSON with: person (name, role, headline, facts with sources, match), organization (oneLiner, focusNow, hiring), wearer (summary, interests, projects, goalNote, pastConversations), goal, eventName.`;

const VARIANTS: { id: string; label: string; system: string }[] = [
  { id: "baseline", label: "Baseline (current prompt)", system: fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "agents", "fast-brief.md"), "utf8").split("<!-- prompt -->")[1].trim() },
  { id: "specific", label: "Specific artifact first", system: `You write a 3-card conversation brief for a student wearing smart glasses, read in a glance mid-conversation. ${INPUT}
Write exactly three cards:
1. connect: open with ONE concrete artifact from the facts: the title of a talk, a post, a repo, a launch, with its year if given. Then the one question it invites. Nothing generic.
2. context: who they are in one line, then the single most current thing they or their org are doing, with a year or product name.
3. angle: the one thing to ask for that serves the wearer's goal ("{goal}"), tied to the most relevant fact. Name the wearer's own project or interest when it genuinely overlaps.
${BASE_RULES}` },
  { id: "sayable", label: "Every body is sayable aloud", system: `You write a 3-card conversation brief for a student wearing smart glasses. Each card body is something the wearer can literally SAY, word for word, in a conversation. ${INPUT}
1. connect: the opener sentence to say, as a question, referencing one specific thing the person made, said or wrote (name it). Under 35 words.
2. context: one line of who they are, then a sentence the wearer can say that shows they know what the org is doing now.
3. angle: the ask to say out loud, serving the wearer's goal ("{goal}"), specific to this person.
Write in the second person only where the wearer addresses the other person ("you"). ${BASE_RULES}` },
  { id: "overlap", label: "Wearer overlap required", system: `You write a 3-card conversation brief for a student wearing smart glasses. The wearer's own background (summary, interests, projects, goalNote) MUST appear by name in the connect and angle cards when any overlap exists; find the sharpest overlap between the wearer and the person's facts. ${INPUT}
1. connect: the overlap, stated plainly: "You built X. They did Y. Ask Z." Use the wearer's project name and the person's specific work.
2. context: who they are and what the org is focused on now, one fact each, with a date or name.
3. angle: how this person specifically helps the wearer's goal ("{goal}") and the exact ask.
${BASE_RULES}` },
  { id: "numbers", label: "Dates, names, numbers", system: `You write a 3-card conversation brief for a student wearing smart glasses. Every card must contain at least one concrete anchor from the facts: a year, a product name, an event name, a number, or a title. No card may be true of a generic person at this org. ${INPUT}
1. connect: the most recent concrete thing they did (anchor), and the question it invites.
2. context: role and org focus with anchors.
3. angle: the ask that serves the wearer's goal ("{goal}"), with the anchor that makes it credible (a program name, a hiring note, a project).
${BASE_RULES}` },
  { id: "coach", label: "Coach voice: say this, then ask that", system: `You are a sharp friend whispering to a student at a networking event through smart glasses. Short imperatives. ${INPUT}
1. connect: "Mention <specific thing>. Ask <specific question>." Two short sentences, both specific to the facts.
2. context: "They <role>. Right now <one current fact>." Two short sentences.
3. angle: "For your <goal> ("{goal}"): ask <specific ask>." If the wearer's project or interest overlaps, name it: "Bring up <project>."
${BASE_RULES}` },
  { id: "twoline", label: "Two lines per card", system: `You write a 3-card conversation brief for a student wearing smart glasses. Each card body is at most 2 lines of at most 40 characters: one fact, one move. Choose the single sharpest fact per card. ${INPUT}
1. connect: fact + the question to ask.
2. context: who + what now.
3. angle: the ask for the wearer's goal ("{goal}").
${BASE_RULES}` },
  { id: "insight", label: "One surprising fact and why it matters", system: `You write a 3-card conversation brief for a student wearing smart glasses. Pick the one fact a stranger would NOT know and build around it. ${INPUT}
1. connect: the surprising or lesser-known fact (with its source anchor), and the question that shows the wearer noticed.
2. context: the standard who-they-are and what-the-org-does-now, compressed.
3. angle: what the wearer should ask for, given their goal ("{goal}") and their own projects, phrased so it follows naturally from card 1.
${BASE_RULES}` },
  { id: "story", label: "Story hook", system: `You write a 3-card conversation brief for a student wearing smart glasses. Card 1 is a hook the wearer can tell as a 10-second story about the person's work, then a question. ${INPUT}
1. connect: "I read that you <specific thing with when/where>." + one question about what came next or what was hard.
2. context: who they are, what the org is pushing now.
3. angle: the ask for the goal ("{goal}"), tied to the wearer's own work when it overlaps.
${BASE_RULES}` },
];

async function factsFor(p: { name: string; org: string; role?: string }) {
  const org = findOrg(p.org);
  const stored = findStoredPerson(p.name, org);
  if (stored && stored.facts.length) return { org, facts: stored.facts, headline: stored.headline, match: "high" as const, source: "loaded pack" };
  const results = await searchPerson(`${p.name} ${org?.name ?? p.org}`);
  const kept = filterResults(results, p.name, org ? [org.name, ...org.aliases] : [p.org]);
  const facts = resultsToFacts(kept, org ? [org.name] : []);
  return { org, facts, headline: undefined, match: facts.length >= 2 ? "high" as const : facts.length ? "medium" as const : "low" as const, source: `exa (${kept.length}/${results.length} kept)` };
}

const results: { variant: string; label: string; system: string; cards: Record<string, { cards: Card[]; ms: number; error?: string }> }[] = [];
const people: Record<string, { name: string; org: string; role?: string; match: string; facts: number; source: string }> = {};
const inputs: Record<string, BriefInput> = {};
for (const p of PEOPLE) {
  const f = await factsFor(p);
  people[p.name] = { ...p, match: f.match, facts: f.facts.length, source: f.source };
  inputs[p.name] = {
    person: { name: p.name, role: p.role, headline: f.headline, facts: f.facts, match: f.match },
    organization: f.org ? { name: f.org.name, oneLiner: f.org.oneLiner, focusNow: f.org.focusNow, eventRole: f.org.eventRole, hiring: f.org.hiring } : null,
    wearer: store.profile, goal, eventName: store.activeEvent()?.name ?? "LA Hacks Fall 2026",
  };
  console.log(`${p.name}: ${f.match}, ${f.facts.length} facts (${f.source})`);
}
for (const v of VARIANTS) {
  const row: (typeof results)[number] = { variant: v.id, label: v.label, system: v.system, cards: {} };
  await Promise.all(PEOPLE.map(async (p) => {
    const t0 = Date.now();
    try {
      const cards = enforceCards(await writeCards(inputs[p.name], undefined, { systemOverride: v.system }));
      row.cards[p.name] = { cards, ms: Date.now() - t0 };
    } catch (err) {
      row.cards[p.name] = { cards: [], ms: Date.now() - t0, error: err instanceof Error ? err.message : String(err) };
    }
  }));
  console.log(`${v.id}: ${PEOPLE.map((p) => `${p.name.split(" ")[0]} ${row.cards[p.name].cards.length} cards ${row.cards[p.name].ms}ms${row.cards[p.name].error ? " ERR" : ""}`).join(" | ")}`);
  results.push(row);
}
fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), model: config.briefModel, goal, wearer: { name: store.profile.name, summary: store.profile.summary, interests: store.profile.interests, projects: store.profile.projects, goalNote: store.profile.goalNote }, people, results }, null, 2));
console.log("wrote", out);
