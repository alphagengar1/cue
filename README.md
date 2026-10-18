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
  backend/     Node + Express + TypeScript API: STT, store, search, brief writer, CREAO webhooks
  agents/      prompts for the fast brief writer and the CREAO agents
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

- CREAO Event Loader agent (agent.creao.ai): ID `7ed5ac12-fb85-4545-9e4e-abbeaa25db1a`, run share link https://agent.creao.ai/share/aa9e8fec817ba50138997a79b610d5cc. Its output is `backend/data/creao-career-fair.json` and `backend/data/creao-lahacks-sponsors.json`.
