// Creating an event: the setup page (POST /api/events) and iMessage ("hey, I'm going to LA Hacks
// tomorrow") share this path. It stores the event and any orgs/people given, then starts the CREAO
// Research agent (EVENT request) to build the pack: sponsors, employers, speakers, what each org is
// focused on, who is hiring. The agent searches the web for the event when no orgs were given.
import type { Event, Organization } from "../../shared/types.js";
import { startRun } from "./creao.js";
import { journal } from "./journal.js";
import { newId, slug, store } from "./store.js";

export interface CreateEventInput {
  name: string;
  date: string;
  orgs?: string[];
  people?: { name: string; org: string; role?: string }[];
  sourceText?: string;
  organizations?: (Omit<Organization, "eventId" | "id"> & { id?: string })[];
}

export async function createEvent(b: CreateEventInput, opts: { via?: "setup" | "imessage" } = {}): Promise<Event> {
  const id = slug(b.name) || newId("evt");
  const event: Event = {
    id, name: b.name, date: b.date,
    sources: [
      ...(b.sourceText ? [{ kind: "employers" as const, raw: b.sourceText }] : []),
      ...(opts.via === "imessage" ? [{ kind: "imessage" as const, raw: b.sourceText ?? b.name }] : []),
    ],
    loadStatus: "empty",
  };
  store.events.set(id, event);
  store.activeEventId = id;

  const orgs: Organization[] = (b.organizations ?? []).map((o) => ({ ...o, id: o.id ?? slug(o.name), eventId: id }));
  for (const name of b.orgs ?? []) {
    if (!orgs.some((o) => o.id === slug(name))) {
      orgs.push({ id: slug(name), eventId: id, name, aliases: [], oneLiner: "", focusNow: [], people: [] });
    }
  }
  for (const o of orgs) store.putOrg(o);
  for (const p of b.people ?? []) {
    store.upsertPerson(id, slug(p.org), p.name, { role: p.role, match: "high", matchReason: "on the event list", fromEventList: true });
  }
  if (b.organizations?.length) event.loadStatus = "ready";
  journal({ type: "event", data: { id, name: b.name, date: b.date, via: opts.via ?? "setup", orgs: b.orgs ?? [], people: (b.people ?? []).length } });

  const runId = await startRun("event_loader", {
    eventId: id, eventName: b.name, orgs: b.orgs ?? [], people: b.people ?? [], sourceText: b.sourceText ?? "",
  }, { eventId: id });
  if (runId) { event.loadStatus = "loading"; event.creaoRunId = runId; }
  return event;
}

/** "hey, I'm going to LA Hacks tomorrow" -> { name, date, orgs } without a model (the model version is in compose.ts). */
export function parseEventText(text: string, now = new Date()): { name: string; date: string; orgs: string[] } | null {
  const t = text.replace(/\s+/g, " ").trim();
  const m = /\b(?:going to|heading to|headed to|attending|i(?:'| a)?m at|i'?ll be at|at)\s+(?:the\s+)?(.+?)(?=\s+(?:tomorrow|tonight|today|this|next|on|at|in)\b|[.!?,]|$)/i.exec(t);
  if (!m) return null;
  let name = m[1].trim();
  name = name.replace(/\b(event|hackathon|career fair|fair|conference|meetup|summit|mixer)$/i, (w) => w).trim();
  if (name.length < 3 || /^(a|an|the|it)$/i.test(name)) return null;
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const plus = (n: number) => { const d = new Date(now); d.setDate(d.getDate() + n); return day(d); };
  const date = /\btomorrow\b/i.test(t) ? plus(1) : /\b(today|tonight)\b/i.test(t) ? day(now) : /\bday after tomorrow\b/i.test(t) ? plus(2) : "";
  const orgs = [...t.matchAll(/\b(?:sponsors?|with|from|companies like)\s+([A-Z][\w.&-]*(?:\s+[A-Z][\w.&-]*)*(?:\s*,\s*[A-Z][\w.&-]*(?:\s+[A-Z][\w.&-]*)*)*)/g)]
    .flatMap((x) => x[1].split(/\s*,\s*|\s+and\s+/)).map((s) => s.trim()).filter((s) => s.length > 1).slice(0, 10);
  return { name: name.replace(/^[\s"']+|[\s"']+$/g, ""), date, orgs };
}
