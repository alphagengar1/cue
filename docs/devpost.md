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
2. Release. The lens shows `Looking up...` and echoes what it heard (`Heard: Priya | Anduril | recruiter`) so you can catch a mistake. If what it heard is within two edits of someone on the event list, the cards are for that person: "David Kramer" is looked up as David Cramer (the echo line still shows what was heard).
3. Three cards appear, one at a time, with a source line on each:
   - **Connect:** an opener that is not small talk, such as a shared background or a question about their own work.
   - **Context:** their role and what their company is focused on now.
   - **Your angle:** how this person fits your goal for the event (internship, cofounder, mentorship, and so on), and one specific thing to ask.
4. Tap or swipe to flip. After you finish reading, or after 25 seconds, the HUD drops to one dim status line. Nothing pops up while you are talking.
5. Hold the temple and say anything else. A decision model picks what you meant (a plain "name, company, role" is routed by rules) and the backend does it:
   - "Priya Shah, Anduril, recruiter": a lookup, three cards.
   - "Cramer with a C" or "no, it's Priya not Maya": a correction, the last lookup re-runs with the fixed name.
   - "he said email him about Seer, they're hiring interns": a debrief, the note is saved on the brief and the recap is texted to you.
   - "I'm looking for a cofounder": a goal change, the angle card is rewritten and the other two stay.
   - "text me the recap": the recap is texted.
   - "never mind": back to quiet.
   - Anything else gets one quiet line with a hint.

   The menu is four items: Talk, Last brief, Text me a recap, Go quiet. Unverified: the spoken intents and the "nothing for your goal" quiet line were built Oct 17 late and not yet tested on the glasses.

Cue has no camera, no face recognition, and no always-on listening. Audio is captured only while you hold the press, and it is discarded after transcription. It uses public professional information only: talks, personal sites, company pages, and search-result snippets. It never reads LinkedIn pages, and it filters out family, home, health, and politics.

When Cue is not sure who someone is, it says so. If the name could match several people, the lens asks "Which Priya?" and you pick. If you pick none, or nothing is found, you get a company card that begins "No public info found for Priya." It does not guess. And when the person is real but the facts offer nothing for your goal, you get one quiet line ("Priya: nothing for your goal") instead of three cards; the cards stay under Last brief.

## How Cue uses each sponsor

**Even Realities (G2 + Even Hub).** Cue is built as an Even Hub app with the Even Hub SDK and runs on real G2 hardware. We designed for the "quiet by design" rule: one fixed three-container layout (header, body, footer) that is created once and updated in place, no flicker, no rebuilds, and a dim one-line status in place of a black screen. Input is the temple touchpad: long press to talk (and to say a correction, a debrief or a new goal), tap and swipe to flip cards, double tap for the system exit dialog, and a four-item contextual menu (Talk, Last brief, Text me a recap, Go quiet). We use the glasses microphone for push-to-talk and the SDK background/foreground events so the menu overlay does not disturb state. We tuned the display to measured hardware limits (see Challenges).

**CREAO (AI-First Disruptor).** Cue uses six CREAO agents, built on agent.creao.ai, and the product breaks without them. Every one is started by our backend over CREAO's per-agent app API (each agent has its own `capi_` key on the server; the backend posts the agent's inputs, takes the result by webhook or polling, validates the JSON and applies it). They are orchestrated in three chains. **Before and during the event:** the **Event Loader** reads the company and speaker list and builds the store of organizations that makes company cards appear in about two seconds; after a confident lookup the **Person Researcher** runs multi-step research on the person, and when it completes the **Brief Writer** turns that research into a checked three-card brief (Brief v3 with an `improvesOn` note). Claude Haiku 5.5 handles the two seconds in between (speech-to-text, search, one fast model call). **After each conversation:** the wearer speaks a 10-second debrief in their own words and the **Follow-up Writer** drafts a follow-up email, a short iMessage and next steps; when it finishes, the **Meeting Scheduler** turns that into three proposed times, a scheduling message in the wearer's voice and, through its Google Calendar connector, a tentative 30-minute hold on the wearer's own calendar. **Over the whole day:** the **Networking Coach** is the long-run agent (see below). The Follow-up Writer, the Scheduler and the Coach also get the conversation transcript when one exists, recorded only after a consent line on the lens and a tap. Photon texts every result to the wearer; no agent ever contacts the other person. Remove the agents and there is no event, no company context, no researched brief, no follow-up, no next meeting and no coaching. CREAO agent IDs: Event Loader 7ed5ac12-fb85-4545-9e4e-abbeaa25db1a, Person Researcher e496e45b-c8eb-4079-9aff-876071501d67, Brief Writer d5ded73b-03b6-407d-be3e-5d332d6e869a, Follow-up Writer [FOLLOW-UP WRITER AGENT ID], Meeting Scheduler [MEETING SCHEDULER AGENT ID], Networking Coach [NETWORKING COACH AGENT ID]. Run share links: https://agent.creao.ai/share/aa9e8fec817ba50138997a79b610d5cc (Event Loader), https://agent.creao.ai/share/21c460878c2ec3e4eed039a5a327e0e6 (Person Researcher), https://agent.creao.ai/share/5922c0b96ff6085300d95090eeb4bc58 (Brief Writer), [FOLLOW-UP WRITER SHARE LINK], [MEETING SCHEDULER SHARE LINK], [NETWORKING COACH SHARE LINK]. We show an agent running in the demo video. [Unverified, Oct 17 late: the Person Researcher -> Brief Writer chain has run live from the backend (lookup -> fast cards in 3.4 s -> 6 facts kept -> Brief v2 -> Brief v3). The Follow-up Writer, Meeting Scheduler and Networking Coach are wired in the backend but have not yet been run live from it; fill their IDs and links after the first live run, or trim this paragraph to what ran. The calendar hold needs the connector on the agent, and cross-day memory needs extended memory switched on.]

