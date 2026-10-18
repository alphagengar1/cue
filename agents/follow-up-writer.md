# CREAO agent 4: Cue Follow-up Writer

**Role:** the "after" step. When a conversation ends, the wearer holds the temple (the same push-to-talk as a lookup) and speaks a debrief of about 10 seconds in their own words: what was said, what the person asked for, what to do next. The same STT transcribes it. The other person is never recorded. This agent takes the brief (the cards the glasses showed), that debrief, the wearer's goal and profile, and writes three things: a follow-up email, a short message of at most 300 characters for iMessage, and 2 to 3 next steps. Photon delivers the message to the wearer only, never to the person they met.

Unverified: the glasses app does not capture a debrief yet. The backend route `POST /api/briefs/:id/debrief` (`{ text }`, <= 600 chars) exists and stores it on `Brief.debrief`; the app side (hold the temple after a conversation, run the clip through `/api/stt`, post the transcript to that route) is app work. Until then, type the debrief on the setup page or paste it straight into the CREAO run.

- Trigger: run by hand on agent.creao.ai after the conversation, with the real brief and debrief pasted in. The backend does not start it (the CREAO /v2 API only runs API-created agents).
- Applied by: nothing yet. The output is stored under the person's entry in `backend/data/<event>.json` as `followUp` (see below). `store.loadSample()` ignores keys it does not know, so the file still loads, but no backend code reads `followUp` today. Today the recap route (`POST /api/briefs/:id/recap`) sends Haiku-written bubbles from `backend/src/compose.ts` (`composeRecap`), built from the cards, the facts, the wearer profile and `brief.debrief`; the `formatRecap` template with its `suggestFollowUp()` line is only the fallback when the LLM is unavailable. Wiring this agent's `email`, `message` and `nextSteps` into those bubbles, or into the "email" reply in `backend/src/recap.ts`, is backend work. Passing `{ followUp }` to `sendRecap()` only changes the fallback template; the bubbles path ignores it.
- Env var: none. The agent is run by hand, so the backend reads no `CREAO_*` id for it.

## Loading the output into Cue

The /v2 API cannot run agents built on agent.creao.ai, so run this agent by hand and paste its JSON into the event file: `backend/data/<event>.json`, in the matching entry of the top-level `people` array (match by `name` + `orgId`, the same entry the Person Researcher output lives in), as a `followUp` key next to `facts` and `research`:

```json
"people": [
  {
    "name": "David Cramer", "orgId": "sentry", "role": "co-founder",
    "headline": "Co-founder of Sentry; product and engineering leader",
    "facts": [
      { "text": "David Cramer of Sentry spoke at the AI Engineer conference on AI-assisted debugging and agent tooling.", "sourceUrl": "https://ai.engineer/speakers/david-cramer", "sourceKind": "talk" }
    ],
    "match": "high",
    "research": { "agent": "creao-person-researcher", "agentId": "e496e45b-c8eb-4079-9aff-876071501d67", "runLink": "https://agent.creao.ai/share/21c460878c2ec3e4eed039a5a327e0e6" },
    "followUp": {
      "agent": "creao-follow-up-writer",
      "agentId": "<agent id>",
      "runLink": "https://agent.creao.ai/share/...",
      "debrief": "Talked to David for a few minutes, he said email him about Seer, they're hiring interns for summer, he liked that Cue uses Sentry tracing. He mentioned the Open Source Pledge too.",
      "email": {
        "subject": "Following up on Seer from LA Hacks",
        "body": "Hi David,\n\nThank you for taking a few minutes to talk with me at LA Hacks Fall 2026. You suggested I email you about Seer, so I wanted to follow up while the conversation is fresh.\n\nI am a Computer Science student at UCLA building Cue, a smart-glasses networking app. Its Express backend is instrumented with Sentry tracing, which is why your AI Engineer talk on AI-assisted debugging stood out to me. I would like to learn how Seer uses errors and traces to find root causes, and whether a student project like Cue could try it.\n\nYou also mentioned that Sentry is hiring interns for summer. I would be glad to be considered for a summer 2027 software engineering internship, and I am happy to send anything that would help.\n\nThank you again,\nSam"
      },
      "message": "Hi David, great meeting you at LA Hacks. Thanks for the pointer on Seer, I will email you about it this week. Cue's backend already runs Sentry tracing, so I am keen to see how Seer finds root causes. Glad to hear Sentry is hiring summer interns. Sam",
      "nextSteps": [
        "Email David about Seer this week",
        "Apply to Sentry's summer internship and mention the conversation",
        "Read about the Open Source Pledge before emailing"
      ]
    }
  }
]
```

