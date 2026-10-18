# Cue - Devpost submission draft

Placeholders in [SQUARE BRACKETS] must be filled or deleted before submitting (deadline Sunday 12:00). Lines that start with "Unverified:" are true as of Oct 18 early and should be re-read before submitting.

**Tagline:** A little help when you need it, then out of the way. Quiet networking help on Even Realities G2 glasses.

**One-line pitch:** Hold a temple, say "Priya, Anduril, recruiter," and three short cards appear on your lens: how to connect, who they are, and what to ask for. Then the display goes quiet so you can actually talk. After the conversation, say what happened, and your phone gets the recap, a follow-up draft and three times to meet.

---

## Inspiration

At a career fair you meet 30 people in two hours. You forget who does what, you freeze on the opener, and by the fifth booth every question sounds like "so, what do you do?" We are two UCLA freshmen, and this is exactly where we feel behind: upperclassmen seem to arrive knowing what to ask.

The tools that exist for this either live on a phone (which means looking down, which means not looking at the person) or they talk to you during the conversation. Several hackathon projects whisper suggestions while someone is speaking, and some use a camera to recognize faces. We wanted the opposite. The best moment for help is the five seconds before you start talking, and the best help during the conversation is none at all. That is the Even Realities idea of "Quiet Tech," and it shaped every decision.

The second half came from watching ourselves after a fair: a pocket full of business cards and no follow-up sent. So the thing that happens after each conversation matters as much as the cards before it.

## What it does

Cue is an app for Even Realities G2 smart glasses, with a backend that runs three CREAO agents and texts you on iMessage.

**The live moment, on the glasses.**

1. You read a name badge and hold the temple (long press). You quietly say a name, a company, and a role: "Priya, Anduril, recruiter."
2. Release. The lens shows `Looking up...` and echoes what it heard (`Heard: Priya | Anduril | recruiter`) so you can catch a mistake. If what it heard is within two edits of someone on the event list, the cards are for that person: "David Kramer" is looked up as David Cramer.
3. About three seconds later, three cards appear, one at a time, with a source line on each:
   - **Connect:** an opener that is not small talk, such as a shared background or a question about their own work.
   - **Context:** their role and what their company is focused on now.
   - **Your angle:** how this person fits your goal for the event (internship, cofounder, learn, teammates and sponsors, mentorship), and one specific thing to ask.
4. Tap or swipe to flip. After you finish reading, or after 25 seconds, the HUD drops to one dim status line. Nothing pops up while you are talking.
5. 
**The menu is five items:** Talk, Last brief, Text me a recap, Record conversation, Go quiet. Everything else is spoken. Hold the temple (up to 12 seconds) and say anything. A decision model picks what you meant, and the backend does it:

- "Priya Shah, Anduril, recruiter": a lookup, three cards.
- "Cramer with a C" or "no, it's Priya not Maya": a correction, the last lookup re-runs with the fixed name.
- "he said email him about Seer, they're hiring interns": a debrief. The note is saved on the brief, the recap is texted, and the follow-up chain starts.
- "I'm looking for a cofounder": a goal change, the angle card is rewritten and the other two stay.
- "text me the recap": the recap is texted.
- "how did I do today?" or "who should I follow up with?": the Coach agent answers on your phone.
- "never mind": back to quiet.
- Anything else gets one quiet line with a hint.

**Record conversation** is the one thing that needs the other person's permission, so it asks for it first. The lens shows a consent screen: "Ask them: OK if my glasses take notes? Tap once they say yes." Swipe up cancels. After the tap, the header reads "● Recording m:ss" with a running word count, and a tap stops it (15 minute cap). The audio streams to the backend in 20 second chunks and only the transcript is kept, on that one brief. It rides into the Follow-up agent, the Follow-up agent and the Coach. Nothing is stored on the glasses or the phone, and audio is never logged.

**After the conversation, on your phone.** You hold the temple and say what happened in your own words. Within seconds Photon texts you a recap, written in a texting voice:

