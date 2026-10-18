# agents/

Each `*.md` here (except this file, `voice.md`, `decision-gate.md`, `fast-brief.md`) is one message for the CREAO chat, nothing else:

```
cat agents/follow-up.md | pbcopy      # then paste into a new chat on https://agent.creao.ai
```

The chat creates the agent, applies every setting, runs the test, creates the API key, and replies with `AGENT_ID=` and `AGENT_KEY=`. Put those in `backend/.env` on the laptop and the server, then restart the server backend:

| File | Agent | .env lines | Before pasting |
|---|---|---|---|
| `research.md` | Cue Research (before the conversation) | `CREAO_RESEARCH_KEY=`, `CREAO_RESEARCH_ID=` | nothing |
| `follow-up.md` | Cue Follow-up (right after a debrief) | `CREAO_FOLLOWUP_KEY=`, `CREAO_FOLLOWUP_ID=` | nothing; it will prompt for the Gmail and Google Calendar sign-ins |
| `coach.md` | Cue Coach (long-running, nightly, memory) | `CREAO_COACH_KEY=`, `CREAO_COACH_ID=` | replace `JOURNAL_URL` in the text with `https://35.164.205.54.sslip.io/journal.md?token=<JOURNAL_TOKEN>` (token from `backend/.env`) |
| `speech-coach.md` | Cue Speech Coach (long-running, nightly, memory; delivery and conversation skills from verbatim speech and consented transcripts) | none needed (scheduled only) | replace `JOURNAL_URL` the same way |
| `relationships.md` | Cue Relationships (nightly, memory of every person and nudge; stale follow-ups, next nudge, weekly report, the "Cue Connections" sheet) | none needed (scheduled only) | replace `JOURNAL_URL` the same way; it will prompt for the Google Sheets sign-in |

```
ssh -i ~/.ssh/lightsail.pem ubuntu@35.164.205.54 "sudo systemctl restart cue-backend"
```

To update an existing agent instead, paste the same file and start the message with "Update the existing agent named ... to match this:". Backend contract: `design/05-agent-contracts.md`. Voice rules: `voice.md`.