- `agent`, `agentId`, `runLink` and `debrief` are bookkeeping you add by hand; `email`, `message` and `nextSteps` are copied straight from the agent's JSON block.
- What the backend does with it today: nothing. `store.loadSample()` ignores unknown keys, so the file loads and the person's facts work as before. Today the recap route sends Haiku-composed bubbles (`composeRecap` in `backend/src/compose.ts`, which already uses `brief.debrief`); the `formatRecap` template with its 180-char follow-up clip is only the fallback. Nothing reads `followUp` yet. Wiring `email`, `message` and `nextSteps` into those bubbles, or into the "email" reply in `backend/src/recap.ts`, is backend work.
- The backend already stores the debrief: `POST /api/briefs/:id/debrief` with `{ text }` (<= 600 chars) sets `Brief.debrief` (`backend/src/app.ts`), and `compose.ts` / `recap.ts` use it in the recap and the email draft. What is missing is the glasses-side capture (see the Unverified note at the top).
- What the demo shows: the CREAO run on the laptop (brief + debrief in, email + message + next steps out) and the Photon recap arriving after the wearer taps "Text me a recap" in the glasses menu.
- Loading a file replaces that event's orgs and people, so paste into the file that is actually loaded (`SAMPLE_EVENT_FILE` or the setup page's bundled event), not a copy.

## How to create this agent (agent.creao.ai)

1. https://agent.creao.ai -> **new chat** in your personal space (not a team agent).
2. No connectors. No web search needed: this agent must not look the person up. Everything it may use is in the input. Do not turn on Browser Use or any LinkedIn access.
3. Paste the **Instructions** block below as the first message, add `INPUT:` and **Test input 1**, and send.
4. Check that the reply ends with one ```json block in the **Output format**, that `message` is at most 300 characters, that the email asks about Seer and summer internships, and that nothing appears that is not in the input (no invented dates, meetings, titles or contact details). Correct it in chat if needed.
5. Click **Create Agent** -> **Output format: Markdown** -> in **Instructions** paste:
   > Inputs are exactly these fields: brief (object), debrief (text), goal (text), wearer (object), eventName (text). Keep every rule from the first message word for word in the skill, especially "use ONLY facts in the input", the privacy rules and the 300-character limit on message. Never use web search. The final reply must always end with one ```json block in the output format, and nothing after it.
   Then **Start building**.
6. Open **Config** and check `skill.md` kept the privacy rules, the "no web search" rule, the 300-character limit and the JSON format. Fix with a follow-up message if not.
7. Run it once from **Run** with **Test input 2** (expected: a short email that mentions applying online and the fair, nothing invented about Priya, and a next step to apply online). Share that thread from the share icon to get the run share link.
8. Copy the agent ID from the agent's URL on agent.creao.ai (Unverified: the UUID after `/agent/`, or on the agent page the share link opens; confirm where it shows in the UI). It will not show in the Developer Console, which only lists API-created agents. Put the ID and the share link in `README.md`, in the Sponsors list next to the other three CREAO agents.
9. For each real conversation: run the agent from **Run** with the real brief and the wearer's debrief, then paste the JSON block into `backend/data/<event>.json` under that person's `people` entry as `followUp` (see **Loading the output into Cue** above).

## Instructions (paste this)

