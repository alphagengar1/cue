// Sentry (01 section 9): tracing spans for each live-path step + structured logs (Sentry Logs).
// Import this module FIRST in server.ts so Sentry can hook Express before it loads.
// Off unless SENTRY_DSN is set; every helper is then a plain pass-through.
//
// Privacy (01 section 6): never send audio, transcripts, resume text, or request bodies.
// @sentry/node v11 replaced `sendDefaultPii` with `dataCollection`; everything is turned off there.
import * as Sentry from "@sentry/node";
import { config } from "./config.js";

export const sentryOn = !!config.sentryDsn;

if (sentryOn) {
  Sentry.init({
    dsn: config.sentryDsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? (process.env.NODE_ENV === "production" ? "production" : "development"),
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 1),
    // Equivalent of sendDefaultPii: false, plus no bodies (audio, resume) and no AI prompts.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      genAI: { inputs: false, outputs: false },
      stackFrameVariables: false,
    },
    // Forward console lines to Sentry Logs; beforeSendLog keeps only CREAO lines and warnings/errors.
    integrations: [Sentry.consoleLoggingIntegration({ levels: ["log", "warn", "error"] })],
    beforeSendLog(log) {
      if (log.attributes?.["sentry.origin"] !== "auto.log.console") return log;
      const msg = String(log.message);
      return msg.startsWith("[creao]") || log.level === "warn" || log.level === "error" ? log : null;
    },
  });
  console.log(`[sentry] on (tracing + logs)`);
}

type Attrs = Record<string, string | number | boolean | undefined>;

const clean = (a: Attrs = {}): Record<string, string | number | boolean> =>
  Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)) as Record<string, string | number | boolean>;

/** Run `fn` inside a Sentry span (child of the active span if any). Pass-through when Sentry is off. */
export function span<T>(name: string, op: string, fn: () => T, attributes?: Attrs): T {
  if (!sentryOn) return fn();
  return Sentry.startSpan({ name, op, attributes: clean(attributes) }, fn);
}

/** Add attributes to the active span (e.g. result counts). No-op when Sentry is off. */
export function spanAttrs(attributes: Attrs): void {
  if (!sentryOn) return;
  Sentry.getActiveSpan()?.setAttributes(clean(attributes));
}

/** Structured log to Sentry Logs. Keep attributes free of names, transcripts, and resume text. */
export const log = {
  info: (msg: string, attributes?: Attrs) => { if (sentryOn) Sentry.logger.info(msg, clean(attributes)); },
  warn: (msg: string, attributes?: Attrs) => { if (sentryOn) Sentry.logger.warn(msg, clean(attributes)); },
  error: (msg: string, attributes?: Attrs) => { if (sentryOn) Sentry.logger.error(msg, clean(attributes)); },
};

export function captureError(err: unknown): void {
  if (sentryOn) Sentry.captureException(err);
}
