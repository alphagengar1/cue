// In-memory event store, seeded from data/sample-event.json on boot.
// Single tenant (01 section 4): one wearer, one profile, one active event.
// Swap for SQLite later if restarts losing briefs becomes a problem; the API stays the same.
import fs from "node:fs";
import path from "node:path";
import type {
  Brief, Event, Goal, Organization, Person, WearerProfile, FollowUp } from "../../shared/types.js";
import { BACKEND_DIR, config } from "./config.js";
import { cleanFacts, factAboutPerson, hostOf, sanitize, sortFacts } from "./safety.js";

export interface RunRecord {
  runId: string;
  agent: "event_loader" | "person_researcher" | "brief_writer" | "follow_up_writer" | "meeting_scheduler" | "networking_coach";
  briefId?: string;
  personId?: string;
  eventId?: string;
  status: "pending" | "completed" | "failed";
  startedAt: string;
}

interface SampleFile {
  event: Event;
  organizations: Omit<Organization, "eventId">[];
  // `facts`/`headline`/`match`/`research`: optional hand-run CREAO Person Researcher output
  // (agents/person-researcher.md, "Loading the output into Cue"). Facts go through the same checks as live research.
  people: {
    name: string; orgId: string; role?: string; headline?: string;
    facts?: unknown[]; match?: string; matchReason?: string;
    research?: { agent?: string; agentId?: string; runLink?: string; date?: string };
    followUp?: Person["followUp"];                 // hand-run CREAO Follow-up Writer output (agents/follow-up-writer.md)
  }[];
  profile?: Omit<WearerProfile, "id">;
}

/** Keep the Follow-up Writer's output to plain, bounded strings (it is pasted by hand). */
function cleanFollowUp(f: NonNullable<Person["followUp"]>): NonNullable<Person["followUp"]> {
  const str = (s: unknown, n: number) => (typeof s === "string" ? sanitize(s).trim().slice(0, n) : undefined);
  const email = f.email && typeof f.email === "object"
    ? { subject: str(f.email.subject, 120) ?? "", body: (typeof f.email.body === "string" ? f.email.body.trim().slice(0, 2500) : "") }
    : undefined;
  return {
    agent: str(f.agent, 60), agentId: str(f.agentId, 80), runLink: str(f.runLink, 200), debrief: str(f.debrief, 600),
    ...(email && email.subject && email.body ? { email } : {}),
    message: str(f.message, 400),
    nextSteps: Array.isArray(f.nextSteps) ? f.nextSteps.map((s) => str(s, 160)).filter((s): s is string => !!s).slice(0, 3) : undefined,
  };
}

export const slug = (s: string): string =>
  s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** Lowercase, alphanumerics only. Used for name/org comparisons. */
export const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

