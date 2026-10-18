# Devpost form, field by field

Copy each block into the matching field. Long story: `docs/devpost.md` has the full version; the "About the project" block below is the condensed one that fits a judge's attention.

## Project overview

**Project name**
```
Cue
```

**Elevator pitch** (under 200 characters)
```
Quiet networking help on Even Realities G2: hold a temple, say a name, three cards appear, then the lens goes quiet. CREAO agents handle everything before and after.
```

**Thumbnail**: a lens shot of the three cards, or the mirror page at 3:2.

## Project details

**About the project** (Markdown)

```markdown
## Inspiration
At a career fair you meet thirty people in two hours. You forget who does what, you freeze on the opener, and by the fifth booth every question is "so, what do you do?" We are two UCLA freshmen and that is exactly where we feel behind. The tools that exist either live on a phone (looking down, not at the person) or whisper at you mid-conversation. We wanted the opposite: help in the five seconds before you start talking, nothing during, and real follow-through after. That is Even Realities' "quiet tech", and it shaped every decision.

## What it does
**Before the event.** Text Cue's iMessage line "I'm going to LA Hacks tomorrow, sponsors are Even Realities, CREAO, Sentry and Photon." A CREAO Research agent builds the event pack (what each org is focused on, who is hiring, with sources) and texts you when it is ready. "look up David Cramer, Sentry" preps you for anyone.

**The live moment, on the glasses.** Hold the temple, say "David Cramer, Sentry, co-founder." About three seconds later three cards appear on the lens: Connect (one specific opener), Context (who they are, what the org is doing now), Your angle (what to ask for, tied to your goal and your own projects). Tap to flip. Then the lens goes quiet: one dim line while you talk. If nothing public exists about the person, it says so and shows the company instead of inventing anything. Misheard names snap to the attendee list ("David Kramer" becomes David Cramer).

**Everything you say is spoken, not a menu.** A decision model routes each utterance: a lookup, a correction ("Cramer with a C"), a debrief, a goal change ("I'm looking for a cofounder"), "text me the recap", "how did I do today?", or "never mind". Recording a conversation needs the other person's permission, so the lens asks first: "Ask them: OK if my glasses take notes? Tap once they say yes."

**After the conversation, on your phone.** Hold the temple and say what happened in your own words. Within seconds a short recap arrives by iMessage. In the background the CREAO Follow-up agent researches what came up, then writes the email, a short message, next steps, three meeting times, a tentative hold on your own calendar and a Gmail draft. Reply "email", "text" or "book" when you want them. Nothing is ever sent to the person you met.

**Over the day and the weeks.** Every stage is recorded in the Cue Journal (speech verbatim, cards, debriefs, consented transcripts, texts, follow-ups, times, coaching). The CREAO Coach agent reads it on a nightly schedule with extended memory, keeps a "Cue Connections" sheet, renders a dashboard, and answers "how did I do today?" with patterns, who to follow up with first, and one thing to do differently.

## How CREAO is used, and what stops without it
Three agents built on agent.creao.ai, started from our backend through CREAO's per-agent App API (webhooks plus polling), with extended memory, Gmail-draft and Google Calendar connectors on Follow-up, Google Sheets on Coach, Browser Use on Research, Autonomy Auto, and a nightly schedule on Coach. Remove the CREAO keys and Cue degrades to the three-second cards and nothing else: no event pack from a text, no follow-up email or times ("email" answers that the agent is not connected), no coaching, no sheet. The three-second path stays on Claude Haiku on purpose: a CREAO run is a sandboxed, memory-backed job that takes one to several minutes, the right tool for everything before and after a conversation and the wrong one for the two seconds inside it.

| Agent | ID | Link |
|---|---|---|
| Cue Research (event pack, person research, final cards) | `5283bd7f-cc11-4b29-902b-2debe558b46f` | https://agent.creao.ai/install/5283bd7f-cc11-4b29-902b-2debe558b46f?version=4c8c119a-7514-4dca-9e6b-64798d859bbd |
| Cue Follow-up (email, message, next steps, times, calendar hold, Gmail draft) | `7a639acb-b15a-4d88-b66d-c76831b92ddf` | https://agent.creao.ai/install/7a639acb-b15a-4d88-b66d-c76831b92ddf?version=e2188ecf-8212-4b00-a590-4396a046cc07 |
| Cue Coach (journal, Connections sheet, dashboard, coaching, nightly with memory) | `b095ddf1-cccc-42ae-a381-ccc7906b14a4` | https://agent.creao.ai/install/b095ddf1-cccc-42ae-a381-ccc7906b14a4?version=58dfa39f-5361-4cb3-9e04-e92d421dda4f |

Run share links: [RUN SHARE LINKS]

## How we built it
- **Glasses app**: TypeScript, Vite, Even Hub SDK, inside the Even Realities phone app. One state machine, one fixed three-container layout updated in place, text cut at a word to fit the lens. Push-to-talk on a plain long press (system events 9 and 10, found on hardware). The app holds no keys.
- **Backend**: Node, Express, TypeScript on AWS Lightsail behind Caddy (HTTPS, the glasses require it). Deepgram speech-to-text with the event's names as boost terms; Exa web search (LinkedIn professional sections allowed) filtered so a result counts only if it names both the person and the org; one Claude Haiku 5.5 call writes the cards as validated JSON; a code-side safety filter drops private topics.
- **Decision model, twice**: the OpenAI Decisions API routes spoken intents with calibrated probabilities, and gates each brief before the writer (is this the person you named, is it worth your eyes, which card leads, is any fact sensitive). A decision model says no with a number you can threshold; a chat model's confidence is prose.
- **CREAO orchestration**: `backend/src/creao.ts` holds the transport and one apply function per agent (zod-validated JSON). `say.ts` starts Follow-up after a debrief; `coach.ts` builds the day's history; `events.ts` starts Research from a text or the setup page. The Cue Journal (`journal.ts`) is served as Markdown so scheduled agents read it without the backend.
- **Photon (Spectrum iMessage)** delivers everything after the live moment to the wearer only; the backend refuses any other number.
- **Sentry** traces the live path: `stt`, `store lookup`, `search`, `llm`, and the gate's timing. Sizes and timings only, never audio or transcripts.

## Challenges we ran into
- The lens showed cut-off lines until we learned the firmware's fixed 27 px line height and rebuilt the layout as exact multiples: one line header and footer, a five-line body.
- Hold-to-talk was undocumented; a real G2 told us a long press arrives as system event 9 and the release as 10.
- Telling people apart: "Priya at Anduril" returns the wrong Priya, and "Cramer" transcribes as "Kramer". Name-and-org filtering, a decision gate before any card, keyterm boosting, and snapping to the attendee list within two edits.
- Agents that write to the world: an API-started CREAO run cannot create a calendar hold unless the agent's Autonomy is Auto, and an agent that answers in prose breaks the chain, so every prompt ends with "end with exactly one json block" and the backend searches the reply and its artifacts for it.
- The texts sounded like consultant reports. We wrote a one-page texting voice, put it in every agent, and had the backend shape output into short bubbles. The wearer vetoed anything over four texts per conversation.
- eduroam blocks phone-to-laptop traffic, so development ran on a hotspot and the demo runs on the server.

## Accomplishments that we're proud of
- It runs on real G2 glasses: spoken lookup, debrief, coach question, goal change and consented recording, all verified on hardware against the deployed backend.
- Honest behavior: "No public info found" instead of cards about a stranger; one quiet line when the facts do not serve your goal.
- Three CREAO agents verified live, chained before, after and across the day, and a journal that lets long-horizon agents work without us.
- A privacy position in one breath: no camera, no face recognition, no recording without on-screen consent, public professional information only, nothing ever sent to the other person.
- Two first-years shipped a glasses app, a cloud backend, an iMessage line and three agents in one weekend. Release to first card on the server: about 3 seconds (2.4 to 4.0 over tonight's runs).

## What we learned
Design for the display you have: on a 576 by 288 monochrome lens every character is a decision, and measuring on hardware beat reading the docs. "Quiet" is a feature you build. Agents belong where waiting is acceptable; the live path has to answer in seconds. Use a decision model to decide and a generative model to write. Consent is a screen, not a policy sentence.

## What's next
Past-conversation memory in the Connect card ("you met Priya at the fall fair"), a reply "send" that sends the scheduling message from the wearer's own account, attendee-list import with one tap, and a Speech Coach on the journal for delivery and filler words (spec written, not yet live).
```

