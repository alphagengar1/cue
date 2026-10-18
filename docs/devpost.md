# Cue - Devpost submission draft

Placeholders in [SQUARE BRACKETS] must be filled or deleted before submitting (deadline Sunday 12:00).

**Tagline:** A little help when you need it, then out of the way. Quiet networking help on Even Realities G2 glasses.

**One-line pitch:** Hold a temple, say "Priya, Anduril, recruiter," and three short cards appear on your lens: how to connect, who they are, and what to ask for. Then the display goes quiet so you can actually talk.

---

## Inspiration

At a career fair you meet 30 people in two hours. You forget who does what, you freeze on the opener, and by the fifth booth every question sounds like "so, what do you do?" We are two UCLA freshmen, and this is exactly where we feel behind: upperclassmen seem to arrive knowing what to ask.

The tools that exist for this either live on a phone (which means looking down, which means not looking at the person) or they talk to you during the conversation. Several hackathon projects whisper suggestions while someone is speaking, and some use a camera to recognize faces. We wanted the opposite. The best moment for help is the five seconds before you start talking, and the best help during the conversation is none at all. That is the Even Realities idea of "Quiet Tech," and it shaped every decision.

## What it does

Cue is an app for Even Realities G2 smart glasses.

1. You read a name badge and hold the temple (long press). You quietly say a name, a company, and a role: "Priya, Anduril, recruiter."
2. Release. The lens shows `Looking up...` and echoes what it heard (`Heard: Priya | Anduril | recruiter`) so you can catch a mistake.
3. Three cards appear, one at a time, with a source line on each:
   - **Connect:** an opener that is not small talk, such as a shared background or a question about their own work.
   - **Context:** their role and what their company is focused on now.
   - **Your angle:** how this person fits your goal for the event (internship, cofounder, mentorship, and so on), and one specific thing to ask.
4. Tap or swipe to flip. After you finish reading, or after 25 seconds, the HUD drops to one dim status line. Nothing pops up while you are talking.
5. Switch your goal from the glasses menu (for example Internship to Cofounder) and only the third card changes.

Cue has no camera, no face recognition, and no always-on listening. Audio is captured only while you hold the press, and it is discarded after transcription. It uses public professional information only: talks, personal sites, company pages, and search-result snippets. It never reads LinkedIn pages, and it filters out family, home, health, and politics.

When Cue is not sure who someone is, it says so. If the name could match several people, the lens asks "Which Priya?" and you pick. If you pick none, or nothing is found, you get a company card that begins "No public info found for Priya." It does not guess.

## How Cue uses each sponsor

**Even Realities (G2 + Even Hub).** Cue is built as an Even Hub app with the Even Hub SDK and runs on real G2 hardware. We designed for the "quiet by design" rule: one fixed three-container layout (header, body, footer) that is created once and updated in place, no flicker, no rebuilds, and a dim one-line status in place of a black screen. Input is the temple touchpad: long press to talk, tap and swipe to flip cards, double tap for the system exit dialog, and the contextual menu for goal switching. We use the glasses microphone for push-to-talk and the SDK background/foreground events so the menu overlay does not disturb state. We tuned the display to measured hardware limits (see Challenges).

**CREAO (AI-First Disruptor).** Cue uses four CREAO agents, built on agent.creao.ai, and the product breaks without them. They do the deep work before and after the conversation. Before the event, the **Event Loader** agent reads the event's company and speaker list and builds the store of organizations that makes company cards appear in about two seconds; the **Person Researcher** agent runs multi-step research on each person we expect to meet; and the **Brief Writer** agent turns that research into a checked three-card brief. [Unverified: today the event file loads the Person Researcher's facts and headline, and Haiku writes the live cards from them; loading the Brief Writer's cards is backend work.] Claude Haiku 5.5 handles the two seconds in between (speech-to-text, search, one fast model call). After each conversation, the wearer speaks a 10-second debrief in their own words and the **Follow-up Writer** agent takes the brief, the debrief, the wearer's goal and profile and drafts a follow-up email, a short iMessage and two or three next steps, which Photon delivers to the wearer. The agents are run by hand before and after the event and their JSON is loaded into the backend's event data (`backend/data/<event>.json`). Remove the agents and there is no event, no company context, no researched brief, and no follow-up. CREAO agent IDs: 7ed5ac12-fb85-4545-9e4e-abbeaa25db1a, e496e45b-c8eb-4079-9aff-876071501d67, d5ded73b-03b6-407d-be3e-5d332d6e869a, [FOLLOW-UP WRITER AGENT ID]. Example run share link: https://agent.creao.ai/share/aa9e8fec817ba50138997a79b610d5cc. We show an agent running in the demo video.