**The long-run analysis the CREAO team asked for.** Most of Cue is fast: a card in seconds, then quiet. The **Networking Coach** is the opposite, and it is where CREAO's extended memory matters. It sees the wearer's whole day as one input: every brief the glasses showed, every spoken debrief, every consented conversation transcript, and which follow-ups were sent. With extended memory on, it also remembers its earlier runs and earlier days. It returns four things the wearer cannot see in the moment: patterns across conversations (topics that keep coming up, asks that worked, what the wearer keeps forgetting, such as never asking for a next step), the two or three people to follow up with first and the concrete action for each, specific coaching for the next conversation, and one line to read before it. It runs when the wearer says or texts "how did I do today?" or "who should I follow up with?", and automatically after every third debrief of the day, and Photon texts the result as a few short bubbles. It never contacts anyone but the wearer. [Unverified: wired in `backend/src/creao.ts` (`applyNetworkingCoach`) and `backend/src/coach.ts`; not yet run live from the backend as of Oct 17 late.]

**Sentry.** The backend is instrumented with Sentry tracing and Sentry logs, so one lookup shows up as a single trace with spans for speech-to-text, store lookup, web search, and the language model. That is how we found where our seconds go. We never log audio. [CONFIRM BEFORE SUBMITTING: Sentry is live and a trace link is available: [SENTRY TRACE LINK]. If Sentry was cut, delete this paragraph.]

**Photon (iMessage).** After a conversation, the wearer holds the temple and says what happened in their own words ("he said email him about Seer, hiring interns for summer"). The other person is never recorded. The decision model classifies it as a debrief, the note is saved on the brief, and Photon (Spectrum) texts the recap to the wearer by iMessage; "Text me a recap" in the glasses menu and saying "text me the recap" do the same without a note. Haiku writes the texts in a texting voice, with templates as the fallback, and the Follow-up Writer agent turns the brief and the debrief into a follow-up email, a short message and next steps. Photon only ever messages the wearer, never the person they met: the backend refuses any number but the wearer's, and the Photon project allowlist enforces the same rule. Real end-to-end sends are verified (a David Cramer brief, 4 bubbles, 205 chars). The wearer can reply "email", "text" or "who did I meet" and get an answer in the same thread. This keeps the follow-up on the phone so the glasses stay quiet during the event. [CONFIRM BEFORE SUBMITTING: the glasses-side debrief capture exists through `POST /api/say` (stored by `POST /api/briefs/:id/debrief`) but is Unverified on hardware as of Oct 17. Still unverified: the backend reading the `followUp` field from the event file. If that is not done, trim the Follow-up Writer sentence to what is live.]

**Hosting (AWS).** The Cue backend (speech-to-text proxy, store, search, brief writer, CREAO runs, Photon recap) runs on an AWS Lightsail instance behind Caddy with automatic HTTPS at https://35.164.205.54.sslip.io, because the glasses app can only call a whitelisted HTTPS host. The server holds all API keys so none ship in the glasses app. [If an MLH Vultr/GoDaddy paragraph is still wanted, note that the deployed backend is on AWS, not Vultr.]

## How we built it

