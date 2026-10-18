// Google Calendar for the Meeting Scheduler (agents/meeting-scheduler.md, "Google Calendar").
// The backend owns the calendar, not the CREAO agent: before the scheduler runs it reads the
// wearer's free/busy for the next 10 days and hands the free windows to the agent inside the
// availability text; when the agent answers it drops any proposed time that collides with the
// calendar and places the tentative 30-minute hold itself (no attendees, ever). "book 2" moves it.
// Raw REST over fetch with an OAuth refresh token, no SDK. Off until the three GOOGLE_* vars are
// set; every call has a timeout and every caller keeps the agent's own output on any error, so the
// calendar can never block a text. Get the refresh token once with `npm run google:auth`.
import { config } from "./config.js";

export const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
];
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/calendar/v3";
const HTTP_TIMEOUT_MS = 6000;
export const HOLD_MINUTES = 30;
export const LOOKAHEAD_DAYS = 10;

const env = (k: string): string | undefined => process.env[k]?.trim() || undefined;
const parseHours = (s: string | undefined): [number, number] => {
  const m = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(s ?? "");
  const a = m ? Number(m[1]) : 10, b = m ? Number(m[2]) : 18;
  return a >= 0 && b <= 24 && a < b ? [a, b] : [10, 18];
};

/** Mutable on purpose: tests set the fields; the server fills them from the environment once. */
export const calendarConfig = {
  clientId: env("GOOGLE_CLIENT_ID"),
  clientSecret: env("GOOGLE_CLIENT_SECRET"),
  refreshToken: env("GOOGLE_REFRESH_TOKEN"),
  calendarId: env("GOOGLE_CALENDAR_ID") ?? "primary",
  // Hours of the day the wearer would take a call, in the wearer's timezone ("10-18"). The agent
  // still reads the wearer's own words ("not Tuesdays") on top of this.
  hours: parseHours(env("WEARER_HOURS")),
  weekdaysOnly: env("WEARER_WEEKENDS") !== "1",
  timezone: config.wearerTimezone,
};
export const calendarConfigured = (): boolean =>
  Boolean(calendarConfig.clientId && calendarConfig.clientSecret && calendarConfig.refreshToken);

// ---------------------------------------------------------------------------
// Wall-clock time in a zone, without a date library
// ---------------------------------------------------------------------------

export interface Wall { y: number; mo: number; d: number; h: number; mi: number; dow: number }
const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const fmts = new Map<string, Intl.DateTimeFormat>();
const fmt = (tz: string): Intl.DateTimeFormat => {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", weekday: "short",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    });
    fmts.set(tz, f);
  }
  return f;
};

/** The wall clock in `tz` at instant `at`. */
export function wallClock(at: Date, tz: string): Wall {
  const p: Record<string, string> = {};
  for (const { type, value } of fmt(tz).formatToParts(at)) p[type] = value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, dow: DOW[p.weekday] ?? 0 };
}

const offsetMin = (at: Date, tz: string): number => {
  const w = wallClock(at, tz);
  return (Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) - Math.floor(at.getTime() / 60000) * 60000) / 60000;
};

/** The instant at which `tz` shows this wall clock (day may overflow the month, like Date.UTC). */
export function fromWallClock(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  let t = asUtc - offsetMin(new Date(asUtc), tz) * 60000;
  const again = asUtc - offsetMin(new Date(t), tz) * 60000; // second pass across a DST edge
  if (again !== t) t = again;
  return new Date(t);
}

const pad = (n: number): string => String(n).padStart(2, "0");
export interface Span { start: Date; end: Date }

/** "2026-10-21 14:00-14:30" in `tz`: the format the Meeting Scheduler speaks. */
export function slotString(span: Span, tz: string): string {
  const a = wallClock(span.start, tz), b = wallClock(span.end, tz);
  return `${a.y}-${pad(a.mo)}-${pad(a.d)} ${pad(a.h)}:${pad(a.mi)}-${pad(b.h)}:${pad(b.mi)}`;
}
export function parseSlot(s: string, tz: string): Span | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const [y, mo, d, h1, m1, h2, m2] = m.slice(1).map(Number);
  const start = fromWallClock(y, mo, d, h1, m1, tz);
  let end = fromWallClock(y, mo, d, h2, m2, tz);
  if (end <= start) end = fromWallClock(y, mo, d + 1, h2, m2, tz);
  return { start, end };
}