**Sentry.** The backend is instrumented with Sentry tracing and Sentry logs, so one lookup shows up as a single trace with spans for speech-to-text, store lookup, web search, and the language model. That is how we found where our seconds go. We never log audio. [CONFIRM BEFORE SUBMITTING: Sentry is live and a trace link is available: [SENTRY TRACE LINK]. If Sentry was cut, delete this paragraph.]

**Photon (iMessage).** After a conversation, the wearer holds the temple and gives a 10-second debrief in their own words ("he said email him about Seer, hiring interns for summer"). The other person is never recorded. The Follow-up Writer agent turns the brief and the debrief into a follow-up email, a short message and next steps, and when the wearer picks "Text me a recap" from the glasses menu, Photon (Spectrum) texts them to the wearer by iMessage, never to the person they met: the backend refuses any number but the wearer's, and the Photon project allowlist enforces the same rule. The wearer can reply "email", "text" or "who did I meet" and get an answer in the same thread. This keeps the follow-up on the phone so the glasses stay quiet during the event. [OPTIONAL / CONFIRM BEFORE SUBMITTING: one real end-to-end send has been done, the glasses-side debrief capture exists, and the Follow-up Writer output is wired into the recap. Unverified as of writing: the end-to-end send on the free plan, the glasses app capturing a debrief (only the backend route `POST /api/briefs/:id/debrief` exists), and the backend reading the `followUp` field from the event file. If any is not done, trim this paragraph to the recap that is live, or delete it and move it to What's next.]

**MLH: Vultr and GoDaddy.** The Cue backend (speech-to-text proxy, store, search, brief writer, Photon recap) runs on a Vultr cloud server behind HTTPS, because the glasses app can only call a whitelisted HTTPS host. [GODADDY: our domain is [DOMAIN].tech/[DOMAIN] and it points at the Vultr server. If the GoDaddy domain was not used, say "we used an sslip.io hostname" or delete this clause.] The server holds all API keys so none ship in the glasses app.

## How we built it

- **Glasses app:** TypeScript and Vite, using the Even Hub SDK, running inside the Even Realities phone app. One state machine (Ready, Listening, Thinking, Card, Confirm, Quiet, Error). A `render()` function sends only changed text containers with `textContainerUpgrade`. Text is measured with Even's pretext library so every card is cut at a word to fit the lens.
- **Push-to-talk:** the app starts the glasses microphone on long press, buffers raw audio, and stops on release (plus a short tail so the last word is not clipped). Clips under 0.4 seconds are discarded.
- **Backend:** Node, Express, and TypeScript on Vultr. Speech-to-text with Deepgram, with the event's company and people passed in as keywords so names like "Anduril" transcribe correctly. Web search with Exa, filtered so a result counts only if it mentions both the name and the company. One fast Claude call (`claude-haiku-5-5`, configurable) writes the three cards as validated JSON, then a code-side safety filter drops blocked topics and any LinkedIn source.
- **CREAO agents:** Event Loader, Person Researcher, Brief Writer and Follow-up Writer, built in the agent.creao.ai UI and run by hand before and after the event. Their JSON output is loaded from `backend/data/<event>.json` (prompts and test inputs in `agents/`). The backend cannot start these runs itself: the CREAO /v2 API only runs API-created agents.
- **Laptop mirror:** the same `Screen` the glasses show is rendered as HTML so judges can see it. [CONFIRM: phone screen mirror or /mirror page.]
- **Setup page:** paste your profile, pick your goal, load the event.

## Challenges we ran into

- **Push-to-talk had no documented answer.** We did not know whether a plain long press would reach the app. We tested on a real G2: a long press arrives as system event 9 and the release as event 10, from either temple. That let us ship true hold-to-talk. We kept tap-to-toggle behind a flag as a fallback.
- **The screen was showing partial lines.** Our first body container was 200 px tall and showed 5 to 6 lines with a half-cut line at the top and bottom. The firmware uses a fixed 27 px line height, and our inner heights (32 px and 188 px) were not multiples of 27. We rebuilt the layout so every inner height is an exact multiple of 27: header and footer are one line each, and the body is exactly five lines (135 px). Then we cut text at a word boundary to guarantee it never needs to scroll. [CONFIRM: re-verified on hardware with no partial lines.]
- **The 5-line card budget.** The font is proportional, about 49 digits fit on a line but far fewer wide letters, so we capped card bodies at 200 characters over at most 5 lines and wrote the card prompts around "lead with the fact, end with something you can say."
- **Brightness.** We tested the four text levels against a bright cloudy sky. Levels 2, 3 and 4 are readable; level 1 is not. So content uses 3 and 4 and the quiet status line uses 2, never 1. A black screen is also against Even's review rules, so Quiet mode is a dim line, not nothing.
- **Gestures arrive in different places.** Taps came in as system events with an undefined type (a protobuf quirk where 0 is omitted), swipes came in as text events, and opening the menu fires foreground events even though our page stays mounted. We handle all of these idempotently so opening the menu does not wipe your card.
- **Audio is real time.** The mic streams 50 ms frames, the first arrives about 450 ms after the press, and a couple arrive after we stop. Peaks hit full scale when speaking normally, which may clip, so we watch transcription accuracy and echo the transcript on screen.
- **Networking at a university.** eduroam blocks phone-to-laptop traffic, so during development we put the phone and laptop on a phone hotspot.
- **Telling people apart.** Searching "Priya at Anduril" can return the wrong Priya. We keep a result only if it mentions both name and company, and when we are not sure, we ask on the lens instead of guessing.