- **Glasses app:** TypeScript and Vite, using the Even Hub SDK, running inside the Even Realities phone app. One state machine (Ready, Listening, Thinking, Card, Confirm, Quiet, Error). The menu is the four items above; everything else is spoken and sent to `POST /api/say`. A `render()` function sends only changed text containers with `textContainerUpgrade`. Text is measured with Even's pretext library so every card is cut at a word to fit the lens.
- **Push-to-talk:** the app starts the glasses microphone on long press, buffers raw audio, and stops on release (plus a short tail so the last word is not clipped). Clips under 0.4 seconds are discarded.
- **Backend:** Node, Express, and TypeScript on AWS Lightsail behind Caddy. Speech-to-text with Deepgram, with the event's company and people passed in as keywords so names like "Anduril" transcribe correctly. Web search with Exa, filtered so a result counts only if it mentions both the name and the company. An intent router (`backend/src/intent.ts`) decides what a spoken transcript is asking for, and a decision gate (`backend/src/decide.ts`) checks the kept facts before any card is written. One fast Claude call (`claude-haiku-5-5`, configurable) writes the three cards as validated JSON, then a code-side safety filter drops blocked topics and any LinkedIn source.
- **Decision model, used twice:** both go to the OpenAI Decisions API (`gpt-6-luna`). The intent router asks for calibrated probabilities over lookup, correction, debrief, goal, recap, quiet and unknown. The cue gate asks four calibrated questions per brief: do these facts match the named person (below 0.6 means "No public info found" instead of cards about a stranger), do they fit the wearer's goal (below 0.5 means one quiet line instead of cards), which card should lead, and is each fact sensitive (above 0.5 means dropped). We use a decision model and not the chat model because a generative model is good at writing cards and bad at saying "no": its self-reported confidence is prose, not a calibrated number you can threshold. Both uses are optional (`OPENAI_API_KEY`), never throw, time out on the gate (`DECIDE_TIMEOUT_MS`, default 1.2 s; the design target was 700 ms), and fall back to a rules classifier and the code filters.
- **CREAO agents:** six agents (Event Loader, Person Researcher, Brief Writer, Follow-up Writer, Meeting Scheduler, Networking Coach) built in the agent.creao.ai UI and started live by the backend through CREAO's per-agent app API (`backend/src/creao.ts`, one `capi_` key per agent, webhook plus polling, JSON validated with zod before it is applied). Results are written into the same store the hand-run JSON in `backend/data/<event>.json` loads into, so a pre-event run and a live run land in the same place. Prompts and test inputs are in `agents/`. Unverified: the three after-conversation agents have not yet run live from the backend.
- **Laptop mirror:** the same `Screen` the glasses show is rendered as HTML so judges can see it. [CONFIRM: phone screen mirror or /mirror page.]
- **Setup page:** paste your profile, pick your starting goal, load the event. On the glasses, the goal is changed by saying it.

## Challenges we ran into

- **Push-to-talk had no documented answer.** We did not know whether a plain long press would reach the app. We tested on a real G2: a long press arrives as system event 9 and the release as event 10, from either temple. That let us ship true hold-to-talk. We kept tap-to-toggle behind a flag as a fallback.
- **The screen was showing partial lines.** Our first body container was 200 px tall and showed 5 to 6 lines with a half-cut line at the top and bottom. The firmware uses a fixed 27 px line height, and our inner heights (32 px and 188 px) were not multiples of 27. We rebuilt the layout so every inner height is an exact multiple of 27: header and footer are one line each, and the body is exactly five lines (135 px). Then we cut text at a word boundary to guarantee it never needs to scroll. [CONFIRM: re-verified on hardware with no partial lines.]
- **The 5-line card budget.** The font is proportional, about 49 digits fit on a line but far fewer wide letters, so we capped card bodies at 200 characters over at most 5 lines and wrote the card prompts around "lead with the fact, end with something you can say."
- **Brightness.** We tested the four text levels against a bright cloudy sky. Levels 2, 3 and 4 are readable; level 1 is not. So content uses 3 and 4 and the quiet status line uses 2, never 1. A black screen is also against Even's review rules, so Quiet mode is a dim line, not nothing.
- **Gestures arrive in different places.** Taps came in as system events with an undefined type (a protobuf quirk where 0 is omitted), swipes came in as text events, and opening the menu fires foreground events even though our page stays mounted. We handle all of these idempotently so opening the menu does not wipe your card.
- **Audio is real time.** The mic streams 50 ms frames, the first arrives about 450 ms after the press, and a couple arrive after we stop. Peaks hit full scale when speaking normally, which may clip, so we watch transcription accuracy and echo the transcript on screen.
- **Networking at a university.** eduroam blocks phone-to-laptop traffic, so during development we put the phone and laptop on a phone hotspot.
- **Telling people apart.** Searching "Priya at Anduril" can return the wrong Priya. We keep a result only if it mentions both name and company. Misheard names are a separate problem: Deepgram gets the event's names and orgs as keyterms, and the backend snaps a transcript to a listed attendee within 2 edits ("David Kramer" becomes David Cramer), so a near miss never needs a confirm screen. The "Which Priya?" screen remains only for a real ambiguity, and when we are not sure, we ask on the lens instead of guessing.