```text
You are the Follow-up Writer for Cue, a smart-glasses app that helps a student start a good conversation with a professional at an in-person event. After the conversation, the student (the wearer) speaks a short debrief in their own words. You turn the brief they saw on the glasses, their debrief, their goal and their profile into a follow-up email, a short message and a few next steps. The wearer sends the email and the message themselves. Nothing you write is sent to the person they met.

INPUT is a JSON object:
- brief: { person: { name, role, org }, cards: [{ kind, title, body, source }] }. cards: 1 to 3 cards exactly as the glasses showed them (3 for a researched person; only a context card when nothing was found about the person; only an angle card when the org is unknown). kind is connect, context or angle. source is a bare domain and path, or null.
- debrief: the wearer's spoken debrief, transcribed verbatim. It may be messy speech-to-text: missing punctuation, wrong casing, filler words, a few wrong words.
- goal: one of internship (land an internship or referral), cofounder (find a cofounder), learn (learn about their field), teammates_sponsors (find teammates, APIs or sponsor help this weekend), mentorship (find a mentor)
- wearer: { name, school, major, summary, interests, projects, goalNote }
- eventName: the event where they met

WHAT TO DO
Write three things, all in the wearer's voice:
1. email: a follow-up email the wearer can send.
   - subject: at most 60 characters, specific to the conversation.
   - body: plain text, 80 to 160 words. Greet the person by first name. Reference one concrete thing from the debrief or from a card. Make one clear ask tied to the goal. Sign off with the wearer's name. Use "\n\n" between paragraphs.
2. message: a short follow-up text of at most 300 characters, for iMessage. Same facts as the email, shorter. No links unless a source from a card is genuinely useful.
3. nextSteps: 2 to 3 short imperative items the wearer does in the next week, each grounded in the debrief or the brief. Each at most 100 characters. Example: "Email David about Seer this week".

PRIORITY
- What the wearer said in the debrief beats the cards. If the two disagree, follow the debrief.
- If the debrief contains an explicit instruction from the other person (for example "email me about X", "apply online", "send me your resume"), that instruction becomes the ask in the email and the message, and the first next step.
- If the debrief is empty or unusable (no content about the conversation), use only the cards. Keep the email shorter (60 to 100 words), keep it polite and general, and use nextSteps to say what the wearer should find out next time (for example "Ask what team she recruits for").
- If a card says "No public info found", or the brief has only one card, keep the email to 60 to 100 words and make the ask the one thing the debrief says (for example apply online and mention the fair). Say less rather than more. A short, correct email beats a long, padded one.

RULES (strict)
- Use ONLY facts in the input. Never invent names, titles, dates, meetings, products, numbers or promises. Do not assume anything was agreed unless the debrief says so. Relative timing like "this week" is fine; specific days or dates are not unless the debrief gives them.
- Never mention family, relationships, children, home or where someone lives, health, religion, political views, age or appearance, even if the debrief mentions them. Drop such details silently and do not comment on dropping them.
- Never include phone numbers or email addresses, even if they appear in the input.
- Both the email and the message are drafts for the wearer to send themselves. Write them as if from the wearer. Never write as Cue. Never mention that the wearer used glasses, an assistant or any recording during the conversation. The wearer's own project may be named when it appears in wearer.summary, wearer.projects or the debrief. Never write anything meant for the other person to receive directly from you.
- Professional and warm. No flattery, no hype. At most one exclamation mark across all outputs.
- Plain ASCII. No emoji. No markdown inside the strings (no asterisks, no bullet symbols, no headings).
- Do not quote the debrief verbatim. Rephrase it in clean, complete sentences.
- The message must not exceed 300 characters. Count it.

OUTPUT
Write at most 3 short lines of summary, then end your reply with exactly one ```json code block containing one JSON object in the format below, and nothing after the block. Do not create files, dashboards or HTML. The JSON must parse: double quotes, no comments, no trailing commas. Use "\n" for line breaks inside email.body. Return exactly these fields and no others.

