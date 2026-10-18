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

At a career fair you meet thirty people in two hours and forget all of them by dinner. We're two UCLA freshmen, and we freeze on the opener every time. Every tool for this either makes you look down at a phone or whispers in your ear while someone is talking to you. We wanted the opposite: help in the five seconds before you open your mouth, nothing during, and the follow-up actually sent after.

## What it does

Hold the temple of your Even Realities G2 and say "Tim Cook, Apple, CEO." Three seconds later the lens shows three cards: how to open, who they are, what to ask for given your goal and your own projects. Then it goes quiet. One dim line while you talk. If it can't find anything public about the person, it says so instead of making something up.

When you're done, hold the temple again and say what happened. Your phone gets a four-line recap by iMessage. In the background a CREAO agent researches what came up and writes the email, next steps, three times to meet, and a tentative hold on your calendar. Reply "email" or "book" when you want them. Nothing is ever sent to the person you met.

Text the line "I'm going to LA Hacks tomorrow" the night before and a Research agent builds a pack of who's there and who's hiring. Ask "how did I do today?" and a Coach agent that has read every conversation, with memory of earlier days, tells you who to chase first and one thing to do differently. Two more scheduled agents read the same journal: a Speech Coach that scores your verbatim debriefs for filler words and pacing, and a Relationships agent that flags stale follow-ups each week.

## How we built it

A TypeScript app on the Even Hub SDK, running inside the Even phone app, that holds no keys and talks to one backend. The backend (Node, on AWS behind HTTPS) does the three-second path: Deepgram for speech with the event's names as boost terms, Exa for facts, one OpenAI Decisions API call to decide whether this is really the person you named and whether it's worth your eyes, one Claude Haiku call to write the cards.

Everything slower than three seconds is a CREAO agent, started through CREAO's per-agent API: Research before the conversation, Follow-up after it (Gmail draft and Google Calendar connectors), Coach over the day (Google Sheets, extended memory, nightly schedule). Every stage lands in a journal the agents read on their own, so long-horizon agents don't need our backend at all. Photon's iMessage line carries everything to the wearer.

Agents (IDs and links):
Research `5283bd7f-cc11-4b29-902b-2debe558b46f`,
Follow-up `7a639acb-b15a-4d88-b66d-c76831b92ddf`,
Coach `b095ddf1-cccc-42ae-a381-ccc7906b14a4`.
Install links are in the Try it out section; run share links: [RUN SHARE LINKS].
Pull the CREAO keys and Cue is just three cards and nothing after.

## Challenges we ran into

- The lens cut lines in half until we found the firmware's fixed 27 px line height and rebuilt the layout as exact multiples of it.
- Deepgram can mishear names, so we boost terms, use name-and-org filtering, and snap to the attendee list within two letters.
- An agent started over the API can't touch your calendar unless its autonomy is set to Auto. It silently skips instead; this took us an hour to find.
- The first agent texts read like consultant reports. One page of voice rules and a hard cap of four texts per conversation fixed it.
- The UCLA wifi blocks phone-to-laptop traffic, so we use an AWS box.

## Accomplishments that we're proud of

- It runs on real glasses. Spoken lookup, debrief, coach, goal change, and consented recording, all on the G2 against the deployed backend.
- When not enough information is found, it says "no public info found" instead of lying.
- Three CREAO agents doing the heavy work before, after, and across the day, and a journal that lets more agents join without touching our code.
- No camera, no face recognition, no recording without a consent screen the other person sees you tap, and nothing ever sent to them.

## What we learned

On a 576 by 288 monochrome lens every character is a decision, and measuring on hardware beat reading the docs. "Quiet" is a feature you have to build. Agents belong where waiting is fine; the live path has to answer in seconds. Use a decision model to decide and a generative model to write.

## What's next

Past-conversation memory on the Connect card ("you met Priya at the fall fair"), a "send" reply that sends the follow-up from your own account (today you press send yourself, on purpose), and one-tap import of an attendee list.
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