export const newId = (prefix: string): string =>
  `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

const DEFAULT_PROFILE: WearerProfile = {
  id: "me",
  name: "Wearer",
  resumeText: "",
  summary: "",
  interests: [],
  projects: [],
  goal: "internship",
};

/** A Map that reports every write, so briefs and agent runs survive a restart (Store.saveSession). */
class SavedMap<K, V> extends Map<K, V> {
  constructor(private readonly onWrite: () => void) { super(); }
  override set(k: K, v: V): this { super.set(k, v); this.onWrite(); return this; }
  override delete(k: K): boolean { const r = super.delete(k); this.onWrite(); return r; }
  override clear(): void { super.clear(); this.onWrite(); }
}

class Store {
  events = new Map<string, Event>();
  orgs = new Map<string, Organization>(); // key: `${eventId}:${orgId}`
  people = new Map<string, Person>();
  briefs = new SavedMap<string, Brief>(() => this.scheduleSessionSave());
  runs = new SavedMap<string, RunRecord>(() => this.scheduleSessionSave());
  private sessionTimer: NodeJS.Timeout | null = null;
  private sessionLoading = false;

  /** The matched person behind a brief, if any. */
  personFor(brief: Pick<Brief, "match">): Person | undefined {
    return brief.match.personId ? this.people.get(brief.match.personId) : undefined;
  }
  /** Follow-up output for a brief: its own run first, then the matched person's (hand-loaded, or an earlier conversation). */
  followUpFor(brief: Pick<Brief, "match" | "followUp">): FollowUp | undefined {
    return brief.followUp ?? this.personFor(brief)?.followUp;
  }
  seenDeliveries = new Set<string>();
  activeEventId: string | null = null;
  profile: WearerProfile = { ...DEFAULT_PROFILE };

  get goal(): Goal { return this.profile.goal; }
  set goal(g: Goal) { this.profile = { ...this.profile, goal: g }; }

  activeEvent(): Event | null {
    return this.activeEventId ? this.events.get(this.activeEventId) ?? null : null;
  }

  eventOrgs(eventId: string | null = this.activeEventId): Organization[] {
    if (!eventId) return [];
    return [...this.orgs.values()].filter((o) => o.eventId === eventId);
  }

  eventPeople(eventId: string | null = this.activeEventId): Person[] {
    if (!eventId) return [];
    return [...this.people.values()].filter((p) => p.eventId === eventId);
  }

  getOrg(eventId: string, orgId: string): Organization | undefined {
    return this.orgs.get(`${eventId}:${orgId}`);
  }

  putOrg(o: Organization): void { this.orgs.set(`${o.eventId}:${o.id}`, o); }

  putPerson(p: Person): void { this.people.set(p.id, p); }

  /** Upsert a person by (event, org, normalized name). Returns the stored record. */
  upsertPerson(eventId: string, orgId: string, name: string, patch: Partial<Person> = {}): Person {
    const existing = this.eventPeople(eventId).find(
      (p) => p.orgId === orgId && norm(p.name) === norm(name),
    );
    const base: Person = existing ?? {
      id: `per_${slug(`${orgId}-${name}`)}`,
      eventId, orgId, name,
      facts: [], match: "low", matchReason: "",
    };
    const next = { ...base, ...patch, id: base.id, eventId, orgId };
    this.putPerson(next);
    return next;
  }

  /** Most recently created or updated brief (setup page mirror). */
  // Wearer profile and goal survive restarts (data/profile.local.json, gitignored). Everything else
  // is in memory on purpose: briefs and transcripts are for the day.
  saveLocal(): void {
    try {
      fs.mkdirSync(path.dirname(LOCAL_STATE_FILE), { recursive: true });
      fs.writeFileSync(LOCAL_STATE_FILE, JSON.stringify({ profile: this.profile, goal: this.goal, activeEventId: this.activeEventId }, null, 2));
    } catch (err) {
      console.warn(`[store] could not save local state: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  /**
   * Events built at runtime (setup page or "I'm going to X tomorrow" over iMessage) and the facts
   * researched for their people persist as data/events/<id>.local.json, in the same shape as a
   * bundled event file, so a restart before the demo loses nothing.
   */
  saveEventFile(eventId: string | null = this.activeEventId): string | null {
    const ev = eventId ? this.events.get(eventId) : undefined;
    if (!ev) return null;
    const file = path.join(LOCAL_EVENTS_DIR, `${ev.id}.local.json`);
    const organizations = this.eventOrgs(ev.id).map(({ eventId: _e, ...o }) => o);
    const people = this.eventPeople(ev.id).filter((p) => p.fromEventList || p.confirmed || p.facts.length).map((p) => ({
      name: p.name, orgId: p.orgId, role: p.role, headline: p.headline, facts: p.facts, match: p.match,
      ...(p.followUp ? { followUp: p.followUp } : {}),
    }));
    try {
      fs.mkdirSync(LOCAL_EVENTS_DIR, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ event: ev, organizations, people }, null, 2));
      return file;
    } catch (err) {
      console.warn(`[store] could not save event ${ev.id}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
  /** Load every saved runtime event (boot). Returns the ids loaded; the active event is restored by loadLocal(). */
  loadLocalEvents(): string[] {
    let names: string[] = [];
    try { names = fs.readdirSync(LOCAL_EVENTS_DIR).filter((f) => f.endsWith(".local.json")); } catch { return []; }
    const ids: string[] = [];
    const keepActive = this.activeEventId;
    for (const f of names) {
      try { ids.push(this.loadSample(path.join(LOCAL_EVENTS_DIR, f), { withProfile: false }).id); }
      catch (err) { console.warn(`[store] could not load ${f}: ${err instanceof Error ? err.message : String(err)}`); }
    }
    this.activeEventId = keepActive;
    if (ids.length) console.log(`[store] runtime events loaded: ${ids.join(", ")}`);
    return ids;
  }

  loadLocal(): boolean {
    try {
      if (!fs.existsSync(LOCAL_STATE_FILE)) return false;
      const j = JSON.parse(fs.readFileSync(LOCAL_STATE_FILE, "utf8")) as { profile?: Partial<WearerProfile>; goal?: Goal; activeEventId?: string };
      if (j.profile?.name) this.profile = { ...DEFAULT_PROFILE, ...j.profile, id: "me" };
      if (j.goal) this.goal = j.goal;
      if (j.activeEventId && this.events.has(j.activeEventId)) this.activeEventId = j.activeEventId;
      console.log(`[store] local state loaded (${this.profile.name}, goal ${this.goal})`);
      return true;
    } catch (err) {
      console.warn(`[store] could not load local state: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * Briefs and agent runs are written to data/session.local.json shortly after every change, so a restart
   * (every deploy) keeps the conversation on the glasses and the pending follow-up. Debounced; one file.
   */
  scheduleSessionSave(): void {
    if (this.sessionLoading || this.sessionTimer) return;
    this.sessionTimer = setTimeout(() => { this.sessionTimer = null; this.saveSession(); }, 250);
    this.sessionTimer.unref();
  }
  saveSession(): void {
    try {
      fs.mkdirSync(path.dirname(LOCAL_SESSION_FILE), { recursive: true });
      const briefs = [...this.briefs.values()].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).slice(-200);
      const runs = [...this.runs.values()].slice(-300);
      fs.writeFileSync(LOCAL_SESSION_FILE, JSON.stringify({ savedAt: new Date().toISOString(), briefs, runs }));
    } catch (err) {
      console.warn(`[store] could not save session: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  loadSession(): { briefs: number; pendingRuns: number } {
    try {
      if (!fs.existsSync(LOCAL_SESSION_FILE)) return { briefs: 0, pendingRuns: 0 };
      const j = JSON.parse(fs.readFileSync(LOCAL_SESSION_FILE, "utf8")) as { briefs?: Brief[]; runs?: RunRecord[] };
      this.sessionLoading = true;
      try {
        for (const b of j.briefs ?? []) if (b?.id) this.briefs.set(b.id, b);
        for (const r of j.runs ?? []) if (r?.runId) this.runs.set(r.runId, r);
      } finally { this.sessionLoading = false; }
      const pendingRuns = [...this.runs.values()].filter((r) => r.status === "pending").length;
      console.log(`[store] session loaded: ${this.briefs.size} briefs, ${this.runs.size} runs (${pendingRuns} pending)`);
      return { briefs: this.briefs.size, pendingRuns };
    } catch (err) {
      console.warn(`[store] could not load session: ${err instanceof Error ? err.message : String(err)}`);
      return { briefs: 0, pendingRuns: 0 };
    }
  }

  latestBrief(): Brief | null {
    let best: Brief | null = null;
    for (const b of this.briefs.values()) if (!best || b.updatedAt >= best.updatedAt) best = b;
    return best;
  }

  /**
   * Load an event file (data/*.json). Replaces that event's orgs and people (two files may share an
   * event id). `withProfile: false` keeps the wearer profile pasted on the setup page.
   */
  loadSample(file = config.sampleEventFile, opts: { withProfile?: boolean } = {}): Event {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as SampleFile;
    const ev = raw.event;
    this.events.set(ev.id, ev);
    this.activeEventId = ev.id;
    for (const [k, o] of this.orgs) if (o.eventId === ev.id) this.orgs.delete(k);
    for (const [k, p] of this.people) if (p.eventId === ev.id) this.people.delete(k);
    for (const o of raw.organizations) this.putOrg({ ...o, eventId: ev.id });
    for (const p of raw.people ?? []) {
      const org = this.getOrg(ev.id, p.orgId) ?? null;
      const labels = [org?.name ?? "", ...(org?.aliases ?? []), p.orgId].filter(Boolean);
      const hosts = (org?.focusNow ?? []).map((f) => hostOf(f.sourceUrl)).filter(Boolean);
      const given = Array.isArray(p.facts) ? p.facts.length : 0;
      const facts = sortFacts(cleanFacts(p.facts, 8, "article").filter((f) => factAboutPerson(f, p.name, labels, hosts)));
      if (given && facts.length < given) {
        console.warn(`[store] ${p.name}: kept ${facts.length}/${given} researched facts (need http(s) source, name + org, no sensitive/LinkedIn)`);
      }
      this.upsertPerson(ev.id, p.orgId, p.name, {
        role: p.role,
        ...(p.headline ? { headline: sanitize(p.headline).trim().slice(0, 120) } : {}),
        facts,
        match: "high",
        matchReason: facts.length
          ? `on the event list; ${facts.length} researched fact(s) (${p.research?.agent ?? "event file"})`
          : "on the event list",
        fromEventList: true,
        // Hand-run research present: don't start a paid Person Researcher run for them again.
        // Hand-loaded research is the "night before" pack. The live Person Researcher still runs once per
        // person (the demo moment is the cards updating); RESEARCH_LOADED_PEOPLE=0 keeps the old skip.
        ...(p.research && facts.length && process.env.RESEARCH_LOADED_PEOPLE === "0" ? { lastResearchedAt: p.research.date ?? new Date().toISOString() } : {}),
        ...(p.followUp ? { followUp: cleanFollowUp(p.followUp) } : {}),
      });
    }
    if (raw.profile && opts.withProfile !== false) this.profile = { ...raw.profile, id: "me" };
    return ev;
  }
}

const LOCAL_STATE_FILE = path.resolve(BACKEND_DIR, process.env.LOCAL_STATE_FILE?.trim() || "data/profile.local.json");
const LOCAL_EVENTS_DIR = path.resolve(BACKEND_DIR, process.env.LOCAL_EVENTS_DIR?.trim() || "data/events");
const LOCAL_SESSION_FILE = path.resolve(BACKEND_DIR, process.env.LOCAL_SESSION_FILE?.trim() || "data/session.local.json");

export const store = new Store();
