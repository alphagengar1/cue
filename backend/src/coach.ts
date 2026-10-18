// Networking Coach (agents/networking-coach.md): the long-run CREAO agent. It gets the wearer's whole
// day (briefs, debriefs, saved conversations, what was sent) and answers "how did I do?", picks who
// to follow up with first, and coaches the next conversation. With extended memory on the agent,
// it compares days. Started from a spoken/texted question, or after every third debrief.
import type { Brief } from "../../shared/types.js";
import { creaoEnabled, startRun } from "./creao.js";
import { store } from "./store.js";

const day = (iso: string): string => iso.slice(0, 10);

export interface CoachEntry {
  date: string;
  person: { name: string; role: string; org: string };
  cards: { kind: string; title: string; body: string }[];
  debrief: string;
  conversation: string;
  followUpSent: boolean;
  goal: string;
}

/** Today's conversations, oldest first, one per person (the latest brief for that person wins). */
export function coachHistory(now = new Date()): CoachEntry[] {
  const today = day(now.toISOString());
  const byPerson = new Map<string, Brief>();
  for (const b of [...store.briefs.values()].sort((a, c) => a.createdAt.localeCompare(c.createdAt))) {
    if (day(b.createdAt) !== today || !b.cards.length) continue;
    byPerson.set(`${b.query.name}|${b.query.org}`.toLowerCase(), b);
  }
  return [...byPerson.values()].map((b) => {
    const person = b.match.personId ? store.people.get(b.match.personId) : undefined;
    return {
      date: day(b.createdAt),
      person: { name: b.query.name, role: b.query.role ?? "", org: b.query.org },
      cards: b.cards.map((c) => ({ kind: c.kind, title: c.title, body: c.body.replace(/\n/g, " ") })),
      debrief: b.debrief ?? "",
      conversation: (b.conversation ?? "").slice(0, 4000),
      followUpSent: !!(b.followUp?.email ?? person?.followUp?.email), // drafted by the agent; the wearer presses send
      goal: store.goal,
    };
  });
}

export const debriefsToday = (now = new Date()): number =>
  [...store.briefs.values()].filter((b) => day(b.createdAt) === day(now.toISOString()) && !!b.debrief).length;

/** Start a coach run. Returns the run id, or null when the agent is not configured or the start failed. */
export async function startCoach(question: string, trigger: string): Promise<string | null> {
  if (!creaoEnabled("networking_coach")) return null;
  const p = store.profile;
  const runId = await startRun("networking_coach", {
    wearer: { name: p.name, school: p.school ?? "", goal: store.goal, goalNote: p.goalNote ?? "", summary: p.summary },
    today: day(new Date().toISOString()),
    history: coachHistory(),
    question: question.trim().slice(0, 300),
  }, {});
  console.log(`[coach] ${runId ? `started ${runId}` : "start failed"} (${trigger})`);
  return runId;
}