```
just met david cramer, sentry co-founder 👀
he said to email him about seer, they're hiring summer interns
he also wants the cue demo video, put that in the email
want a draft? just say email ✍️
```

Then the CREAO chain runs in the background, and each result is texted as it lands. The Follow-up agent texts the email draft, its subject line and the first next steps (with a Gmail connector it also saves the email as a draft in your own Gmail, never sent, and texts the draft link); reply "text" for the short message. The Follow-up agent texts three proposed half-hour times in your timezone and the link to a tentative 30 minute hold on your own calendar, with no guests; reply "book" for the scheduling message in your voice. You can also reply "email", "who did I meet" or "book 2" in the same thread.

**Over the day.** The Coach agent is the long-run agent: it runs when you ask "how did I do today?" by voice or by text, and on its own after every third debrief of the day. It texts a few bubbles (summary, patterns, who to follow up with first, one line for next time); the full description is under "The long-run analysis" below.

Cue has no camera, no face recognition, and no always-on listening. Push-to-talk audio is captured only while you hold the press and is discarded after transcription. It uses public professional information only: talks, personal sites, company pages, search snippets and the professional sections of LinkedIn (headline, role, experience, projects, publications). It never takes contact info, connections, activity or anything personal, and a blocklist plus a decision-model check drop family, home, health, religion, politics, age and appearance.

When Cue is not sure who someone is, it says so. If the name could match several people, the lens asks "Which Priya?" and you pick. If you pick none, or nothing is found, you get a company card that begins "No public info found for Priya." It does not guess. And when the person is real but the facts offer nothing for your goal, you get one quiet line ("Priya: nothing for your goal") instead of three cards; the cards stay under Last brief.

## How Cue uses each sponsor

**Even Realities (G2 + Even Hub).** Cue is built as an Even Hub app with the Even Hub SDK and runs on real G2 hardware. We designed for the "quiet by design" rule: one fixed three-container layout (header, body, footer) that is created once and updated in place, no flicker, no rebuilds, and a dim one-line status in place of a black screen. Input is the temple touchpad: long press to talk, tap and swipe to flip cards, double tap for the system exit dialog, and the five-item contextual menu. We use the glasses microphone for push-to-talk and for consented conversation notes, and the SDK background/foreground events so the menu overlay does not disturb state. We tuned the display to measured hardware limits (see Challenges).

**CREAO (AI-First Disruptor).** Cue uses three CREAO agents, all built in the agent.creao.ai UI, and the product breaks without them. Every one is started by our backend over CREAO's per-agent App API: each agent has its own `capi_` key on the server, `backend/src/creao.ts` posts the agent's declared inputs to `agent.creao.ai/api/v1/apps/{agentId}/runs`, polls the run every 15 seconds (15 minute cap) and also registers a webhook when the backend has a public URL. It pulls the first JSON block out of `result.chatText`, `result.text` or the run's artifacts, validates it with zod, and applies it. Keys never leave the server. The agents run in three chains:

- **Before and during the event.** The **Research agent (event request)** reads the sponsor, employer and speaker list from the setup page and builds the store of organizations and seed people that makes company cards appear in seconds. After a lookup with a high match or a confirmed pick, the **Research agent** does multi-step research on that one person (Browser Use can be on, extended memory is on, LinkedIn professional sections allowed) and returns sourced facts. When it completes, the **Research agent** turns the research into a checked three-card brief with an `improvesOn` note. Both rewrite the cards on the glasses about 90 seconds after the lookup: Brief v2 when the facts land, v3 when the Research agent finishes.
- **After each conversation.** The wearer speaks a debrief in their own words. Right after the instant recap, the **Follow-up agent** (extended memory on, optional Gmail connector that saves the email as a draft and never sends) returns an email, a message under 300 characters and next steps. When it completes, the **Follow-up agent** (extended memory on, Google Calendar connector, Autonomy Auto) proposes three half-hour times from the wearer's availability, writes an invite title, description and scheduling message, and creates one tentative 30 minute hold on the wearer's own calendar with no guests. The backend double-checks the times against free/busy and places the hold itself only if the agent did not.
- **Over the whole day.** The **Coach agent** is the long-run agent, described in the next paragraph.

