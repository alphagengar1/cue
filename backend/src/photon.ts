// Photon iMessage recap (design/photon-notes.md). Optional add-on, disabled by default.
// - sendRecap(brief): texts the WEARER (never the person they met) a <= 600 char recap over a
//   Spectrum Cloud iMessage line: who, the 3 cards, a suggested follow-up, and the sources.
// - Every outbound message is at most MAX_SEND_BUBBLES bubbles (foldBubbles): anything past the
//   third is folded into the third, one line per bubble, still under 1500 characters.
// - startReplyListener(handler): optional inbound loop; only text from WEARER_PHONE reaches handler.
// - Not configured (no PHOTON_PROJECT_ID / PHOTON_PROJECT_SECRET / WEARER_PHONE, or SDK not
//   installed): every call logs once and returns { sent: false }. Never throws.
// SDK: @spectrum-ts/core + @spectrum-ts/imessage (Stable docs, https://photon.codes/docs). They are
// loaded with a dynamic import so this file typechecks and runs before they are installed.
import type { Brief } from "../../shared/types.js";
import { store } from "./store.js";

const env = (k: string): string | undefined => process.env[k]?.trim() || undefined;

export const photonConfig = {
  enabled: env("PHOTON_ENABLED") !== "0",
  projectId: env("PHOTON_PROJECT_ID") ?? env("SPECTRUM_PROJECT_ID"),
  projectSecret: env("PHOTON_PROJECT_SECRET") ?? env("SPECTRUM_PROJECT_SECRET"),
  wearerPhone: env("WEARER_PHONE"), // E.164, e.g. +13105551234; must be a "user" on the Photon project
  maxChars: 600,
  minGapMs: 5_000, // pacing: Photon flags bursty lines; one recap per conversation is plenty
};

export const photonConfigured = (): boolean =>
  photonConfig.enabled && !!photonConfig.projectId && !!photonConfig.projectSecret && !!photonConfig.wearerPhone;

// ---------------------------------------------------------------------------
// Formatting (pure, testable without Photon)
// ---------------------------------------------------------------------------

const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`;
};

/** Like clip but keeps line breaks: iMessage replies (emails!) must not arrive as one blob. */
export const clipText = (s: string, n: number): string => {
  const t = s.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`;
};

/** The most bubbles one outbound iMessage may have; the rest fold into the last one. */
export const MAX_SEND_BUBBLES = 3;

/**
 * Cap a message at `max` bubbles: the first `max - 1` stay as they are, everything from the
 * `max`th on is joined with newlines into one last bubble, clipped to `chars` like every bubble.
 */
export function foldBubbles(bubbles: string[], max = MAX_SEND_BUBBLES, chars = 1500): string[] {
  const clean = bubbles.map((b) => clipText(b, chars)).filter(Boolean);
  if (clean.length <= max) return clean;
  return [...clean.slice(0, max - 1), clipText(clean.slice(max - 1).join("\n"), chars)];
}

const LABEL: Record<string, string> = { connect: "Connect", context: "Context", angle: "Ask" };

/** Template follow-up; the wearer can reply "draft a follow-up email" for a longer one. */
export function suggestFollowUp(brief: Brief): string {
  const first = brief.query.name.split(/\s+/)[0] || "there";
  const event = store.events.get(brief.eventId)?.name;
  const at = event ? ` at ${event}` : "";
  const topic = brief.cards.find((c) => c.kind === "connect") ?? brief.cards.find((c) => c.kind === "context");
  const hook = topic ? ` I'd love to keep talking about ${clip(topic.title, 40)}.` : "";
  return `Hi ${first}, great meeting you${at}!${hook} Open to a quick chat next week?`;
}

/** Recap text, hard-capped at photonConfig.maxChars. Drops card detail before dropping sources. */
export function formatRecap(brief: Brief, followUp = suggestFollowUp(brief)): string {
  const q = brief.query;
  const who = [q.name, q.role, q.org].filter(Boolean).join(", ");
  const sources = [...new Set(brief.cards.map((c) => c.source).filter((s): s is string => !!s))];
  const build = (bodyLen: number): string =>
    [
      `Cue recap: ${who}`,
      ...brief.cards.map((c) => `${LABEL[c.kind] ?? c.kind}: ${clip(c.body, bodyLen)}`),
      `Follow-up: "${clip(followUp, 180)}"`,
      sources.length ? `Sources: ${sources.join(", ")}` : "",
      `Reply "email" for a follow-up email draft.`,
    ].filter(Boolean).join("\n");
  for (const n of [140, 110, 80, 60, 40]) {
    const text = build(n);
    if (text.length <= photonConfig.maxChars) return text;
  }
  return clip(build(40), photonConfig.maxChars);
}

