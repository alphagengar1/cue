// Cue backend entry point: start the Express app from app.ts (01 section 4 and 6).
import { app } from "./app.js"; // first: app.ts imports telemetry before Express (Sentry init order)
import { config } from "./config.js";
import { photonConfigured, startReplyListener } from "./photon.js";
import { handleReply } from "./recap.js";
import { store } from "./store.js";

app.listen(config.port, () => {
  const keys = {
    deepgram: !!config.deepgramKey, exa: !!config.exaKey, anthropic: !!config.anthropicKey, creao: !!config.creaoKey,
    photon: photonConfigured(),
  };
  // Photon replies ("email", "who did I meet"): only the wearer's texts reach handleReply.
  if (photonConfigured()) void startReplyListener(async (text, ctx) => handleReply(text, ctx.lastBriefId));
  console.log(`[cue] listening on :${config.port} | model ${config.briefModel} | keys ${JSON.stringify(keys)} | event ${store.activeEventId}`);
});