The Follow-up agent, the Follow-up agent and the Coach also receive the consented conversation transcript when one exists. Photon texts every result to the wearer as it completes. No agent ever contacts the other person. Hand-run agent output pasted into `backend/data/<event>.json` is still supported as a pre-event path and lands in the same store as a live run. Remove the agents and there is no event, no company context, no researched brief, no follow-up, no next meeting and no coaching.

CREAO features in play: three agents created from the CREAO chat; per-agent App API keys with webhook plus polling; the Cue Journal as the persistent store the Coach reads on its own nightly schedule; extended memory on all three; Google Calendar and Gmail (draft only) connectors on Follow-up, Google Sheets on Coach; Browser Use on Research; Dashboard output on Coach; Autonomy Auto; share links and the Sessions tab.

CREAO agent IDs and run share links:

| # | Agent | ID | Share link |
|---|---|---|---|
| 1 | Research (before: event pack, person research, final cards) | [RESEARCH AGENT ID] | [RESEARCH SHARE LINK] |
| 2 | Follow-up (after: email, message, next steps, times, calendar hold, Gmail draft) | [FOLLOW-UP AGENT ID] | [FOLLOW-UP SHARE LINK] |
| 3 | Coach (long-running: journal, Connections sheet, dashboard, coaching, nightly with memory) | [COACH AGENT ID] | [COACH SHARE LINK] |

We show the agents running in the CREAO Sessions tab in the demo video.

**The long-run analysis the CREAO team asked for.** Most of Cue is fast: a card in seconds, then quiet. The **Coach agent** is the opposite, and it is where CREAO's extended memory matters. It sees the wearer's whole day as one input: every brief the glasses showed, every spoken debrief, every consented conversation transcript, and which follow-ups were sent. With extended memory on, it also remembers its earlier runs and earlier days, so "you walked away without a next step twice today" can become "better than yesterday". It returns four things the wearer cannot see in the moment: patterns across conversations (topics that keep coming up, asks that worked, what the wearer keeps forgetting), the two or three people to follow up with first and the concrete action for each, specific coaching for the next conversation, and one line to read before it. It runs when the wearer says or texts "how did I do today?" or "who should I follow up with?", automatically after every third debrief of the day, and optionally on a nightly schedule set on the agent. Photon texts the result as a few short bubbles. It never contacts anyone but the wearer.

**Photon (iMessage).** Photon (Spectrum) is how everything after the live moment reaches the wearer, so the glasses can stay quiet. It delivers the instant recap, the Follow-up agent's email and next steps, the Follow-up agent's times and calendar link, and the Coach's bubbles, each as it completes. Claude Haiku writes the recap and the free-form answers in the texting voice in `agents/voice.md`, and the backend shapes agent JSON into bubbles (one thought per bubble, lowercase, at most five). Templates are the fallback. The wearer can reply "email", "text", "who did I meet", "book" (returns the scheduling message) or "book 2" (moves a backend-placed hold), or ask the Coach a question, and get an answer in the same thread. Photon only ever messages the wearer, never the person they met: the backend refuses any number but the wearer's, and the Photon project allowlist enforces the same rule. Real end-to-end sends are verified from the deployed backend.

**Sentry.** The backend is instrumented with Sentry tracing and Sentry logs on the live path, so one lookup shows up as a single trace with spans for speech-to-text (`stt`), the store lookup (`store lookup`, inside `lookup total`), web search (`search`) and the card model (`llm`); the decision gate's timing rides on the same trace as the attribute `cue.ms.decide`. That is how we found where our seconds go. Spans carry sizes and timings only. We never log audio or transcripts. Trace: [SENTRY TRACE LINK].

**Hosting (AWS).** The Cue backend (speech-to-text proxy, store, search, card writer, decision model calls, CREAO runs, Photon) runs on an AWS Lightsail instance under systemd, behind Caddy with automatic HTTPS at https://35.164.205.54.sslip.io, because the glasses app can only call an HTTPS host. The deploy scripts are in `deploy/`. The server holds all API keys in `backend/.env`. The glasses app holds no keys, only `VITE_BACKEND_URL` and `VITE_DEVICE_TOKEN`.

