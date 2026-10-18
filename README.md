# Cue

Cue is an app for Even Realities G2 smart glasses that gives quiet networking help at in-person events. Hold to talk, say a name, an org and a role ("Priya, Anduril, recruiter"), and three short cards appear on the HUD: **Connect**, **Context** and **Your angle**. Built at LA Hacks Fall 2026.

Public professional info only. No camera, no face recognition, no recording, no LinkedIn scraping.

The design docs in [design/](design/README.md) are the source of truth. Start with [design/README.md](design/README.md).

## Repo layout

```
cue/
  design/      design docs (product, architecture, glasses UX, agents, build plan)
  shared/      types.ts: canonical data types used by app and backend
  app/         glasses app (Vite + TypeScript, Even Hub SDK), runs in the Even Realities phone app
  backend/     Node + Express + TypeScript API: STT, store, search, brief writer, Photon recap
  agents/      prompts for the fast brief writer and the four CREAO agents (Event Loader, Person Researcher, Brief Writer, Follow-up Writer)
```

## Run the backend

Needs Node 20.12 or newer.

```bash
cd backend
cp .env.example .env      # fill in keys; any missing key falls back gracefully
npm install
npm run dev               # http://localhost:8787 (tsx watch)
npm run smoke             # in a second terminal: calls /api/state and /api/briefs/text
```

Production: `npm run build && npm start`.

Without keys the backend still works: `/api/briefs/text` returns a template card built from the sample event (`backend/data/sample-event.json`), and `/api/stt` returns `STT_FAILED` saying `DEEPGRAM_API_KEY` is not set.

The fast brief model is Claude Haiku 5.5 (`claude-haiku-5-5`, effort `low`), configurable with `BRIEF_MODEL`.

## Run the glasses app

```bash
cd app
npm install
npm run dev               # Vite dev server on :5173
npm run simulate          # desktop simulator, or:
npx evenhub qr --url http://<your-laptop-ip>:5173   # scan with the Even Realities app
```

The app talks only to the backend (`VITE_BACKEND_URL`, `VITE_DEVICE_TOKEN` in `app/.env`). It holds no API keys.

## Sponsors

CREAO agents do the deep work before and after. Before the event, Event Loader -> Person Researcher -> Brief Writer build the org store and the researched facts the glasses' cards are built from. After each conversation, the Follow-up Writer turns the wearer's own 10-second spoken debrief into a follow-up email, a short message and next steps. Claude Haiku 5.5 on our backend handles the two seconds in between (Deepgram STT, Exa search, one Haiku call), and Photon delivers the follow-up to the wearer by iMessage.

The agents are built on agent.creao.ai and run by hand before and after the event (the CREAO /v2 API only runs API-created agents, so the backend cannot start them). Their JSON is loaded from `backend/data/<event>.json`; see [agents/person-researcher.md](agents/person-researcher.md) and [agents/follow-up-writer.md](agents/follow-up-writer.md) for the prompts and where each output goes.

- CREAO Event Loader agent (agent.creao.ai): ID `7ed5ac12-fb85-4545-9e4e-abbeaa25db1a`, run share link https://agent.creao.ai/share/aa9e8fec817ba50138997a79b610d5cc. Its output is `backend/data/creao-career-fair.json` and `backend/data/creao-lahacks-sponsors.json`.
- CREAO Person Researcher agent: ID `e496e45b-c8eb-4079-9aff-876071501d67`, run share link https://agent.creao.ai/share/21c460878c2ec3e4eed039a5a327e0e6.
- CREAO Brief Writer agent: ID `d5ded73b-03b6-407d-be3e-5d332d6e869a`, run share link https://agent.creao.ai/share/5922c0b96ff6085300d95090eeb4bc58.
- CREAO Follow-up Writer agent: ID [FOLLOW-UP WRITER AGENT ID], run share link [FOLLOW-UP WRITER SHARE LINK]. Prompt and test inputs: [agents/follow-up-writer.md](agents/follow-up-writer.md). Its JSON is stored as `followUp` on the person's entry in `backend/data/<event>.json`. Today the backend does not read `followUp`; wiring it into the Photon recap is backend work.
- Photon (Spectrum iMessage): texts the wearer a recap after a conversation, and the Follow-up Writer's message once that field is wired in (`backend/src/photon.ts`, `backend/src/recap.ts`). It only ever messages the wearer, never the person they met: the backend refuses any other number and the Photon project allowlist enforces the same rule. Unverified: one real end-to-end send is still pending (see `design/photon-notes.md`).
