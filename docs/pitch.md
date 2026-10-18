# Cue - table pitch

For expo-style table visits. Person A wears the glasses. Person B talks and drives the laptop, which shows two tabs: the setup page's Judge view (`/setup?view=mirror`, the lens, large) and the CREAO Sessions tab with the live runs. Before the judge arrives: goal preset to Internship on the setup page, the mirror on the quiet line, the demo person (David Cramer, Sentry co-founder, the same person as the video script: public bio, in the preloaded event) chosen, the wearer's one "hi" text already sent to the Photon line so the links are clickable, and A's phone face up on the table with the iMessage thread open. Between judges, reset the goal on the setup page and keep the Sessions tab on the most recent runs.

## The 90-second table pitch

| Time | Beat | Say / do |
|---|---|---|
| 0:00-0:08 | Hook and live lookup | B: "Watch the glasses, not me." A reads the badge, holds the temple, says "David Cramer, Sentry, co-founder," lets go. Mirror shows `Listening`, `Heard: David Cramer | Sentry | co-founder`, then card 1 in about 3 seconds. |
| 0:08-0:22 | The three cards | B: "Three cards, each with a source. Connect is an opener that is not small talk. Context is who they are and what their company is doing now. Your angle is what to ask, given your goal." A taps through them. |
| 0:22-0:30 | Quiet | A turns to the "rep". B: "And now it is gone. One dim line. Nothing talks to you during the conversation. A little help when you need it, then out of the way." |
| 0:30-0:45 | Spoken debrief, recap, follow-up | A holds the temple: "He said email him about Seer, they're hiring interns for summer." Quiet line shows `★ note saved, recap texted`; the phone buzzes with the recap in seconds. B: "Ten seconds in your own words. The recap is instant, and in a minute or two the Follow-up agent texts a draft email and next steps; reply text for the short message." B scrolls the thread to a follow-up from earlier today while this one runs. |
| 0:45-0:55 | Times from the Follow-up agent | B points at the next bubbles in the thread: "Then the Follow-up agent proposes three half-hour times from the wearer's real calendar and puts a tentative hold on the wearer's own calendar. No guests, nothing sent. You reply `book` to get the message to send." |
| 0:55-1:08 | "How did I do today?" and the coach | A picks up the phone and texts "how did I do today?" in the same thread (the verified path; say it into the temple instead only once the spoken coach intent is tested on the G2). While the run starts, B shows the coach bubbles from the last run on the phone: "The Coach agent reads the whole day, every brief, every debrief, and compares with earlier days from memory. Patterns, who to follow up with first, and one thing to do differently." |
| 1:08-1:20 | CREAO Sessions tab | B switches to the Sessions tab. "Three CREAO agents, all started by our backend. Here is the Research agent run from the lookup you just saw, and the Follow-up agent and Scheduler from the debrief." If the lens shows the dim `★ updated` marker, point at it: "That is the Research agent rewriting the cards with sourced facts, starting about 90 seconds in." |
| 1:20-1:30 | Privacy close and offer | B: "No camera, no face recognition, no recording without a consent screen the other person sees you tap. Public professional info only, and nothing ever goes to the person you met, only to you. Want to try it?" Hand the glasses to the judge. |

Timing rule: if a judge interrupts, answer, then resume at the next beat. The beats that cannot be skipped are the live lookup, Quiet, the phone buzzing, and the Sessions tab.

### The 20-second version

"At a career fair you meet thirty people and forget who does what. Cue is a G2 glasses app: hold the temple, say a name, company and role, and three cards appear on your lens in three seconds, then it goes quiet so you can talk. Afterwards you say what happened and three CREAO agents turn it into a recap, a follow-up, a meeting time and end-of-day coaching, all texted to you and only you. No camera, no face recognition, public professional info only."

## Honesty line

Use it whenever asked how real it is: "Person lookup is real web search and every agent run you see is live. We preloaded the demo event with people who agreed to be in it and have public bios. The spoken commands beyond a plain lookup, and conversation recording, were built last night and are verified from the backend and the setup page, not yet on the glasses in front of you."

## Ten judge questions

Two sentences each. Agent IDs and share links are in the README.

**1. Isn't this creepy?**
There is no camera and no face recognition, and the wearer has to say the name out loud, so Cue only looks up someone who just introduced themselves, using public professional information with family, home, health, religion, politics, age and appearance dropped by a blocklist and a sensitive-fact check. It is what you would do by searching their name on your phone, minus looking down, and nothing Cue finds ever goes to the other person.

**2. Does it record people?**
Push-to-talk audio is discarded after transcription, and a conversation is recorded only after the lens shows the consent screen (ask them whether the glasses may take notes, tap once they say yes) and the wearer taps, with swipe up to cancel and a 15-minute cap. The transcript lives only on that brief on our backend (`brief.conversation`), rides into the Follow-up agent, Scheduler and Coach, and is never stored on the glasses or phone and never logged.