## How we built it

- **Glasses app:** TypeScript and Vite, using the Even Hub SDK, running inside the Even Realities phone app. One state machine (Ready, Listening, Thinking, Card, Confirm, Quiet, Consent, Recording, Error). The menu is the five items above; everything else is spoken and sent to `POST /api/say`. A `render()` function sends only changed text containers with `textContainerUpgrade`. Text is measured with Even's pretext library so every card is cut at a word to fit the lens.
- **Push-to-talk:** the app starts the glasses microphone on long press, buffers raw audio, and stops on release (plus a short tail so the last word is not clipped). Clips under 0.4 seconds are discarded. Record conversation reuses the same mic path but streams 20 second chunks to `POST /api/briefs/:id/transcript`, and only after the on-screen consent tap.
- **Backend:** Node, Express and TypeScript. Speech-to-text with Deepgram, with the event's company and people passed in as keyterms so names like "Anduril" transcribe correctly. Web search with Exa, filtered so a result counts only if it mentions both the name and the company. One fast Claude call (`claude-haiku-5-5`, effort low, structured outputs) writes the three cards as validated JSON, then a code-side safety filter drops blocked topics. The whole fast path, from release to first card, takes about three seconds.
- **Decision model, used twice:** both go to the OpenAI Decisions API (`gpt-6-luna`). The intent router (`backend/src/intent.ts`) asks for calibrated probabilities over lookup, correction, debrief, goal, recap, coach, quiet and unknown; a plain "name, company, role" is routed by rules without the call. The cue gate (`backend/src/decide.ts`) makes one call per brief, between the search filter and the card writer. It asks four calibrated questions. Match below 0.6: "No public info found" instead of cards about a stranger. Goal fit below 0.5: one quiet line instead of cards. Lead: which card shows first. Sensitive above 0.5: the fact is dropped. We use a decision model and not the chat model because a generative model is good at writing cards and bad at saying no: its self-reported confidence is prose, not a calibrated number you can threshold. Both uses are optional (`OPENAI_API_KEY`), never throw, time out (`DECIDE_TIMEOUT_MS`, default 1.2 s; the design target was 700 ms), and fall back to the rules classifier and the code filters, which stay on either way.
- **CREAO orchestration:** `backend/src/creao.ts` holds the transport (per-agent key, run start, 15 second polling, webhook) and one apply function per agent that validates the JSON with zod and writes it into the store. `brief.ts` starts the Researcher after a confident lookup, `say.ts` starts the Follow-up agent after a debrief and counts debriefs for the Coach, and `coach.ts` builds the day's history for the Coach. Prompts, setup steps and test inputs for all three agents are in `agents/`.
- **Texting voice:** `agents/voice.md` is one page of rules (one thought per bubble, under 100 characters, lowercase, no labels, at most five bubbles). Haiku writes the recap in it (`backend/src/compose.ts`), the agents write in it at the source, and `backend/src/voice.ts` shapes and caps their JSON into bubbles.
- **Laptop and phone mirror:** the phone companion page inside the Even app mirrors the HUD, and the setup page shows the latest brief, so judges can see what the lens shows.
- **Setup page:** paste your profile, your availability and your starting goal, then load the event (that is the `POST /api/events` that starts the Research agent (event request)). On the glasses, the goal is changed by saying it.

## Challenges we ran into