{
  "email": { "subject": "string", "body": "string" },
  "message": "string",
  "nextSteps": ["string", "string"]
}
```

## Output format

The agent returns one JSON object with exactly three top-level keys. The backend does not read or validate this object yet (see **Loading the output into Cue**); the rules below are what the agent is told and what you should check by eye before pasting.

| Field | Rule |
|---|---|
| `email.subject` | required; <= 60 chars |
| `email.body` | required; plain text, 80 to 160 words (60 to 100 in the low-info case); `"\n\n"` between paragraphs; greets by first name, one concrete reference, one ask, signed with the wearer's name |
| `message` | required; <= 300 chars; in the wearer's voice; no links unless a card source is useful. Wiring it into the Photon recap is backend work. On the normal path `composeRecap` splits bubbles at 140 chars and `sendRecap` clips each at 1500; only the fallback `formatRecap` template caps the recap at 600 chars and clips the follow-up line to 180 |
| `nextSteps[]` | required; 2 to 3 items, each <= 100 chars, imperative, grounded in the debrief or the brief |

Example output for Test input 1 (David Cramer):

```json
{
  "email": {
    "subject": "Following up on Seer from LA Hacks",
    "body": "Hi David,\n\nThank you for taking a few minutes to talk with me at LA Hacks Fall 2026. You suggested I email you about Seer, so I wanted to follow up while the conversation is fresh.\n\nI am a Computer Science student at UCLA building Cue, a smart-glasses networking app. Its Express backend is instrumented with Sentry tracing, which is why your AI Engineer talk on AI-assisted debugging stood out to me. I would like to learn how Seer uses errors and traces to find root causes, and whether a student project like Cue could try it.\n\nYou also mentioned that Sentry is hiring interns for summer. I would be glad to be considered for a summer 2027 software engineering internship, and I am happy to send anything that would help.\n\nThank you again,\nSam"
  },
  "message": "Hi David, great meeting you at LA Hacks. Thanks for the pointer on Seer, I will email you about it this week. Cue's backend already runs Sentry tracing, so I am keen to see how Seer finds root causes. Glad to hear Sentry is hiring summer interns. Sam",
  "nextSteps": [
    "Email David about Seer this week",
    "Apply to Sentry's summer internship and mention the conversation",
    "Read about the Open Source Pledge before emailing"
  ]
}
```

(Shape and length guide; the real run will word it differently.)

## Safety rules

What the Instructions enforce, in one place:

- Input only. The agent never searches the web and never looks the person up. Every name, title, product and promise in the output must already be in the brief, the debrief or the wearer profile.
- The other person is never recorded. The debrief is the wearer's own voice, spoken after the conversation, through the same push-to-talk as a lookup (Unverified: the glasses-side capture is not built yet; see the top of this file).
- Private details are dropped silently: family, relationships, children, home or location, health, religion, politics, age, appearance. This applies even when the wearer says them in the debrief.
- No phone numbers or email addresses in the output, even if they were in the input.
- Both outputs are drafts in the wearer's voice. The wearer sends them. Cue never contacts the person met: `sendRecap()` refuses any number other than `WEARER_PHONE`, and the Photon project is set up with the wearer as its only user (Unverified: check this in the Photon console).
- No verbatim quotes of the debrief, so a messy or careless transcript does not end up in an email.
- Plain ASCII, no emoji, no markdown, at most one exclamation mark, message <= 300 chars.

## Test inputs

Test input 1 (David Cramer of Sentry, high match, a clear instruction in the debrief; cards are built from the real facts in `backend/data/creao-lahacks-sponsors.json`). Expected: the email asks about Seer and about summer internships, `message` is at most 300 characters, and `nextSteps` includes emailing David about Seer:

```json
{
  "brief": {
    "person": { "name": "David Cramer", "role": "co-founder", "org": "Sentry" },
    "cards": [
      {
        "kind": "connect",
        "title": "Ask about Seer",
        "body": "He spoke at AI Engineer on\nAI-assisted debugging and agent\ntooling. Ask how Seer, Sentry's\nAI debugging agent, finds root\ncauses from errors and traces.",
        "source": "ai.engineer/speakers/david-cramer"
      },
      {
        "kind": "context",
        "title": "Who he is",
        "body": "Sentry co-founder, now Chief\nProduct Officer after CEO and CTO\nroles. Launched the Open Source\nPledge to fund open-source\nmaintainers.",
        "source": "blog.sentry.io/authors/david-cramer"
      },
      {
        "kind": "angle",
        "title": "Internship ask",
        "body": "Sentry runs a 12+ week hybrid\ntechnical internship. Mention Cue's\nSentry tracing, then ask who to\ncontact about summer roles.",
        "source": "sentry.io/careers/internships"
      }
    ]
  },
  "debrief": "Talked to David for a few minutes, he said email him about Seer, they're hiring interns for summer, he liked that Cue uses Sentry tracing. He mentioned the Open Source Pledge too.",
  "goal": "internship",
  "wearer": {
    "name": "Sam", "school": "UCLA", "major": "Computer Science",
    "summary": "CS student building Cue, a smart-glasses networking app with an Express backend instrumented with Sentry.",
    "interests": ["observability", "wearables"], "projects": ["Cue"], "goalNote": "summer 2027 SWE intern"
  },
  "eventName": "LA Hacks Fall 2026"
}
```

Test input 2 (low-info case: Priya Shah is a made-up name, the brief has only the org context card, and the debrief is short; the org card is illustrative, its source is the `hiring` link from `backend/data/creao-career-fair.json`). Expected: a short email that mentions applying online and the fair, no invented details about Priya, and `nextSteps` that includes applying online:

```json
{
  "brief": {
    "person": { "name": "Priya Shah", "role": "recruiter", "org": "Anduril" },
    "cards": [
      {
        "kind": "context",
        "title": "About Anduril",
        "body": "No public info found for Priya Shah.\nAnduril builds Lattice, software\nthat connects sensors and\nautonomous systems. Internship\nand new-grad roles are listed.",
        "source": "anduril.com/early-careers"
      }
    ]
  },
  "debrief": "Priya, recruiter at Anduril, we talked briefly, she said apply online and mention the fair.",
  "goal": "internship",
  "wearer": {
    "name": "Sam", "school": "UCLA", "major": "Computer Science",
    "summary": "CS junior interested in robotics.",
    "interests": ["robotics"], "projects": [], "goalNote": "summer 2027 SWE intern"
  },
  "eventName": "UCLA Engineering Fall Career Fair"
}
```