// ---------------------------------------------------------------------------
// Spectrum client (lazy, one instance per process)
// ---------------------------------------------------------------------------

// Minimal structural types for the parts of spectrum-ts we use (checked against @spectrum-ts/* 12.10.1).
interface SpSpace { send(text: string): Promise<unknown> }
interface SpMessage {
  id: string; platform: string; direction?: "inbound" | "outbound";
  sender?: { id: string };
  content: { type: string; text?: string };
}
interface SpApp { messages: AsyncIterable<[SpSpace, SpMessage]>; stop(): Promise<void> }
interface SpIMessage {
  user(address: string): Promise<unknown>;
  space: { create(user: unknown): Promise<SpSpace> };
}
type ImessageExport = ((app: SpApp) => SpIMessage) & { config(): unknown };

let appPromise: Promise<{ app: SpApp; im: SpIMessage } | null> | null = null;
let warned = false;

function skip(reason: string): { sent: false; reason: string } {
  if (!warned) console.log(`[photon] disabled: ${reason}`);
  warned = true;
  return { sent: false, reason };
}

async function client(): Promise<{ app: SpApp; im: SpIMessage } | null> {
  appPromise ??= (async () => {
    try {
      // Variable specifiers keep tsc from resolving packages that may not be installed yet.
      const coreName = "@spectrum-ts/core";
      const imName = "@spectrum-ts/imessage";
      const core = (await import(coreName)) as { Spectrum: (o: unknown) => Promise<SpApp> };
      const { imessage } = (await import(imName)) as { imessage: ImessageExport };
      const app = await core.Spectrum({
        projectId: photonConfig.projectId,
        projectSecret: photonConfig.projectSecret,
        providers: [imessage.config()],
      });
      console.log("[photon] connected");
      return { app, im: imessage(app) };
    } catch (err) {
      console.warn(`[photon] init failed: ${err instanceof Error ? err.message : String(err)}`);
      appPromise = null; // allow a retry on the next call
      return null;
    }
  })();
  return appPromise;
}

const digits = (s: string): string => s.replace(/\D/g, "");
/** Same number, tolerant of formatting and a missing US "+1". */
const samePhone = (a: string, b: string): boolean => {
  const x = digits(a), y = digits(b);
  return !!x && !!y && (x === y || x.slice(-10) === y.slice(-10));
};

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

const sentKeys = new Set<string>(); // `${briefId}:v${version}`, dedupes repeat triggers
let lastSentAt = 0;
let wearerSpace: SpSpace | null = null;
/** Brief the wearer's most recent recap was about; reply handlers use it for "email" etc. */
export let lastRecapBriefId: string | null = null;
/** A texted "look up X" moves the conversation to X without a recap: replies now refer to X. */
export function setLastRecapBriefId(id: string | null): void { lastRecapBriefId = id; }

export type SendResult = { sent: true; text: string } | { sent: false; reason: string };

/**
 * Text the wearer a recap of `brief`. `toNumber` must be WEARER_PHONE: Cue never messages the
 * person the wearer met (any other number is refused). `force` re-sends an already-sent version.
 */