// ---------------------------------------------------------------------------
// Pure scheduling
// ---------------------------------------------------------------------------

const overlaps = (a: Span, b: Span): boolean => a.start < b.end && b.start < a.end;
export const conflicts = (span: Span, busy: Span[]): boolean => busy.some((b) => overlaps(span, b));

const HALF_HOUR = 30 * 60000;
const ceilHalf = (t: number): number => Math.ceil(t / HALF_HOUR) * HALF_HOUR;
const floorHalf = (t: number): number => Math.floor(t / HALF_HOUR) * HALF_HOUR;

/**
 * Free windows of at least `minMinutes` inside the wearer's hours, tomorrow through `days` days out,
 * with the busy spans cut out and edges snapped to the half hour.
 */
export function freeWindows(busy: Span[], opts: {
  now: Date; tz: string; hours?: [number, number]; days?: number; weekdaysOnly?: boolean; minMinutes?: number;
}): Span[] {
  const { now, tz } = opts;
  const [h0, h1] = opts.hours ?? calendarConfig.hours;
  const days = opts.days ?? LOOKAHEAD_DAYS;
  const weekdaysOnly = opts.weekdaysOnly ?? calendarConfig.weekdaysOnly;
  const min = (opts.minMinutes ?? HOLD_MINUTES) * 60000;
  const sorted = [...busy].sort((a, b) => a.start.getTime() - b.start.getTime());
  const today = wallClock(now, tz);
  const out: Span[] = [];
  for (let day = 1; day <= days; day++) {
    const dayStart = fromWallClock(today.y, today.mo, today.d + day, h0, 0, tz);
    const dayEnd = fromWallClock(today.y, today.mo, today.d + day, h1, 0, tz);
    if (weekdaysOnly) { const dow = wallClock(dayStart, tz).dow; if (dow === 0 || dow === 6) continue; }
    let cursor = dayStart.getTime();
    for (const b of sorted) {
      if (b.end.getTime() <= cursor || b.start >= dayEnd) continue;
      const free = { start: new Date(ceilHalf(cursor)), end: new Date(floorHalf(b.start.getTime())) };
      if (free.end.getTime() - free.start.getTime() >= min) out.push(free);
      cursor = Math.max(cursor, b.end.getTime());
    }
    const tail = { start: new Date(ceilHalf(cursor)), end: new Date(floorHalf(dayEnd.getTime())) };
    if (tail.end.getTime() - tail.start.getTime() >= min) out.push(tail);
  }
  return out;
}

/** The free windows as the agent reads them: "2026-10-21 14:00-17:00, 2026-10-22 10:00-12:30". */
export const describeFree = (windows: Span[], tz: string, max = 14): string =>
  windows.slice(0, max).map((w) => slotString(w, tz)).join(", ");

// ---------------------------------------------------------------------------
// Google Calendar REST
// ---------------------------------------------------------------------------

let fetchFn: typeof fetch = (input, init) => globalThis.fetch(input, init);
/** Tests swap the transport; nothing else should. */
export function __setFetchForTests(f: typeof fetch | null): void { fetchFn = f ?? ((i, n) => globalThis.fetch(i, n)); }

let token: { value: string; expiresAt: number } | null = null;
export function __resetTokenForTests(): void { token = null; }

