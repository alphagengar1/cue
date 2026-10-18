// The Cue Journal: an append-only record of everything that happens around the wearer's
// conversations (brief, research, debrief, transcript, follow-up, times, coaching, goal). It is the
// shared store the long-horizon CREAO agents read on their own schedule: served as Markdown at
// /journal.md (agents read URLs natively) and as JSON, behind JOURNAL_TOKEN, never the device token.
// Persisted to data/journal.local.jsonl (gitignored; the wearer's own data).
import fs from "node:fs";
import path from "node:path";
import { BACKEND_DIR } from "./config.js";
import { store } from "./store.js";

export type JournalType =
  | "say" | "brief" | "research" | "cards_updated" | "debrief" | "transcript" | "recap"
  | "follow_up" | "schedule" | "coaching" | "goal" | "reply";

export interface JournalEntry {
  at: string;
  type: JournalType;
  briefId?: string;
  person?: { name: string; org: string; role?: string };
  data: Record<string, unknown>;
}

const FILE = path.resolve(BACKEND_DIR, process.env.JOURNAL_FILE?.trim() || "data/journal.local.jsonl");
const MAX_IN_MEMORY = 5000;
let entries: JournalEntry[] | null = null;

function load(): JournalEntry[] {
  if (entries) return entries;
  entries = [];
  try {
    if (fs.existsSync(FILE)) {
      for (const line of fs.readFileSync(FILE, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try { entries.push(JSON.parse(line) as JournalEntry); } catch { /* skip a torn line */ }
      }
    }
  } catch (err) {
    console.warn(`[journal] could not read ${FILE}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (entries.length > MAX_IN_MEMORY) entries = entries.slice(-MAX_IN_MEMORY);
  return entries;
}

/** Append one entry (memory + file). Never throws. */
export function journal(entry: Omit<JournalEntry, "at">): JournalEntry {
  const full: JournalEntry = { at: new Date().toISOString(), ...entry };
  load().push(full);
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.appendFileSync(FILE, JSON.stringify(full) + "\n");
  } catch (err) {
    console.warn(`[journal] could not write: ${err instanceof Error ? err.message : String(err)}`);
  }
  return full;
}

export const journalEntries = (): JournalEntry[] => [...load()];

/** Test / reset hook. */
export function journalReset(): void { entries = []; try { fs.rmSync(FILE, { force: true }); } catch { /* ignore */ } }

export interface JournalPerson {
  key: string;
  name: string; org: string; role?: string;
  firstSeen: string; lastSeen: string;
  conversations: number;
  briefIds: string[];
  cards: { kind: string; title: string; body: string }[];
  facts: { text: string; sourceUrl: string }[];
  debriefs: string[];
  transcriptChars: number;
  transcript?: string;
  followUp?: { subject?: string; body?: string; message?: string; nextSteps?: string[]; draftLink?: string | null };
  schedule?: { proposedTimes?: string[]; schedulingMessage?: string; eventLink?: string | null; calendarEventCreated?: boolean };
  recapsSent: number;
}

const keyOf = (p: { name: string; org: string }): string => `${p.name}|${p.org}`.toLowerCase();

/** One summary per person, newest activity first. */
export function journalPeople(): JournalPerson[] {
  const by = new Map<string, JournalPerson>();
  for (const e of load()) {
    if (!e.person?.name) continue;
    const k = keyOf(e.person);
    let p = by.get(k);
    if (!p) {
      p = { key: k, name: e.person.name, org: e.person.org, role: e.person.role, firstSeen: e.at, lastSeen: e.at,
        conversations: 0, briefIds: [], cards: [], facts: [], debriefs: [], transcriptChars: 0, recapsSent: 0 };
      by.set(k, p);
    }
    p.lastSeen = e.at;
    if (e.person.role && !p.role) p.role = e.person.role;
    const d = e.data;
    switch (e.type) {
      case "brief":
        p.conversations++;
        if (e.briefId && !p.briefIds.includes(e.briefId)) p.briefIds.push(e.briefId);
        if (Array.isArray(d.cards)) p.cards = d.cards as JournalPerson["cards"];
        break;
      case "cards_updated":
        if (Array.isArray(d.cards)) p.cards = d.cards as JournalPerson["cards"];
        break;
      case "research":
        if (Array.isArray(d.facts)) p.facts = d.facts as JournalPerson["facts"];
        break;
      case "debrief":
        if (typeof d.text === "string") p.debriefs.push(d.text);
        break;
      case "transcript":
        if (typeof d.text === "string") { p.transcriptChars += d.text.length; p.transcript = `${p.transcript ?? ""} ${d.text}`.trim().slice(-12_000); }
        break;
      case "recap":
        if (d.sent) p.recapsSent++;
        break;
      case "follow_up":
        p.followUp = d as JournalPerson["followUp"];
        break;
      case "schedule":
        p.schedule = d as JournalPerson["schedule"];
        break;
      default:
        break;
    }
  }
  return [...by.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

const day = (iso: string): string => iso.slice(0, 10);
const esc = (s: string): string => s.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();

/** The journal as a Markdown page: what a scheduled CREAO agent reads. */
export function journalMarkdown(now = new Date()): string {
  const all = load();
  const people = journalPeople();
  const p = store.profile;
  const out: string[] = [];
  out.push(`# Cue Journal`, ``, `Generated ${now.toISOString()}. Wearer: ${p.name}${p.school ? `, ${p.school}` : ""}. Goal: ${store.goal}${p.goalNote ? ` (${p.goalNote})` : ""}.`, ``);
  out.push(`Entries: ${all.length}. People: ${people.length}. Days: ${new Set(all.map((e) => day(e.at))).size}.`, ``);
  out.push(`## People (newest first)`, ``);
  for (const x of people) {
    out.push(`### ${x.name}${x.role ? `, ${x.role}` : ""}, ${x.org}`, ``);
    out.push(`- first met ${day(x.firstSeen)}, last activity ${x.lastSeen}, conversations ${x.conversations}, recaps sent ${x.recapsSent}`);
    if (x.cards.length) out.push(`- cards shown: ${x.cards.map((c) => `${c.kind} "${c.title}": ${c.body.replace(/\n/g, " ")}`).join(" | ")}`);
    if (x.facts.length) out.push(`- facts: ${x.facts.map((f) => `${f.text} (${f.sourceUrl})`).join(" | ")}`);
    for (const dbf of x.debriefs) out.push(`- debrief (the wearer's own words): ${esc(dbf)}`);
    if (x.transcript) out.push(`- conversation transcript (recorded with consent, ${x.transcriptChars} chars): ${esc(x.transcript)}`);
    if (x.followUp) {
      out.push(`- follow-up email: ${x.followUp.subject ?? ""} / ${esc(x.followUp.body ?? "").replace(/\n+/g, " ")}`);
      if (x.followUp.message) out.push(`- follow-up message: ${x.followUp.message}`);
      if (x.followUp.nextSteps?.length) out.push(`- next steps: ${x.followUp.nextSteps.join("; ")}`);
      if (x.followUp.draftLink) out.push(`- gmail draft: ${x.followUp.draftLink}`);
    }
    if (x.schedule) {
      out.push(`- proposed times: ${(x.schedule.proposedTimes ?? []).join(", ")}${x.schedule.calendarEventCreated ? " (hold on calendar)" : ""}${x.schedule.eventLink ? ` ${x.schedule.eventLink}` : ""}`);
      if (x.schedule.schedulingMessage) out.push(`- scheduling message: ${x.schedule.schedulingMessage}`);
    }
    out.push(``);
  }
  const speech = all.filter((e) => e.type === "say" || e.type === "debrief").slice(-100).reverse();
  if (speech.length) {
    out.push(`## What the wearer said (verbatim speech, newest first)`, ``);
    for (const e of speech) {
      const who = e.person ? ` [${e.person.name}, ${e.person.org}]` : "";
      const how = e.type === "say" ? ` (heard as ${String(e.data.intent)} ${typeof e.data.confidence === "number" ? e.data.confidence.toFixed(2) : ""})` : " (debrief)";
      out.push(`- ${e.at}${who}${how}: ${esc(String(e.data.text ?? ""))}`);
    }
    out.push(``);
  }
  const messages = all.filter((e) => e.type === "recap" || e.type === "reply").slice(-60).reverse();
  if (messages.length) {
    out.push(`## iMessage (newest first)`, ``);
    for (const e of messages) {
      if (e.type === "reply") out.push(`- ${e.at} wearer texted: ${esc(String(e.data.text ?? ""))} -> Cue: ${esc((e.data.answer as string[] | undefined ?? []).join(" / "))}`);
      else out.push(`- ${e.at} Cue recap${e.person ? ` for ${e.person.name}` : ""}: ${esc((e.data.bubbles as string[] | undefined ?? []).join(" / ") || (e.data.sent ? "sent" : `not sent (${String(e.data.reason ?? "")})`))}`);
    }
    out.push(``);
  }
  const coaching = all.filter((e) => e.type === "coaching");
  if (coaching.length) {
    out.push(`## Coaching (newest first)`, ``);
    for (const e of coaching.slice(-10).reverse()) {
      const d = e.data as { summary?: string; patterns?: string[]; priorities?: { name: string; action: string }[]; coaching?: string[]; nextTime?: string };
      out.push(`### ${e.at}`, `- summary: ${d.summary ?? ""}`);
      if (d.patterns?.length) out.push(`- patterns: ${d.patterns.join(" | ")}`);
      if (d.priorities?.length) out.push(`- priorities: ${d.priorities.map((x) => `${x.name}: ${x.action}`).join(" | ")}`);
      if (d.coaching?.length) out.push(`- coaching: ${d.coaching.join(" | ")}`);
      if (d.nextTime) out.push(`- next time: ${d.nextTime}`);
      out.push(``);
    }
  }
  out.push(`## Timeline (last 200, newest first)`, ``);
  for (const e of all.slice(-200).reverse()) {
    const who = e.person ? ` ${e.person.name} (${e.person.org})` : "";
    const brief = e.type === "brief" ? ` match ${String(e.data.confidence ?? "")}` : "";
    const text = typeof e.data.text === "string" ? `: ${esc(e.data.text).slice(0, 200)}` : "";
    const goal = e.type === "goal" ? `: ${String(e.data.goal ?? "")}` : "";
    out.push(`- ${e.at} ${e.type}${who}${brief}${goal}${text}`);
  }
  return out.join("\n") + "\n";
}
