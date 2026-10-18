# Cue Design Docs

Cue is an app for Even Realities G2 smart glasses that gives quiet networking help at in-person events. You quietly say a name, an org, and a role, and three short cards appear on the HUD: Connect, Context, and Your angle. Built at LA Hacks Fall 2026 (Oct 17-18).

These docs are the source of truth for both teammates and for coding agents. Read them in order. If two docs disagree, `04-build-plan.md` section 8 says which one wins.

| Doc | What it covers | Read it if you are |
|---|---|---|
| [00-product.md](00-product.md) | What Cue does, the live moment, the three cards, event goals, privacy rules, demo success criteria | Anyone, first |
| [01-architecture.md](01-architecture.md) | Components, live path, latency budget, API endpoints, data types, failure handling | Building the backend or the app API client |
| [02-glasses-ux.md](02-glasses-ux.md) | HUD layout, render contract, gestures, state machine, example briefs, card writing rules | Building the glasses app (Person A) |
| [03-agents-and-research.md](03-agents-and-research.md) | Event Loader, Person Researcher, Brief Writer, search and disambiguation, safety filter, CREAO integration | Building research and agents (Person B) |
| [05-agent-contracts.md](05-agent-contracts.md) | What the backend sends to and reads from each of the six CREAO agents, and what it does with the result; `agents/*.md` are paste-only | Wiring or debugging an agent |
| [04-build-plan.md](04-build-plan.md) | Milestones to submission, task list by person, checkpoints, cut lines, repo layout, test plan, demo script | Planning or picking the next task |

## Key facts at a glance

- **Team split:** Person A owns the glasses app (`app/`). Person B owns the backend and agents (`backend/`, `agents/`).
- **Must ship:** a G2 build running on physical glasses, and CREAO agents that the product depends on.
- **Cut first if behind:** Photon, then Sentry, then MLH extras, then fallback providers and offline cache, then goal switching.
- **Privacy:** public professional info only, no camera, no face recognition, no recording, no LinkedIn scraping.
- **Deadline:** Unverified: Sunday Oct 18, 12:00.

## Editing these docs

- Plain English, short sections, under ~1,800 words per doc.
- Mark anything not yet confirmed as "Unverified:".
- When a hardware test or workshop answer settles an open question, update the doc and remove the question.
- Plan: these move to Google Docs once stable.

## Open questions (only the humans can answer)

Write the answer next to each question, then update the doc it affects and delete the question.

**Even Realities workshop / table (3-4 PM)**
1. Does the track accept a Private build, or must it be a Beta build? Who sets up our dev portal account and Beta group?
2. ~~Does a plain long press reach the app?~~ Answered on hardware: yes. iOS, Even app 2.3.2; long press = sysEvent 9, release = 10. `PTT_MODE = "hold"`. See 02 "Measured on hardware".
3. ~~Does the Even app show our WebView while the app runs?~~ Answered on hardware: yes, the phone mirrors the HUD. Laptop mirror for judges stays at `/setup?view=mirror`.
4. (Partly answered on hardware: level 1 is too dim, so the quiet line uses level 2.) Is a dim one-line status (`textColor` 2) acceptable as "never a black screen"? Are tap-to-toggle capture and a 25 s auto-quiet acceptable to reviewers?
5. Is a simple privacy-policy page on our backend domain enough for a hackathon build?

**CREAO table**
6. What "agent run share link" do judges want in the README: a chat-thread share link, an agent install link, or something else?
7. Are there hackathon credits? Does the free plan allow a Developer API key (`cr_sk_`)? About how many credits does a typical run use?
8. Are agents created in the agent.creao.ai UI runnable through `developer.creao.ai/v1/runs` on the same account and credits?

**Organizers**
9. ~~Exact submission deadline~~ Answered: Sunday 12:00, on Devpost. Still open: is judging a live table demo or a stage demo? (Ask on Discord.)

**Team decisions**
10. ~~Which fast LLM~~ Answered: Claude Haiku 5.5 (`claude-haiku-5-5`, effort `low`, structured JSON output via `output_config.format`), set by the `BRIEF_MODEL` env var. Paid from the team's Anthropic credits (about $10 budget).
11. Demo people: friends or anyone the team asks; due Sat 9 PM. Use people who have some public professional footprint (a personal site, GitHub, a talk, a club or lab page), otherwise the demo only shows the "no public info" fallback.

**Team notes**
- Questions for sponsors go to the LA Hacks Discord channels (the team is working remotely from the dorm).
- Real G2 glasses are available now for testing. ~~Checkpoint 1~~ Done: hardware test passed (long press, double tap exit, menu, both temples, mic with clear playback, swipes, fonts, brightness; body shows 5 lines at 27 px each, layout resized so no partial lines; see 02 "Measured on hardware").
- Network: eduroam blocks phone-to-laptop traffic. For dev, put the phone and laptop on the laptop's phone hotspot (backend at `http://172.20.10.2:8787`).
12. Backend hostname: GoDaddy domain or `<ip>.sslip.io`? It must be final before the Even Hub build.
13. Photon (only if time): do we get a dedicated line or credits, and can it send a first message to the wearer without an inbound one?