async function call<T>(url: string, init: RequestInit & { auth?: boolean } = {}): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
    if (init.auth !== false) headers.Authorization = `Bearer ${await accessToken()}`;
    const res = await fetchFn(url, { ...init, headers, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`google ${res.status}: ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : {}) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function accessToken(): Promise<string> {
  if (token && token.expiresAt > Date.now() + 30_000) return token.value;
  const body = new URLSearchParams({
    client_id: calendarConfig.clientId ?? "", client_secret: calendarConfig.clientSecret ?? "",
    refresh_token: calendarConfig.refreshToken ?? "", grant_type: "refresh_token",
  });
  const r = await call<{ access_token: string; expires_in?: number }>(TOKEN_URL, {
    method: "POST", auth: false, headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
  token = { value: r.access_token, expiresAt: Date.now() + (r.expires_in ?? 3600) * 1000 };
  return token.value;
}

/** Busy spans on the wearer's calendar between two instants. */
export async function freeBusy(from: Date, to: Date): Promise<Span[]> {
  const r = await call<{ calendars?: Record<string, { busy?: { start: string; end: string }[] }> }>(`${API}/freeBusy`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ timeMin: from.toISOString(), timeMax: to.toISOString(), timeZone: calendarConfig.timezone, items: [{ id: calendarConfig.calendarId }] }),
  });
  const busy = r.calendars?.[calendarConfig.calendarId]?.busy ?? Object.values(r.calendars ?? {})[0]?.busy ?? [];
  return busy.map((b) => ({ start: new Date(b.start), end: new Date(b.end) })).filter((b) => !Number.isNaN(b.start.getTime()));
}

export interface Hold { id: string; link: string }
/** One tentative event on the wearer's own calendar. No attendees: Cue never invites the other person. */
export async function createHold(h: Span & { title: string; description: string }): Promise<Hold> {
  const tz = calendarConfig.timezone;
  const r = await call<{ id: string; htmlLink?: string }>(`${API}/calendars/${encodeURIComponent(calendarConfig.calendarId)}/events`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      summary: h.title, description: h.description, status: "tentative",
      start: { dateTime: h.start.toISOString(), timeZone: tz }, end: { dateTime: h.end.toISOString(), timeZone: tz },
      reminders: { useDefault: true },
    }),
  });
  return { id: r.id, link: r.htmlLink ?? "" };
}

export async function deleteHold(id: string): Promise<void> {
  await call(`${API}/calendars/${encodeURIComponent(calendarConfig.calendarId)}/events/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// What creao.ts and recap.ts call
// ---------------------------------------------------------------------------

export interface Schedule {
  proposedTimes: string[]; inviteTitle: string; inviteDescription: string; schedulingMessage: string;
  calendarEventCreated: boolean; eventLink: string | null; holdEventId?: string; holdSource?: "agent" | "backend";
}

const warn = (what: string, err: unknown): void =>
  console.warn(`[calendar] ${what}: ${err instanceof Error ? err.message : String(err)}`);

/**
 * The availability text the Meeting Scheduler gets: the wearer's own words, plus the free windows
 * from their Google Calendar when it is connected. The agent's input contract is unchanged.
 */
export async function availabilityWithCalendar(text: string, now = new Date()): Promise<string> {
  if (!calendarConfigured()) return text;
  try {
    const tz = calendarConfig.timezone;
    const from = now, to = new Date(now.getTime() + (LOOKAHEAD_DAYS + 1) * 86400000);
    const windows = freeWindows(await freeBusy(from, to), { now, tz });
    if (!windows.length) return `${text}. Google Calendar shows no free ${HOLD_MINUTES}-minute window in the next ${LOOKAHEAD_DAYS} days; propose times anyway and say they are tentative`;
    return `${text}. Free windows from Google Calendar in ${tz}, pick the three slots from inside these: ${describeFree(windows, tz)}`;
  } catch (err) {
    warn("free/busy lookup failed, sending the wearer's words only", err);
    return text;
  }
}

/**
 * After the agent answers: drop proposed times that collide with the calendar, and place the hold
 * at the first remaining time if the agent did not. Returns the schedule to store and a log note.
 */
export async function confirmSchedule(schedule: Schedule, now = new Date()): Promise<{ schedule: Schedule; note: string }> {
  if (!calendarConfigured()) return { schedule, note: "calendar off" };
  const tz = calendarConfig.timezone;
  const spans = schedule.proposedTimes.map((t) => ({ t, span: parseSlot(t, tz) }));
  const parsed = spans.filter((s): s is { t: string; span: Span } => Boolean(s.span) && s.span!.start > now);
  if (!parsed.length) return { schedule, note: "calendar: no parseable future times" };
  try {
    const from = new Date(Math.min(...parsed.map((p) => p.span.start.getTime())));
    const to = new Date(Math.max(...parsed.map((p) => p.span.end.getTime())));
    const busy = await freeBusy(from, to);
    const kept = parsed.filter((p) => !conflicts(p.span, busy));
    const dropped = parsed.length - kept.length;
    let next: Schedule = { ...schedule, proposedTimes: kept.map((p) => p.t) };
    let note = dropped ? `calendar: dropped ${dropped} busy time${dropped === 1 ? "" : "s"}` : "calendar: all times free";
    if (!kept.length) return { schedule: next, note: `${note}, no hold` };
    if (!schedule.calendarEventCreated) {
      const hold = await createHold({ ...kept[0].span, title: schedule.inviteTitle, description: schedule.inviteDescription });
      next = { ...next, calendarEventCreated: true, eventLink: hold.link || next.eventLink, holdEventId: hold.id, holdSource: "backend" };
      note += `, hold placed at ${kept[0].t}`;
    } else {
      note += ", hold from the agent kept";
    }
    return { schedule: next, note };
  } catch (err) {
    warn("confirm failed, keeping the agent's schedule", err);
    return { schedule, note: "calendar: error, agent schedule kept" };
  }
}

/** "book 2": move the backend's hold to that proposed time (1-based). The agent's own hold is left alone. */
export async function moveHold(schedule: Schedule, index: number): Promise<{ schedule: Schedule; moved: boolean; reason?: string }> {
  if (schedule.holdSource === "agent" || (schedule.calendarEventCreated && !schedule.holdEventId)) {
    return { schedule, moved: false, reason: "the agent placed that hold, drag it in google calendar" };
  }
  if (!calendarConfigured()) return { schedule, moved: false, reason: "google calendar isn't connected to the backend" };
  const t = schedule.proposedTimes[index - 1];
  const span = t ? parseSlot(t, calendarConfig.timezone) : null;
  if (!span) return { schedule, moved: false, reason: `there is no time ${index}` };
  try {
    if (schedule.holdEventId && schedule.holdSource === "backend") {
      try { await deleteHold(schedule.holdEventId); } catch (err) { warn("old hold not deleted", err); }
    }
    const hold = await createHold({ ...span, title: schedule.inviteTitle, description: schedule.inviteDescription });
    const times = [t, ...schedule.proposedTimes.filter((x) => x !== t)];
    return { schedule: { ...schedule, proposedTimes: times, calendarEventCreated: true, eventLink: hold.link || schedule.eventLink, holdEventId: hold.id, holdSource: "backend" }, moved: true };
  } catch (err) {
    warn("move failed", err);
    return { schedule, moved: false, reason: "google calendar didn't answer" };
  }
}

/** Which proposed time "book 2", "book the second" or "book thu" means; null for plain "book". */
export function pickSlot(text: string, proposedTimes: string[], tz = calendarConfig.timezone): number | null {
  const t = text.trim().toLowerCase();
  const n = /\b(?:book|hold)\s+(?:the\s+)?(?:#\s*)?([1-3]|first|second|third|1st|2nd|3rd)\b/.exec(t);
  if (n) return { "1": 1, first: 1, "1st": 1, "2": 2, second: 2, "2nd": 2, "3": 3, third: 3, "3rd": 3 }[n[1]] ?? null;
  const names = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const day = /\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/.exec(t.replace(/^\s*book\b/, ""));
  if (!day) return null;
  const dow = names.indexOf(day[1]);
  const i = proposedTimes.findIndex((s) => { const p = parseSlot(s, tz); return p ? wallClock(p.start, tz).dow === dow : false; });
  return i >= 0 ? i + 1 : null;
}
