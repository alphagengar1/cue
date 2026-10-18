// In-memory event store, seeded from data/sample-event.json on boot.
// Single tenant (01 section 4): one wearer, one profile, one active event.
// Swap for SQLite later if restarts losing briefs becomes a problem; the API stays the same.
import fs from "node:fs";
import type {
  Brief, Event, Goal, Organization, Person, WearerProfile,
} from "../../shared/types.js";
import { config } from "./config.js";

export interface RunRecord {
  runId: string;
  agent: "event_loader" | "person_researcher" | "brief_writer";
  briefId?: string;
  personId?: string;
  eventId?: string;
  status: "pending" | "completed" | "failed";
  startedAt: string;
}

interface SampleFile {
  event: Event;
  organizations: Omit<Organization, "eventId">[];
  people: { name: string; orgId: string; role?: string }[];
  profile?: Omit<WearerProfile, "id">;
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

class Store {
  events = new Map<string, Event>();
  orgs = new Map<string, Organization>(); // key: `${eventId}:${orgId}`
  people = new Map<string, Person>();
  briefs = new Map<string, Brief>();
  runs = new Map<string, RunRecord>();
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
  latestBrief(): Brief | null {
    let best: Brief | null = null;
    for (const b of this.briefs.values()) if (!best || b.updatedAt >= best.updatedAt) best = b;
    return best;
  }

  /** Load an event file (data/*.json). `withProfile: false` keeps the wearer profile pasted on the setup page. */
  loadSample(file = config.sampleEventFile, opts: { withProfile?: boolean } = {}): Event {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as SampleFile;
    const ev = raw.event;
    this.events.set(ev.id, ev);
    this.activeEventId = ev.id;
    for (const o of raw.organizations) this.putOrg({ ...o, eventId: ev.id });
    for (const p of raw.people) {
      this.upsertPerson(ev.id, p.orgId, p.name, {
        role: p.role,
        match: "high",
        matchReason: "on the event list",
      });
    }
    if (raw.profile && opts.withProfile !== false) this.profile = { ...raw.profile, id: "me" };
    return ev;
  }
}

export const store = new Store();
