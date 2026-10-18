# Cue - 2-minute demo video script

Target length: 2:00 (hard cap 2:10). The product is on screen by 0:03 and the first card is on screen by 0:10. Placeholders in [SQUARE BRACKETS] need real values.

## Capture setup

- **Through-the-lens shots:** a phone or camera held behind the right lens of the glasses, or a lens-capture rig. Dark background, glasses at a natural angle. If the lens is hard to film, use the mirror (below) as the main view and cut to through-the-lens for the first card and for Quiet.
- **Phone/laptop mirror:** the same `Screen` the HUD shows, rendered as HTML (phone screen mirror, or the laptop `/mirror` page). Use this for readable close-ups.
- **Simulator:** the Even Hub desktop simulator for the state-machine shots if the live lens is dim on camera. Label it "simulator" on screen so we stay honest.
- **Wide shot:** the teammate wearing the glasses, a consenting person across the table (a sponsor rep or friend with a public bio), real venue noise.
- Record voiceover separately. Burn in captions. No music louder than a bed track. Mute notification sounds.

## Shot list and voiceover

| Time | Shot | On screen | Voiceover |
|---|---|---|---|
| 0:00-0:03 | Wide: Person A at a table, a person across, A holds a finger to the temple. Title card flashes "Cue". | Caption: "Cue - quiet networking on Even G2" | (none, natural room sound) |
| 0:03-0:10 | Through-the-lens: `Listening` line, then release, `Heard: Priya \| Anduril \| recruiter`, then card 1 with its source line. | Lens capture, big. Caption: "Hold. Say a name. Get a card." | "Hold the temple, say a name, a company, a role. Three seconds later, you have an opener." |
| 0:10-0:22 | Mirror, close-up: cards 1, 2, 3 flipping with taps. Highlight the source line on each. | Mirror view. Callouts: Connect, Context, Your angle. | "Connect gives you a real opener. Context says who they are and what their company is working on. Your angle ties it to your goal, and tells you what to ask." |
| 0:22-0:32 | Wide: A looks up and talks to the person. Cut to through-the-lens: only a dim one-line status. | Lens capture of `cue \| Priya Raman \| hold to ask`. Caption: "During the conversation: nothing." | "Then Cue gets out of the way. No whispering in your ear, no popups. One dim line, so you can look at the person and listen." |
| 0:32-0:42 | Problem shot: a career fair crowd, a student checking a phone. (Stock-free: film the venue.) | B-roll. | "At a career fair you meet thirty people in two hours. Phones pull your eyes down. Always-listening glasses pull the conversation apart. Cue helps for five seconds, then it is gone." |
| 0:42-0:56 | Laptop: CREAO console, the finished Event Loader run from before the event and the org store it built (`backend/data/creao-*.json`). | CREAO console, agent name and run. Caption: "CREAO Event Loader, run before the event" with the agent ID 7ed5ac12-fb85-4545-9e4e-abbeaa25db1a. | "Before the event, a CREAO Event Loader agent read the whole event and built the company store. That is why company cards appear in about two seconds." |
| 0:56-1:10 | Laptop: the finished Person Researcher and Brief Writer runs for the person just looked up, then the researched brief sitting in the loaded event data. | CREAO run page, then the event JSON. Caption: "CREAO Person Researcher + Brief Writer, run before the event" and run links https://agent.creao.ai/share/21c460878c2ec3e4eed039a5a327e0e6 (Person Researcher) and https://agent.creao.ai/share/5922c0b96ff6085300d95090eeb4bc58 (Brief Writer). | "Before the event, a Person Researcher agent dug into each person we expected to meet, a Brief Writer agent turned that into the three cards, and we loaded the result into the event data. Claude Haiku handles the two seconds live. Remove the agents and Cue has no event and no researched brief." |
| 1:10-1:20 | Lens/mirror: menu opens (tap-then-hold), pick `Goal: Cofounder`, card 3 changes, cards 1 and 2 stay. | Lens, then mirror side by side. Caption: "Goal switch: Internship to Cofounder". | "Change your goal from the glasses. Only your angle changes: from internships to what they are building next." |
| 1:20-1:30 | Lens/mirror: say an unknown name. `Which Priya?` picker shown, pick Neither, or the org-only card: `No public info found for ...`. | Mirror close-up of the text. Caption: "Honest when it does not know". | "When Cue is not sure, it asks. When nothing is public, it says so and shows the company instead. It never makes up a person." |
| 1:30-1:40 | Wide: A steps away from the table, holds the temple and says a 10-second debrief ("He said email him about Seer. They are hiring interns for summer."). Cut to laptop: the Follow-up Writer run. A opens the glasses menu and taps "Text me a recap". Cut to phone: the iMessage recap arriving (and the Follow-up Writer's email, message and next steps once wired in). | Caption: "After: CREAO Follow-up Writer -> Photon iMessage" and run link [FOLLOW-UP WRITER SHARE LINK]. | "After the conversation, you say a ten-second debrief in your own words. The other person is never recorded. A Follow-up Writer agent drafts the email, a short message and next steps, and Photon texts them to you. Only ever to you." |
| 1:40-1:50 | Quick montage: Vultr server dashboard or `curl` of `/api/state`; Sentry trace with spans [SENTRY TRACE LINK] (only if live); the Even phone app. | Sparse labels: "Vultr", "Sentry trace", "Even Hub". | "A Vultr backend handles speech-to-text, search and the model call, and Sentry traces every lookup so we could tune the speed. All of it is an Even Hub app on real G2 glasses." |
| 1:50-2:00 | Wide: A shakes the person's hand. Final card: Cue logo and privacy line. | Text: "Real web search. Public professional info only. No camera. No recording." Repo/Devpost URL [URL]. | "Real web search, public professional info only. No camera, no face recognition, no recording. Cue: a little help when you need it, then out of the way." |

## Notes for the edit

- The first 10 seconds must show the lens, not slides. If the live capture fails, use the simulator and caption it "simulator".
- Keep the honesty line visible somewhere (end card or description): "Person lookup is real web search. The demo event is preloaded with people who have public bios."
- Show a CREAO run (a finished run and, if possible, one in progress), not only a settings page. The Event Loader, Person Researcher and Brief Writer runs happened before the event; say so in the caption. The Follow-up Writer run is the one that can be live on camera.
- To fit the Follow-up Writer + Photon beat (1:30-1:40) the goal switch lost 2 seconds (now 1:10-1:20), the honesty beat lost 4 seconds (now 1:20-1:30) and the sponsor montage lost 4 seconds (now 1:40-1:50). Total stays 2:00.
- The 1:30 beat is: debrief spoken into the temple, then the wearer taps "Text me a recap" in the glasses menu and the follow-up arrives in iMessage on the wearer's phone. Nothing is sent to the person they met; say so once. If the end-to-end Photon send is not working by filming time (it is unverified, see `design/photon-notes.md`), show the Follow-up Writer run and its JSON on the laptop instead, cut the beat to 5 seconds, and give the time back to the 1:20 and 1:40 beats.
- Unverified: the glasses app does not capture a debrief yet (only the backend route `POST /api/briefs/:id/debrief` exists). If the app cannot capture one by filming time, show the debrief typed on the setup page or pasted into the CREAO run instead of spoken into the temple.
- Unverified: the backend does not yet read `followUp` from the event file, so today the iMessage is the Haiku-written recap built from the cards and the debrief (template recap plus a follow-up line if the LLM is down), and the email draft arrives only after you reply "email". Until that is wired, film the recap arriving, then the "email" reply, or show the Follow-up Writer JSON on the laptop.
- If Sentry was cut, delete the Sentry clause from the 1:40 beat and the sponsor tag.
- Do not show a real person's badge or face without their consent. Blur other badges.
- Trim silence. Each beat is a single claim and a single picture.