## Accomplishments that we're proud of

- It runs on real G2 glasses, not only a simulator, with hold-to-talk that works on a plain long press.
- Hardware findings written down and fed back into the design: the 27 px line rule, the 5-line body, the brightness floor.
- A product that is quiet. The most important screen in Cue is the dim one-line status that appears while you talk to a person.
- Honest behavior. When nothing is found, Cue says "No public info found" and shows a company card instead of making something up.
- A privacy position we can say in one breath: no camera, no face recognition, no recording, public professional information only.
- Two first-years shipped a glasses app, a cloud backend, and four agents in one weekend. [CONFIRM THE LATENCY: median time from release to first card on venue wifi was [X.X] seconds over [N] runs.]

## What we learned

- Design for the display you have. A 576 by 288 monochrome HUD with a fixed font means every character is a decision. Measuring on hardware beat reading the docs.
- "Quiet" is a feature you have to build, not the absence of one. The auto-quiet timeout, the dim status line, and refusing to pop up updates during a conversation took real work.
- Agents are best used where waiting is acceptable. The fast path (speech, search, one model call) has to answer in seconds. The CREAO agents run for minutes, so they do the work that belongs before the conversation (the event store and the researched briefs) and after it (the follow-up email, message and next steps written from the wearer's own debrief).
- Echoing what the system heard is cheap and prevents most speech-to-text mistakes from becoming wrong cards.
- Keep keys off the device. The glasses app talks to one HTTPS backend and holds no secrets.

## What's next

- Past-conversation memory so Connect can say "you met Priya at the fall fair."
- Fully automatic follow-up: today the Follow-up Writer runs by hand on CREAO and its JSON is loaded into the event data; next is starting it from the backend when CREAO exposes UI-built agents to the API, and an end-of-event summary of everyone you met in one iMessage.
- Importing a real attendee list (Luma, speaker lists) with one tap.
- An offline cache of company cards for venues with poor wifi.
- Letting the person opt out or correct their card, and an on-lens way to see exactly which sources were used.
- A ring or temple gesture shortcut for switching goals without opening the menu.

## Honesty note: what is live and what is preloaded

- **Live:** the push-to-talk audio, the speech-to-text, the web search for the person, and the model call that writes the cards. Person lookup is real web search, not a lookup table of canned answers.
- **Preloaded:** the demo event. We loaded it with a handful of people who have public bios, and who agreed to be in the demo, so a judge sees a strong result. A person with no public footprint gets the "No public info found" company card.
- **Deeper brief timing:** CREAO runs take minutes. The researched facts for the demo people were produced by the Person Researcher agent before the event and loaded into the event data, so the glasses show cards built from them live without waiting (the Brief Writer's checked brief is part of the same pre-event chain; loading its cards is backend work). The Follow-up Writer runs after the conversation; in the demo we show that run on the laptop.
- **Not built / not claimed:** [LIST ANYTHING CUT, for example Photon, Sentry, offline cache.] We do not claim camera features, face recognition, or recording, because none exist.

## Built with

Even Realities G2, Even Hub SDK, @evenrealities/pretext, TypeScript, Vite, Node.js, Express, SQLite, zod, Deepgram (speech-to-text), Exa (web search), Anthropic Claude (`claude-haiku-5-5`), CREAO agents, Vultr, GoDaddy [IF USED], Sentry [IF USED], Photon [IF USED], Caddy [IF USED].

## Links

- GitHub: [REPO URL]
- Demo video: [VIDEO URL]
- CREAO agent IDs and run share link: in the README and above
- Try it: the Even Hub build [LINK OR QR IF PUBLIC], backend at [BACKEND URL]
