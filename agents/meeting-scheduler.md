# CREAO agent: Meeting Scheduler

Runs **after the Follow-up Writer**, live, from the backend (`backend/src/creao.ts`, app API with its own `capi_` key). It turns a finished follow-up into a concrete next step: three proposed times, a short scheduling message in the wearer's voice, and, when the agent has a calendar connector, a tentative 30-minute hold on the wearer's calendar. Photon texts the result to the wearer, who decides whether to send anything. The agent never contacts the other person.

## What the backend sends and reads

Inputs are exactly these fields (set them in the Create Agent box):

| Input | Type | Notes |
|---|---|---|
| `person` | object | `{ name, role, org }` |
| `followUp` | object | `{ email: { subject, body }, message, nextSteps: [] }` from the Follow-up Writer |
| `debrief` | text | the wearer's spoken note, verbatim STT (may be messy) |
| `conversation` | text | saved transcript when the wearer recorded with consent; often empty |
| `wearer` | object | `{ name, school, availability, timezone }`; `availability` is free text ("weekday afternoons, not Tuesdays") |
| `eventName` | text | |

Output: one ```json block, nothing after it:

| Field | Rule |
|---|---|
| `proposedTimes` | exactly 3 strings `"YYYY-MM-DD HH:MM-HH:MM"` in the wearer's timezone, within the next 10 days, 30 minutes each, matching `availability` |
| `inviteTitle` | <= 60 chars, e.g. "Cue x Sentry: Seer follow-up (David / Sam)" |
| `inviteDescription` | <= 400 chars: who, where you met, the one topic, the ask |
| `schedulingMessage` | <= 300 chars, in the wearer's voice, offers the three times, ready to paste |
| `calendarEventCreated` | boolean |
| `eventLink` | string or null |

The backend (`applyMeetingScheduler`) stores the result on the person as `followUp.schedule` and texts the wearer: the three times, the message, and the calendar link when there is one, ending with "reply book to send". Invalid JSON means the run is logged as failed and nothing is texted; the Follow-up Writer's text already went out.

## How to create this agent (agent.creao.ai)

1. https://agent.creao.ai -> **new chat** in your personal space.
2. Connectors: add **Google Calendar** if it is offered (that is what makes `calendarEventCreated` true). No web search, no browser.
3. Paste the **Instructions** block below as the first message, add `INPUT:` and **Test input 1**, and send. Check the reply ends with one ```json block in the format above.
4. **Create Agent** -> Output format **Markdown** -> in the Instructions box paste:
   > Inputs are exactly these fields: person (object), followUp (object), debrief (text), conversation (text, may be empty), wearer (object), eventName (text). Keep every rule from the first message word for word in the skill, especially: never contact the other person, only the wearer sends messages; a calendar hold is tentative and 30 minutes; the final reply always ends with one ```json block in the output format and nothing after it.
   Then **Start building**. Turn on **extended memory** in the agent settings if available.
5. Open **Config** and check `skill.md` kept the rules and the JSON format.
6. Agent detail page -> **API** -> create a key. Put in `backend/.env`: `CREAO_MEETING_SCHEDULER_KEY=capi_...` and `CREAO_MEETING_SCHEDULER_ID=<agent id>`.

## Instructions (paste this)

```text
You are the Meeting Scheduler for Cue, a smart-glasses app that helps a student follow up well after meeting a professional at an in-person event. You run right after the Follow-up Writer. Your job: turn the follow-up into a concrete meeting proposal and, if you have a calendar connector, a tentative hold on the STUDENT's calendar.

INPUT is a JSON object:
- person: { name, role, org }
- followUp: { email: { subject, body }, message, nextSteps: [] } written for this person
- debrief: the student's spoken note after the conversation (messy speech-to-text is normal)
- conversation: a saved transcript of the conversation, when the student recorded it with the other person's consent; often empty
- wearer: { name, school, availability, timezone } where availability is free text
- eventName

WHAT TO DO
1. Pick the one topic the meeting is about, from the debrief first, then the conversation, then the follow-up.
2. Propose exactly 3 half-hour slots within the next 10 days that fit wearer.availability, in wearer.timezone, spread across different days. Prefer the first slot to be 3-7 days out.
3. If you have a calendar connector: create ONE tentative 30-minute event at the first slot on the student's calendar, titled inviteTitle, with inviteDescription as the description, and NO attendees other than the student. Return its link in eventLink and calendarEventCreated true. If you have no connector, calendarEventCreated false and eventLink null. Never create more than one event per run.
4. Write schedulingMessage in the student's voice: one or two sentences, offers the three times plainly, under 300 characters, ready to paste into an email or text.

RULES (strict)
- You never email, message, or invite the other person. Only the student sends things, by hand, after reading your output.
- Use only facts from the input. Do not invent a topic, a company detail, or an email address.
- Professional tone. Nothing private about either person.
- Plain ASCII in all strings, no emoji, no markdown.

OUTPUT FORMAT: the final reply ends with one ```json block, exactly:
{
  "proposedTimes": ["YYYY-MM-DD HH:MM-HH:MM", "YYYY-MM-DD HH:MM-HH:MM", "YYYY-MM-DD HH:MM-HH:MM"],
  "inviteTitle": "...",
  "inviteDescription": "...",
  "schedulingMessage": "...",
  "calendarEventCreated": false,
  "eventLink": null
}
```

## Test inputs

Test input 1 (David Cramer):

```json
{
  "person": { "name": "David Cramer", "role": "co-founder", "org": "Sentry" },
  "followUp": {
    "email": { "subject": "Following up on Seer from LA Hacks", "body": "Hi David,\n\nThank you for taking a few minutes to talk with me at LA Hacks. You suggested I email you about Seer, so I wanted to follow up while the conversation is fresh.\n\nI am a Computer Science student at UCLA building Cue, a smart-glasses networking app with a Sentry-instrumented backend. I would like to learn how Seer uses errors and traces to find root causes.\n\nYou also mentioned Sentry is hiring summer interns. I would be glad to be considered for summer 2027.\n\nThank you again,\nSam" },
    "message": "Hi David, great meeting you at LA Hacks. I will email you about Seer this week. Sam",
    "nextSteps": ["Email David about Seer this week", "Apply to Sentry's summer internship"]
  },
  "debrief": "he said email him about seer, they are hiring summer interns, he wants to see the cue demo video",
  "conversation": "",
  "wearer": { "name": "Sam Lee", "school": "UCLA", "availability": "weekday afternoons after 2pm, not Tuesdays", "timezone": "America/Los_Angeles" },
  "eventName": "LA Hacks Fall 2026"
}
```

Test input 2 (low-info, no connector): same shape with `followUp.nextSteps: []`, `debrief: "nice chat, said to stay in touch"`, `availability: "anytime next week"`. Expect three slots next week and `calendarEventCreated: false`.
