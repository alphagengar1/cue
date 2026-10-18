# Photon notes

Status: research + prototype, Sat Oct 17 2026. Answers README question 13. Code: `backend/src/photon.ts` (not wired in).

## What Photon offers

Photon (photon.codes) sells messaging infrastructure for agents. Docs come in two versions; we use **Stable (Spectrum)**.

| Product | Package | Runs where | Use for Cue? |
|---|---|---|---|
| **Spectrum** (cloud iMessage lines) | `@spectrum-ts/core` + `@spectrum-ts/imessage` (or the bundle `spectrum-ts`) | Any Node 20+ host, e.g. our Vultr box | **Yes.** Past Photon tracks (HackPrinceton, MultiModel) required "integrate with Spectrum" |
| Spectrum local iMessage | `@spectrum-ts/imessage-local` | A Mac with Full Disk Access, sends from your own Apple ID | Fallback only |
| imessage-kit (open source) | `@photon-ai/imessage-kit` | Mac only | No (probably doesn't count as Spectrum) |
| Advanced iMessage kit | `@photon-ai/advanced-imessage` | Low-level client | No |
| Photon 2.0 (Beta) | `@photon-ai/api` | Cloud | No, separate API and credentials |

Facts from the docs:

- **Credentials**: project ID + project secret from the dashboard (app.photon.codes, project Settings). The SDK also reads `SPECTRUM_PROJECT_ID` / `SPECTRUM_PROJECT_SECRET`.
- **Plans**: Free is $0 with a shared-pool number and up to 10 users. Pro is $25/mo for 100 users. Business is $250 per line per month for a dedicated number.
- **Allowlist (Free/Pro)**: a shared line only messages numbers added as **users** of the project. Anything else fails with `Target not allowed for this project`. That works in our favor: the wearer is the only user, so Cue cannot text the person they met.
- **First message without an inbound one**: yes. Code: `imessage(app).space.create(await imessage(app).user("+1..."))` then `send()`. Quota: 50 new conversations per line per day. Photon still advises inbound-first: an outbound first message from an unknown number shows Apple's "Report Junk" banner, and links in a first message stay unclickable until the user replies.
- **Limits**: 5,000 outbound messages per server per day. The Spectrum HTTP API allows 5 requests/s per project and returns 429 above that. Bursts, cold outreach and 3 a.m. sends get lines flagged.
- **Inbound**: either the long-lived `app.messages` async iterable (gRPC stream, no public URL needed) or signed webhooks. Webhooks are HMAC-SHA256 and handled by `app.webhook()` or `@spectrum-ts/express`, which must be mounted before `express.json()`.
- **No REST send endpoint**: sending goes through the SDK. The OpenAPI only covers project, users, lines and webhooks.

## Setup steps (user)

1. Sign up at https://app.photon.codes and create a project on the Free plan. Ask at the Photon table whether there's a hackathon promo code (past events gave out a free Pro code).
2. In the dashboard, add yourself (the wearer) as a **user** with the number or email your iMessage actually uses. If unsure, text https://debug.photon.codes to see your real handle.
3. Copy the project ID and secret into `backend/.env`: `PHOTON_PROJECT_ID=`, `PHOTON_PROJECT_SECRET=`, `WEARER_PHONE=+1...` (E.164). Set `PHOTON_ENABLED=0` to force it off.
4. In `backend/`, run `npm i @spectrum-ts/core@12.10.1 @spectrum-ts/imessage@12.10.1`. Both are 12.10.1, published 2026-09-22; 12.11.0 is two days old. They add about 120 MB (grpc, protobuf, otel). Their zod ^4.2 and TypeScript peer ^5 are compatible with ours.
5. Text the line once from your phone ("hi cue") before the demo. That avoids the junk banner and makes the source links clickable.
6. Wire it in: call `sendRecap(brief)` from a route, and optionally call `startReplyListener(...)` at boot.

## Integration design

**When to send** (in order of preference):
1. A **"Send recap"** menu item on the glasses (`POST /api/briefs/:id/recap`). The wearer decides, and the demo is deterministic.
2. Auto-send when a brief goes quiet: 3 min with no new lookup, and the brief has 3 cards. Use this only after (1) works. `sendRecap` already dedupes by `briefId:version` and spaces sends at least 5 s apart.

**Recipient rule**: `sendRecap(brief, toNumber)` refuses any number that isn't `WEARER_PHONE`. There's no code path that takes the met person's contact details, and the Free-plan allowlist enforces the same rule on Photon's side.

**Format** (`formatRecap`, hard cap 600 chars; card bodies shrink first):

```
Cue recap: Maya Chen, Recruiter, Anduril
Connect: <card 1 body>
Context: <card 2 body>
Ask: <card 3 body>
Follow-up: "Hi Maya, great meeting you at <event>! I'd love to keep talking about <topic>. Open to a quick chat next week?"
Sources: anduril.com/blog, anduril.com/careers
Reply "email" for a follow-up email draft.
```

**Replies**: `startReplyListener(handler)` drops outbound messages, duplicate IDs and any sender other than the wearer. The handler gets the text plus `lastBriefId`. Suggested handler: on "email"/"draft", call the LLM with the brief and profile to write a short email draft and send it back. Anything else gets a one-line help reply. The stream approach needs no public URL. On Vultr we could switch to webhooks with `@spectrum-ts/express`.

## What to show judges

1. The live G2 loop, then tap "Send recap". The phone buzzes on stage with the recap.
2. Reply "email" and the draft arrives in the same thread a few seconds later. This is the two-way agent in iMessage that Photon tracks reward.
3. Say it in one line: Cue only messages the wearer, never the contact. That's enforced in code and by Photon's per-project allowlist.

## Open questions (Photon Discord / table)

1. What does the LA Hacks Photon track require, and is there a promo code or credits? We couldn't find the rules online. Is Spectrum Cloud required, or does imessage-kit/local count?
2. On the Free shared pool, does `message.sender.id` come back as the E.164 number we registered? Our wearer filter depends on it.

Docs: https://photon.codes/docs/llms.txt, /docs/spectrum-ts/getting-started, /docs/spectrum-ts/providers/imessage/connection-and-routing, /docs/spectrum-ts/webhooks, /docs/best-practices/imessage-deliverability, /docs/spectrum-ts/troubleshooting/imessage, https://photon.codes/pricing.

## Status (Oct 17, late)

- Photon 2.0 beta = the Spectrum dashboard at app.photon.codes. Project `cue` (free plan), id in `backend/.env`. Shared iMessage line **+1 (415) 595-1440**; it only talks to phones added as users on the project (the wearer's phone was added at setup).
- SDK installed: `@spectrum-ts/core` + `@spectrum-ts/imessage` 12.10.1 (the lean split of `spectrum-ts`; same API). `photon.ts` checked against the installed typings: `imessage(app).user(phone)` -> `space.create(user)` -> `space.send(text)`, inbound via `for await (const [space, msg] of app.messages)`.
- Wired: `POST /api/briefs/:id/recap` (app.ts) -> `sendRecap`; glasses menu **Text me a recap** (cue.ts, id 10) shows "★ recap texted" / "recap: Photon not set up" in the quiet line; `server.ts` starts the reply listener when configured; `recap.ts` answers "email" (draft), "text" (short follow-up), "who did I meet" (today's briefs). Tests in `test/recap.test.ts`; `_env.ts` blanks the Photon keys so tests never text.
- Still needed: `PHOTON_PROJECT_SECRET` and `WEARER_PHONE` in `backend/.env`, one "hi" text from the wearer to the line, then one real end-to-end send. Unverified until then: pacing on the free plan, whether `user()` needs the "+1" form (we pass E.164).
- Safety: `sendRecap` refuses any number other than `WEARER_PHONE`; the reply listener ignores every other sender.
- Oct 17, later: real sends verified (David Cramer brief, 4 bubbles, 205 chars). Haiku writes the texts in a texting voice (`compose.ts`: recap bubbles, email, free-form answers); templates are the fallback. `POST /api/briefs/:id/debrief` stores the wearer's own spoken note; the debrief is spoken: hold the temple and say what happened; `POST /api/say` classifies it as a debrief, stores the note and texts the recap (see 02 "Menu and spoken intents").