- **Push-to-talk had no documented answer.** We did not know whether a plain long press would reach the app. We tested on a real G2: a long press arrives as system event 9 and the release as event 10, from either temple. That let us ship true hold-to-talk. We kept tap-to-toggle behind a flag as a fallback.
- **The screen was showing partial lines.** Our first body container was 200 px tall and showed 5 to 6 lines with a half-cut line at the top and bottom. The firmware uses a fixed 27 px line height, and our inner heights (32 px and 188 px) were not multiples of 27. We rebuilt the layout so every inner height is an exact multiple of 27: header and footer are one line each, and the body is exactly five lines (135 px). Then we cut text at a word boundary to guarantee it never needs to scroll. Re-verified on hardware: no cut-off lines on any card.
- **The 5-line card budget.** The font is proportional, about 49 digits fit on a line but far fewer wide letters, so we capped card bodies at 200 characters over at most 5 lines and wrote the card prompts around "lead with the fact, end with something you can say."
- **Brightness.** We tested the four text levels against a bright cloudy sky. Levels 2, 3 and 4 are readable; level 1 is not. So content uses 3 and 4 and the quiet status line uses 2, never 1. A black screen is also against Even's review rules, so Quiet mode is a dim line, not nothing.
- **Gestures arrive in different places.** Taps came in as system events with an undefined type (a protobuf quirk where 0 is omitted), swipes came in as text events, and opening the menu fires foreground events even though our page stays mounted. We handle all of these idempotently so opening the menu does not wipe your card.
- **Audio is real time.** The mic streams 50 ms frames, the first arrives about 450 ms after the press, and a couple arrive after we stop. Peaks hit full scale when speaking normally, which may clip, so we watch transcription accuracy and echo the transcript on screen.
- **Networking at a university.** eduroam blocks phone-to-laptop traffic, so during development we put the phone and laptop on a phone hotspot. Deploying to Lightsail behind Caddy removed the problem for the demo.
- **Telling people apart.** Searching "Priya at Anduril" can return the wrong Priya. We keep a result only if it mentions both name and company, and the decision gate checks the match before any card is written. Misheard names are a separate problem: Deepgram gets the event's names and orgs as keyterms, and the backend snaps a transcript to a listed attendee within 2 edits ("David Kramer" becomes David Cramer), so a near miss never needs a confirm screen. The "Which Priya?" screen remains only for a real ambiguity.
- **Agents that write to the world.** A CREAO run started over the API cannot create a calendar event unless the agent's Autonomy is set to Auto; under "Ask first" it silently skips the write. And an agent that returns prose instead of JSON would break the chain, so every prompt ends with "end your reply with exactly one ```json block" and the backend searches `chatText`, `text` and artifacts for it.
- **Getting the texts to sound like a person.** The first agent outputs read like consultant reports ("that maps straight to your internship goal"). We wrote `agents/voice.md`, put the rules in every agent prompt, and had the backend strip labels and split long lines, so the Coach now says "send it tonight, lead with the video".

## Accomplishments that we're proud of

- It runs on real G2 glasses, not only a simulator, with hold-to-talk that works on a plain long press.
- Hardware findings written down and fed back into the design: the 27 px line rule, the 5-line body, the brightness floor.
- A product that is quiet. The most important screen in Cue is the dim one-line status that appears while you talk to a person.
- Three CREAO agents, all started from the backend over the per-agent App API, chained three ways and verified live: lookup to researched cards, debrief to follow-up to a calendar hold, and a coach that reads the whole day.
- Honest behavior. When nothing is found, Cue says "No public info found" and shows a company card instead of making something up. When the facts match but do not help, it says one line and stays quiet.
- A privacy position we can say in one breath: no camera, no face recognition, no recording without on-screen consent, public professional information only, and nothing ever sent to the other person.
- Two first-years shipped a glasses app, a cloud backend, an iMessage line and three agents in one weekend.
- Median time from release to first card on venue wifi: [LATENCY SECONDS] s over [LATENCY RUNS] runs.

## What we learned

