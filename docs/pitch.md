# Cue - table pitch

For expo-style table visits (about 4 minutes). Person A wears the glasses, Person B talks and drives the laptop. The laptop shows the phone mirror and a second tab with the CREAO console. Goal set to Internship before the judge arrives. The demo person has consented and is in the preloaded event.

## The 2-minute pitch

| Time | Beat | Say / do |
|---|---|---|
| 0:00-0:10 | Hook and live moment, start immediately | B: "Watch the glasses, not me." A reads the rep's badge, holds the temple, says "Priya, Anduril, recruiter." Mirror shows `Listening`, then `Heard:`, then card 1. |
| 0:10-0:30 | The three cards | B: "Three cards, each with a source. Connect is an opener that is not small talk. Context is who they are and what their company is doing. Your angle is what to ask, given your goal." A taps through them. |
| 0:30-0:45 | Quiet | A starts talking with the rep. B: "And now it is gone. One dim line. Nothing whispers in your ear during the conversation. That is the whole point: a little help when you need it, then out of the way." |
| 0:45-1:00 | Why it is different | B: "Other projects talk during the conversation or recognize faces with a camera. Cue has no camera, no face recognition, push-to-talk only, and no recording. You decide when it speaks." |
| 1:00-1:30 | CREAO agents | B switches to the CREAO tab. "The night before, our Event Loader agent read the whole event and built the company store. Right now a Person Researcher agent is running on this person." Show the in-progress run, then a finished run and its deeper brief. "Remove the agents and the product stops working: no event, no company cards, no deeper brief." Do not wait for the on-lens update. |
| 1:30-1:45 | Goal switch | A opens the menu and picks `Goal: Cofounder`. "Same person, new goal. Only the third card changes." |
| 1:45-2:00 | Honesty and close | B: "Person lookup is real web search. We preloaded the demo event with people who have public bios. If nothing is found, Cue says so." Optionally show the unknown-name org-only card. "Public professional info only. Cue." Then offer the glasses to the judge to try. |

Timing rule: if a judge interrupts, answer, then resume at the next beat. The beats that cannot be skipped are the live moment, Quiet, and CREAO.

## The 30-second version

"At a career fair you meet thirty people and forget who does what. Cue is a G2 app: hold the temple, say a name, company and role, and three cards appear on your lens: how to connect, who they are, and what to ask for your goal. Then the display goes quiet so you can actually talk. No camera, no face recognition, no recording, public professional info only. Our CREAO agents load the event the night before and keep researching in the background, and without them Cue does not work. Want to try it?"

## Honesty line (use whenever asked how real it is)

"Person lookup is real web search. We preloaded the demo event with people who have public bios."

## Likely judge questions

**Isn't this creepy?**
Fair question. Three design choices answer it. There is no camera, so Cue cannot recognize anyone's face. The wearer has to say the name aloud, which means you only look up people who just told you who they are. And it only uses public professional information, like a talk, a company page, or a personal site, and filters out family, home, health, and politics. It is the same thing you would do by glancing at your phone and searching their name, minus looking down. It is not for pretending you know someone.

**Does it record?**
No. The microphone is on only while you hold the press. The audio goes to speech-to-text and is discarded; it is never stored. We keep the transcript text and the cards on our backend for the event so updates and goal switches work, and we delete them after. There is no always-on listening.

**Why glasses? Why not a phone app?**
Looking at a phone in the middle of a handshake breaks eye contact, and that is the moment you are trying to make count. With glasses the card is in your line of sight, you read it in a glance, and then it disappears. Hold-to-talk with your hand at your temple also looks like a natural gesture, not like checking a screen.

**What if it mishears the name?**
We echo what it heard right on the lens: `Heard: Priya | Anduril | recruiter`. If it is wrong, you hold and say it again. We pass the event's company and people names to the speech-to-text as hints, which helps with names like Anduril. If the search turns up two possible people, the lens asks "Which Priya?" and you choose. If you are not sure, you pick Neither and get the company card only.

**What if nothing is found?**
Cue says so. You get one company card that begins "No public info found for Priya." and nothing invented about the person. If even the company is unknown, you get a generic ask for your goal, marked low info. A wrong fact about a person is worse than no fact.

**Why CREAO? Is it really needed?**
Yes, and we can show it. The Event Loader agent turns an event's company and speaker list into the store that makes company cards fast. The Person Researcher and Brief Writer agents do deeper multi-step research after a lookup and replace the quick cards in place. Those take minutes, so they cannot sit in the live path, but they are what makes Cue better than a single search. If you remove them there is no preloaded event and no deep brief. The quick path alone is just a search wrapper, and we want to be clear about that. Agent IDs and a run link are in the README.

**What is the business model?**
We have not committed to one. Options we considered, from most to least likely for us:
1. Per-seat subscription for students and job seekers who go to career fairs, with a free tier of a few lookups per event.
2. Event organizer licensing: organizers pre-load the attendee and company list for exhibitors, and charge for a branded version.
3. Recruiter and sales teams: a team plan for people who work conferences, with CRM export of who they met.
4. Employers sponsoring a career-fair mode that gives students a card about their open roles (opt-in for the company, clearly labeled).
We would not sell data about the people being looked up.

**How is this different from Wingman, LookBack, or Even's own Prep Notes?**
Wingman whispers during the conversation. LookBack uses faces for context. Prep Notes shows notes during a conversation. Cue is the opposite on all three: it helps in the five seconds before you speak, it uses no camera or face, and it is silent during the conversation.

**What is real and what is faked?**
The audio, speech-to-text, web search, and model call are live. The demo event and the people in it are preloaded, and they agreed to be in the demo and have public bios. CREAO runs take minutes, so we show a run in progress and a finished one rather than waiting.

**How fast is it?**
[MEDIAN: X.X seconds from release to first card, measured over N runs on venue wifi.] The company card appears sooner because the event is preloaded. We did not claim a number we did not measure. [DELETE THIS LINE IF NOT MEASURED.]

**What did you learn from the hardware?**
A long press reaches the app, so true hold-to-talk works. The firmware line height is a fixed 27 pixels, so our first layout showed partial lines until we made every container height an exact multiple of 27 and capped the body at 5 lines. Brightness level 1 is unreadable, so the quiet status uses level 2.

**Can the person opt out?**
[ANSWER HONESTLY. Today there is no opt-out mechanism beyond not saying their name; Cue only looks up information that is already public. Say that it is a next step.]
