// Cue backend entry point: start the Express app from app.ts (01 section 4 and 6).
import { app } from "./app.js"; // first: app.ts imports telemetry before Express (Sentry init order)
import { config } from "./config.js";
import { creaoEnabled } from "./creao.js";
import { photonConfigured, startReplyListener } from "./photon.js";
import { journal } from "./journal.js";
import { handleReply } from "./recap.js";
import { store } from "./store.js";

// systemd restarts (every deploy) send SIGTERM; flush the debounced session save first so no brief or run is lost.
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { try { store.saveSession(); } finally { process.exit(0); } });

app.listen(config.port, () => {
  const keys = {
    deepgram: !!config.deepgramKey, exa: !!config.exaKey, anthropic: !!config.anthropicKey,
    creao: creaoEnabled("person_researcher") || creaoEnabled("follow_up_writer"),
    photon: photonConfigured(),
  };
  // Photon replies ("email", "who did I meet"): only the wearer's texts reach handleReply.
  if (photonConfigured()) void startReplyListener(async (text, ctx) => {
    // After a restart the listener's last-recap pointer is gone; the newest saved brief is the one they mean.
    const briefId = ctx.lastBriefId ?? store.latestBrief()?.id ?? null;
    const answer = await handleReply(text, briefId);
    journal({ type: "reply", briefId: briefId ?? undefined, data: { text, answer: Array.isArray(answer) ? answer : answer ? [answer] : [] } });
    return answer;
  });
  console.log(`[cue] listening on :${config.port} | model ${config.briefModel} | keys ${JSON.stringify(keys)} | event ${store.activeEventId}`);
});
