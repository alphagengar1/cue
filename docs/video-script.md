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
| 0:42-0:56 | Laptop: CREAO console, the Event Loader run from last night and the store it built. | CREAO console, agent name and run. Caption: "CREAO Event Loader" with the agent ID [CREAO EVENT LOADER AGENT ID]. | "The night before, a CREAO Event Loader agent read the whole event and built the company store, which is why company cards appear in about two seconds." |
| 0:56-1:10 | Laptop: a Person Researcher run in progress for the person just looked up, then a finished run and its deeper brief. | CREAO run page. Caption: "CREAO Person Researcher + Brief Writer" and run link [CREAO RUN SHARE LINK]. | "A Person Researcher agent digs deeper in the background, a Brief Writer agent rewrites the cards, and the better version replaces the quick one in place. Remove the agents and Cue has no event and no deep brief." |
| 1:10-1:22 | Lens/mirror: menu opens (tap-then-hold), pick `Goal: Cofounder`, card 3 changes, cards 1 and 2 stay. | Lens, then mirror side by side. Caption: "Goal switch: Internship to Cofounder". | "Change your goal from the glasses. Only your angle changes: from asking about internships to asking what they are building next." |
| 1:22-1:36 | Lens/mirror: say an unknown name. `Which Priya?` picker shown, pick Neither, or the org-only card: `No public info found for ...`. | Mirror close-up of the text. Caption: "Honest when it does not know". | "When Cue is not sure, it asks. When nothing is public, it says so and shows the company instead. It never makes up a person." |
| 1:36-1:50 | Quick montage: Vultr server dashboard or `curl` of `/api/state`; Sentry trace with spans [SENTRY TRACE LINK] (only if live); the Even phone app. | Sparse labels: "Vultr", "Sentry trace", "Even Hub". | "A Vultr backend handles speech-to-text, search and the model call, and Sentry traces every lookup so we could tune the speed. All of it is inside an Even Hub app on real G2 glasses." |
| 1:50-2:00 | Wide: A shakes the person's hand. Final card: Cue logo and privacy line. | Text: "Real web search. Public professional info only. No camera. No recording." Repo/Devpost URL [URL]. | "Real web search, public professional info only. No camera, no face recognition, no recording. Cue: a little help when you need it, then out of the way." |

## Notes for the edit

- The first 10 seconds must show the lens, not slides. If the live capture fails, use the simulator and caption it "simulator".
- Keep the honesty line visible somewhere (end card or description): "Person lookup is real web search. The demo event is preloaded with people who have public bios."
- Show the CREAO agent actually running (a run in progress), not only a settings page.
- If Sentry or Photon were cut, delete the matching clause from the 1:36 beat and the sponsor tag. If Photon is built, add one 5-second shot of the follow-up iMessage arriving on the phone and the line "After the event, the follow-up arrives in iMessage" before the closing beat, and cut the Sentry shot to keep 2:00.
- Do not show a real person's badge or face without their consent. Blur other badges.
- Trim silence. Each beat is a single claim and a single picture.