## Accomplishments that we're proud of

- It runs on real G2 glasses, not only a simulator, with hold-to-talk that works on a plain long press.
- Hardware findings written down and fed back into the design: the 27 px line rule, the 5-line body, the brightness floor.
- A product that is quiet. The most important screen in Cue is the dim one-line status that appears while you talk to a person.
- Honest behavior. When nothing is found, Cue says "No public info found" and shows a company card instead of making something up.
- A privacy position we can say in one breath: no camera, no face recognition, no recording, public professional information only.
- Two first-years shipped a glasses app, a cloud backend, and six agents in one weekend. [CONFIRM THE LATENCY: median time from release to first card on venue wifi was [X.X] seconds over [N] runs.]

## What we learned

- Design for the display you have. A 576 by 288 monochrome HUD with a fixed font means every character is a decision. Measuring on hardware beat reading the docs.
- "Quiet" is a feature you have to build, not the absence of one. The auto-quiet timeout, the dim status line, and refusing to pop up updates during a conversation took real work.
- Agents are best used where waiting is acceptable. The fast path (speech, search, one model call) has to answer in seconds. The CREAO agents run for minutes, so they do the work that belongs before the conversation (the event store and the researched briefs), after it (the follow-up and the next meeting, written from the wearer's own debrief), and across the whole day (the Coach's patterns and priorities).
- Echoing what the system heard is cheap and prevents most speech-to-text mistakes from becoming wrong cards.
- Keep keys off the device. The glasses app talks to one HTTPS backend and holds no secrets.

## What's next

- Past-conversation memory so Connect can say "you met Priya at the fall fair."
- Running the after-conversation chain (Follow-up Writer -> Meeting Scheduler) and the Networking Coach live on event day, then letting the wearer reply "book" to send the scheduling message, and an end-of-event summary of everyone you met in one iMessage.
- Importing a real attendee list (Luma, speaker lists) with one tap.
- An offline cache of company cards for venues with poor wifi.
- Letting the person opt out or correct their card, and an on-lens way to see exactly which sources were used.

## Honesty note: what is live and what is preloaded

- **Live:** the push-to-talk audio, the speech-to-text, the web search for the person, and the model call that writes the cards. Person lookup is real web search, not a lookup table of canned answers.
- **Preloaded:** the demo event. We loaded it with a handful of people who have public bios, and who agreed to be in the demo, so a judge sees a strong result. A person with no public footprint gets the "No public info found" company card.
- **Deeper brief timing:** CREAO runs take minutes. The researched facts for the demo people were produced by the Person Researcher agent before the event and loaded into the event data, so the glasses show cards built from them live without waiting; a new person triggers the Person Researcher -> Brief Writer chain live and the brief upgrades to v2 and v3 in the background. The Follow-up Writer, Meeting Scheduler and Networking Coach run after the conversation and over the day; as of Oct 17 late they are wired but have not yet run live from the backend, so in the demo we show those runs on the laptop unless that changes.
- **Not built / not claimed:** [LIST ANYTHING CUT, for example Sentry, offline cache.] We do not claim camera features, face recognition, or recording, because none exist.

## Built with

Even Realities G2, Even Hub SDK, @evenrealities/pretext, TypeScript, Vite, Node.js, Express, SQLite, zod, Deepgram (speech-to-text), Exa (web search), Anthropic Claude (`claude-haiku-5-5`), OpenAI Decisions API (`gpt-6-luna`), CREAO agents, AWS Lightsail, Caddy, Sentry [IF USED], Photon.

## Links

- GitHub: [REPO URL]
- Demo video: [VIDEO URL]
- CREAO agent IDs and run share link: in the README and above
- Try it: the Even Hub build [LINK OR QR IF PUBLIC], backend at https://35.164.205.54.sslip.io