- Design for the display you have. A 576 by 288 monochrome HUD with a fixed font means every character is a decision. Measuring on hardware beat reading the docs.
- "Quiet" is a feature you have to build, not the absence of one. The auto-quiet timeout, the dim status line, and refusing to pop up updates during a conversation took real work.
- Agents are best used where waiting is acceptable. The fast path (speech, search, one model call) has to answer in seconds. The CREAO agents run for about 80 seconds to a few minutes, so they do the work that belongs before the conversation (the event store and the researched briefs), after it (the follow-up and the next meeting, written from the wearer's own debrief), and across the whole day (the Coach's patterns and priorities).
- Use a decision model to decide and a generative model to write. Thresholds on calibrated numbers made "say nothing" a real option.
- Echoing what the system heard is cheap and prevents most speech-to-text mistakes from becoming wrong cards.
- Consent is a screen, not a sentence in a policy. Putting "Ask them: OK if my glasses take notes?" on the lens before the mic opens made the feature feel right.
- Keep keys off the device. The glasses app talks to one HTTPS backend and holds no secrets.

## What's next

- Past-conversation memory so Connect can say "you met Priya at the fall fair."
- Letting the wearer reply "send" so the scheduling message goes out from their own account, and an end-of-event summary of everyone they met in one iMessage.
- Importing a real attendee list (Luma, speaker lists) with one tap.
- An offline cache of company cards for venues with poor wifi.
- Letting the person opt out or correct their card, and an on-lens way to see exactly which sources were used.
- Loading Research agent cards from a hand-run event file, so a pre-event run can also give v3 cards.

## What works today and what is wired but untested on hardware

**Verified live tonight (Oct 18 early), from the deployed backend:**

- Lookup on the glasses: hold to talk, Deepgram with event keyterms, Exa search, decision gate, Haiku cards in about three seconds, echo line, "Which Priya?" confirm screen.
- The background CREAO rewrite after a lookup (Research agent, v2 cards about 100 s later), verified on the server and switched off by default so nobody waits mid-conversation.
- Research agent (event request) started from the setup page (`POST /api/events`).
- Debrief to instant Haiku recap to the Follow-up agent, each texted by Photon as it completes, including the Gmail draft link and the Follow-up agent's own calendar hold with its link.
- Coach agent by texted question in iMessage (and the typed path) and after every third debrief, texted as bubbles.
- Photon real sends to the wearer, and the replies "email", "text", "who did I meet", "book", "book 2" and coach questions answered in the thread.
- All three agents through per-agent App API keys, with polling and the webhook, from the AWS Lightsail backend behind Caddy.
- Sentry traces on the live path.

**Built, verified from the setup page or typed path and the backend, but not yet exercised on the physical G2:**

- Unverified: the spoken intents other than lookup (correction, debrief, goal, recap, coach, never mind) said into the glasses. They were built Oct 17 late and tested through `POST /api/say` from the typed path, not yet by holding the temple.
- Unverified: the goal-gate quiet line ("Priya: nothing for your goal") on the lens.
- Unverified: Record conversation on the glasses (the consent screen, the recording state and the 20 second chunked streaming). The backend side of `POST /api/briefs/:id/transcript` is tested.
- Unverified: the backend-side Google Calendar OAuth path (`GOOGLE_*` vars, `npm run google:auth`) is wired and tested with stubs; the agent's own connector hold is the verified path.

**Two small caveats:**

- Research agent cards are not loaded from a hand-run event file; only the live chain writes v3.
- The decision gate timeout defaults to 1.2 s (`DECIDE_TIMEOUT_MS`), above the 700 ms design target.

We do not claim camera features, face recognition, or any recording without consent, because none exist.

## Built with

Even Realities G2, Even Hub SDK, @evenrealities/pretext, TypeScript, Vite, Node.js, Express, an in-memory store plus JSON event files, zod, Deepgram (speech-to-text), Exa (web search), Anthropic Claude (`claude-haiku-5-5`), OpenAI Decisions API (`gpt-6-luna`), CREAO agents (App API, extended memory, Google Calendar and Gmail connectors, Browser Use), Photon (Spectrum iMessage SDK), Google Calendar API, AWS Lightsail, Caddy, systemd, Sentry.

## Links

- GitHub: [REPO URL]
- Demo video: [VIDEO URL]
- CREAO agent IDs and run share links: table above, and in the README
- Backend: https://35.164.205.54.sslip.io
- Try it: the Even Hub build [LINK OR QR IF PUBLIC]