**3. Why Haiku for the three seconds and CREAO for the rest?**
The lens gives us about three seconds, so that path is Deepgram, Exa, one decision call and one Claude Haiku 5.5 call (Haiku also writes the instant texts), while the CREAO agents run for about 80 seconds to a few minutes because nobody is staring at a lens by then. The Research agent rewrite the cards with sourced facts about 90 seconds in, the Follow-up agent and Scheduler turn a spoken debrief into a draft and a calendar hold, and the Coach reads the whole day.

**4. Why a decision model and not the chat model?**
A chat model is bad at saying no, and its "confidence: 0.8" is prose you cannot threshold, so the OpenAI Decisions API (`gpt-6-luna`) routes what the wearer says (lookup, correction, debrief, goal, recap, coach, quiet) and gates each brief before the cards are written. The thresholds are plain: match below 0.6 gives "No public info found" instead of cards about a stranger, goal fit below 0.5 gives one quiet line, a sensitive probability above 0.5 drops the fact, lead picks the first card, and both calls are optional, never throw and fall back to rules.

**5. What is unverified?**
Unverified on the physical G2 as of Oct 18 early: the spoken intents (correction, debrief, goal, recap, coach, never mind), the goal-gate quiet line, and Record conversation with its consent screen and 20-second chunked streaming, all built in the last day and tested from the setup page and the backend. Everything else, the three agents started from the backend, the three chains, the calendar hold through the agent's connector, and every Photon send, was verified live tonight; the backend's own Google Calendar path is tested with stubs only, and the agent's connector made the hold you see.

**6. Does it ever contact the other person?**
Never: Photon only messages the wearer, the backend refuses any number but `WEARER_PHONE`, and the Photon project allowlist enforces the same rule. The Follow-up agent's email is saved as a Gmail draft with no recipient and is never sent, and the Follow-up agent's 30-minute hold sits on the wearer's own calendar with no guests, so the wearer sends everything by hand.

**7. You read LinkedIn?**
Only the professional sections: headline, current role, Experience, Projects and Publications, each fact kept only with a source URL, and never contact info, connections, activity, photos or anything personal in About. `ALLOW_LINKEDIN=0` restores the block, and the same blocklist and sensitive-fact check apply to every source.

**8. What if it mishears the name or picks the wrong person?**
Deepgram gets the event's names and orgs as keyterms, the lens echoes what it heard, and a transcript within two edits of one listed attendee snaps to them, so "David Kramer" is researched as David Cramer. A search result counts only if it names both the person and the org, the gate drops the brief to "No public info found" when match is below 0.6, and the "Which Priya?" confirm screen appears only for a real ambiguity.

**9. What is live and what is preloaded?**
Live: the push-to-talk audio, the speech-to-text, the Exa web search, the decision calls, the Haiku cards, every CREAO run and every Photon text. Preloaded: the demo event, with a few people who agreed to be in it and have public bios, so a judge sees a strong result instead of a lucky one.

**10. Why three agents?**
We started with six single-purpose agents and merged them by *when they run*: Research before the conversation (event pack, person research, the final cards), Follow-up right after (email, message, next steps, times, calendar hold, Gmail draft, one run), and Coach over the long run. Fewer handoffs, fewer JSON contracts, and each agent sees the whole context for its moment. The Coach is the long-running one the CREAO team asked for: it reads the Cue Journal on a nightly schedule with extended memory, keeps the Connections sheet, renders a dashboard, and texts patterns, priorities and coaching.

## If something fails

- **A spoken intent misfires** (the lens shows the hint line or the wrong action): use the Talk menu item for a plain lookup, set the goal on the setup page, and send the debrief from the laptop with the curl line below. Say that this is the part built last night.
- **Photon is slow** (no buzz within a few seconds): switch to the CREAO Sessions tab and show the run that the debrief started, then scroll the iMessage thread to the earlier recap, follow-up and times from today.
- **The coach question misfires** (spoken into the temple): text "how did I do today?" in the iMessage thread; that path is verified.
- **The hardware debrief fails**: send the same words from the laptop terminal to the path the glasses use, `curl -X POST https://35.164.205.54.sslip.io/api/say -H "Authorization: Bearer $DEVICE_TOKEN" -H "Content-Type: application/json" -d '{"text":"he said email him about Seer, hiring interns for summer"}'` (keep it ready in a terminal tab, token from `backend/.env` on the server, never shown on screen). It is the same `POST /api/say` route, so the recap, the Follow-up and Coach agents all still fire; the setup page has a typed lookup box but no debrief box.
