// One-time: get the Google refresh token that lets the backend read the wearer's free/busy and
// place tentative holds (backend/src/calendar.ts). Run on your laptop, signed in as the wearer:
//
//   cd backend && $HOME/.nvm/versions/node/v22.18.0/bin/node node_modules/tsx/dist/cli.mjs scripts/google-auth.ts
//
// Needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in backend/.env first (Google Cloud console ->
// APIs & Services -> Credentials -> OAuth client ID, type "Desktop app"; enable the Google Calendar
// API; add the wearer's Google account as a test user while the consent screen is in Testing).
// Prints the GOOGLE_REFRESH_TOKEN line to paste into backend/.env. Nothing is written for you.
import http from "node:http";
import { SCOPES, calendarConfig } from "../src/calendar.js";

const { clientId, clientSecret } = calendarConfig;
if (!clientId || !clientSecret) {
  console.error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in backend/.env first.");
  process.exit(1);
}
const port = Number(process.env.GOOGLE_AUTH_PORT || 8788);
const redirect = `http://127.0.0.1:${port}/oauth2callback`;
const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
for (const [k, v] of Object.entries({
  client_id: clientId, redirect_uri: redirect, response_type: "code", scope: SCOPES.join(" "),
  access_type: "offline", prompt: "consent", include_granted_scopes: "true",
})) auth.searchParams.set(k, v);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", redirect);
  if (url.pathname !== "/oauth2callback") { res.writeHead(404).end(); return; }
  const code = url.searchParams.get("code");
  const err = url.searchParams.get("error");
  if (!code) { res.writeHead(400).end(`no code (${err ?? "unknown error"})`); return; }
  try {
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, grant_type: "authorization_code" }),
    });
    const j = (await r.json()) as { refresh_token?: string; error?: string; error_description?: string; scope?: string };
    if (!r.ok || !j.refresh_token) throw new Error(j.error_description ?? j.error ?? `no refresh_token in the reply (status ${r.status})`);
    res.writeHead(200, { "Content-Type": "text/plain" }).end("Cue is connected to this calendar. You can close this tab.");
    console.log("\nPaste this into backend/.env (keep it secret):\n");
    console.log(`GOOGLE_REFRESH_TOKEN=${j.refresh_token}\n`);
    console.log(`Granted scopes: ${j.scope ?? "(not reported)"}`);
    console.log("Then restart the backend. WEARER_HOURS (default 10-18) and WEARER_TIMEZONE bound the proposed times.");
  } catch (e) {
    res.writeHead(500).end(`token exchange failed: ${e instanceof Error ? e.message : String(e)}`);
    console.error(`token exchange failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    setTimeout(() => { server.close(); process.exit(0); }, 200);
  }
});
server.listen(port, "127.0.0.1", () => {
  console.log("Open this URL in a browser signed in as the wearer:\n");
  console.log(auth.toString());
  console.log(`\nWaiting on ${redirect} ...`);
});