export async function sendRecap(
  brief: Brief,
  toNumber: string | undefined = photonConfig.wearerPhone,
  opts: { followUp?: string; force?: boolean; bubbles?: string[] } = {},
): Promise<SendResult> {
  if (!photonConfigured()) return skip("set PHOTON_PROJECT_ID, PHOTON_PROJECT_SECRET, WEARER_PHONE");
  if (!toNumber || !samePhone(toNumber, photonConfig.wearerPhone!)) {
    console.warn("[photon] refused: recipient is not WEARER_PHONE");
    return { sent: false, reason: "recipient is not the wearer" };
  }
  if (brief.cards.length === 0) return { sent: false, reason: "brief has no cards" };
  const key = `${brief.id}:v${brief.version}`;
  if (sentKeys.has(key) && !opts.force) return { sent: false, reason: "already sent" };
  if (!opts.force && Date.now() - lastSentAt < photonConfig.minGapMs) return { sent: false, reason: "rate limited (local pacing)" };

  const c = await client();
  if (!c) return skip("Spectrum SDK not installed or init failed (npm i @spectrum-ts/core @spectrum-ts/imessage)");

  // Haiku-written bubbles when the caller has them (compose.ts); the template is the fallback.
  const bubbles = foldBubbles(opts.bubbles?.length ? opts.bubbles : [formatRecap(brief, opts.followUp)]);
  const text = bubbles.join("\n\n");
  lastSentAt = Date.now();
  try {
    wearerSpace ??= await c.im.space.create(await c.im.user(photonConfig.wearerPhone!));
    for (const [i, b] of bubbles.entries()) {
      if (i) await new Promise((r) => setTimeout(r, 600)); // keep bubble order; Photon dislikes bursts
      await wearerSpace.send(b);
    }
    sentKeys.add(key);
    lastRecapBriefId = brief.id;
    console.log(`[photon] recap ${key} sent (${bubbles.length} bubbles, ${text.length} chars)`);
    return { sent: true, text };
  } catch (err) {
    wearerSpace = null;
    const msg = err instanceof Error ? err.message : String(err);
    // "Target not allowed for this project" = WEARER_PHONE is not a user on the Free/Pro project.
    console.warn(`[photon] send failed: ${msg}`);
    return { sent: false, reason: msg };
  }
}

/** Text the wearer any bubbles (e.g. the CREAO follow-up). Wearer only; never the person met. */
export async function sendText(bubbles: string[]): Promise<SendResult> {
  if (!photonConfigured()) return skip("set PHOTON_PROJECT_ID, PHOTON_PROJECT_SECRET, WEARER_PHONE");
  const clean = foldBubbles(bubbles);
  if (!clean.length) return { sent: false, reason: "nothing to send" };
  const c = await client();
  if (!c) return skip("Spectrum SDK not installed or init failed");
  try {
    wearerSpace ??= await c.im.space.create(await c.im.user(photonConfig.wearerPhone!));
    for (const [i, b] of clean.entries()) {
      if (i) await new Promise((r) => setTimeout(r, 600));
      await wearerSpace.send(b);
    }
    lastSentAt = Date.now();
    console.log(`[photon] text sent (${clean.length} bubbles)`);
    return { sent: true, text: clean.join("\n\n") };
  } catch (err) {
    wearerSpace = null;
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[photon] send failed: ${msg}`);
    return { sent: false, reason: msg };
  }
}

// ---------------------------------------------------------------------------
// Replies (optional): long-lived stream, wearer only
// ---------------------------------------------------------------------------

/**
 * Consume inbound iMessages. Only text from WEARER_PHONE reaches `handler`; a returned string is
 * sent back in the same chat. Returns false when Photon is not configured. Runs until app stop.
 */
export async function startReplyListener(
  handler: (text: string, ctx: { lastBriefId: string | null }) => Promise<string | string[] | null>,
): Promise<boolean> {
  if (!photonConfigured()) { skip("set PHOTON_PROJECT_ID, PHOTON_PROJECT_SECRET, WEARER_PHONE"); return false; }
  const c = await client();
  if (!c) return false;
  const seen = new Set<string>();
  void (async () => {
    try {
      for await (const [space, msg] of c.app.messages) {
        if (msg.direction === "outbound" || seen.has(msg.id)) continue;
        seen.add(msg.id);
        if (msg.content.type !== "text" || !msg.content.text) continue;
        if (!msg.sender || !samePhone(msg.sender.id, photonConfig.wearerPhone!)) {
          console.log("[photon] ignored inbound from non-wearer");
          continue;
        }
        try {
          const out = await handler(msg.content.text, { lastBriefId: lastRecapBriefId });
          const bubbles = foldBubbles(Array.isArray(out) ? out : out ? [out] : []);
          for (const [i, b] of bubbles.entries()) {
            if (i) await new Promise((r) => setTimeout(r, 600));
            await space.send(b);
          }
        } catch (err) {
          console.warn(`[photon] reply handler failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      console.warn(`[photon] inbound stream ended: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
  console.log("[photon] reply listener on");
  return true;
}

export async function stopPhoton(): Promise<void> {
  const c = await appPromise;
  appPromise = null;
  wearerSpace = null;
  await c?.app.stop().catch(() => {});
}