**Built with** (tags, up to 25)
```
even-realities-g2, even-hub-sdk, typescript, vite, node.js, express, zod, claude-haiku-5.5, anthropic-api, openai-decisions-api, creao, creao-app-api, photon, spectrum-imessage, deepgram, exa, sentry, aws-lightsail, caddy, systemd, google-calendar, gmail, google-sheets
```

**"Try it out" links**
```
https://github.com/alphagengar1/cue
https://agent.creao.ai/install/5283bd7f-cc11-4b29-902b-2debe558b46f?version=4c8c119a-7514-4dca-9e6b-64798d859bbd
https://agent.creao.ai/install/7a639acb-b15a-4d88-b66d-c76831b92ddf?version=e2188ecf-8212-4b00-a590-4396a046cc07
https://agent.creao.ai/install/b095ddf1-cccc-42ae-a381-ccc7906b14a4?version=58dfa39f-5361-4cb3-9e04-e92d421dda4f
```

**Image gallery**: lens shots of the three cards and the consent screen, the phone thread (recap, "email", "book", coach), the CREAO Sessions tab, the Coach dashboard, the mirror page. Hide the Photon number.

**Video demo link**: [VIDEO URL]

## Additional info

- **GitHub repo**: https://github.com/alphagengar1/cue (public)
- **Track**: pick the one event track that fits best (AI / wearables / consumer, whichever is listed); then every company challenge that applies: CREAO, Even Realities, Sentry, Photon.
- **Emails / names / schools**: your registered emails, "Swaraj Adhikari, <teammate>", UCLA.
- **GoDaddy domains**: none.
- **Feedback on tech** (paste):
```
Even Realities G2 / Even Hub SDK: solid once we learned the fixed 27 px line height and that a long press arrives as sysEvent 9/10; both deserve a line in the docs. CREAO: the per-agent App API with webhooks was the piece that made agents central; a documented "fast run" mode for API-triggered agents would open the live path too. Photon (Spectrum): the shared iMessage line worked first try; multi-bubble sends and an allowlist are exactly right for a wearer-only channel. Sentry: tracing the live path told us where the seconds go. OpenAI Decisions API: calibrated numbers you can threshold are the right tool for routing and gating; wish for a published latency figure.
```
- **AI tools used this weekend**: Claude Code, Claude (Haiku 5.5 in the product), OpenAI Decisions API (gpt-6-luna), CREAO agents, Deepgram.
- **Did you implement a generative AI model or API** (paste):
```
Yes. Claude Haiku 5.5 (Anthropic API, structured outputs, thinking disabled) writes the three cards in about 2 seconds and the instant iMessage recap, because the live path has about three seconds. The OpenAI Decisions API (gpt-6-luna) routes spoken intents and gates each brief with calibrated probabilities, because a decision model can say no with a number we can threshold. Three CREAO agents (built on agent.creao.ai, started through the per-agent App API) do the research before the conversation, the follow-up email, times and calendar hold after it, and the nightly coaching with extended memory, because that work can take minutes and benefits from memory and connectors. Deepgram transcribes push-to-talk audio with the event's names as keyterms.
```
- **Gemini project number**: N/A
- **ASI:One handles**: N/A unless registered.
