# Decision Gate (OpenAI Decisions API)

> Not texted to the wearer. If any of this output ever reaches iMessage, it follows [agents/voice.md](voice.md).

Source: design/03-agents-and-research.md section 9. Code: `backend/src/decide.ts`, tests in `backend/test/decide.test.ts`.
Model: `gpt-6-luna` on `POST https://api.openai.com/v1/decisions` (public beta). Env: `OPENAI_API_KEY`.
Optional. When the key is missing, the gate returns null and the pipeline behaves exactly as it does today.

## Why a decision model instead of asking the LLM

The Brief Writer is a generative call: it is good at writing three cards, and bad at saying "no". When a search
returns two pages about a different Priya Shah, a chat model will still write a confident brief about a stranger.
Asking it to also output "confidence: 0.8" does not help, because that number is prose, not a probability: it is
not calibrated, it drifts with the prompt, and you cannot put a threshold on it and expect the threshold to mean
the same thing tomorrow.

The Decisions API answers fixed questions with calibrated numbers: a predicate returns a probability, a score
returns a probability-weighted level index, a choice returns a distribution over the options. Those are numbers
you can threshold. So Cue asks one Decisions call per brief, before the cards are written, with four questions
over the same evidence (the wearer's query, the goal, and the facts the search kept):

| Question | Type | Returns | Used for |
|---|---|---|---|
| `match` | predicate | 0-1 | Are these facts about the person the wearer named (same name, same org)? |
| `goal_fit` | score, 3 levels | 0-2 | Not useful / somewhat / strongly useful for the wearer's goal |
| `lead` | choice | connect, context or angle | Which card shows first on the HUD |
| `sensitive_<i>` | predicate per fact | 0-1 each | Mentions health, family, religion, politics, legal, home, age or appearance |

The gate complements the code filters in `safety.ts`, it does not replace them. The word blocklist catches
"wife" and "diagnosis"; the predicate catches "took a year off to care for a parent", which no blocklist will.

## Thresholds

| Signal | Threshold | What the wearer sees |
|---|---|---|
| `match` | below 0.6 | The "No public info found for <name>." line on one org Context card, instead of three cards about a stranger. |
| `goalFit` | 0 (below 0.5) | One quiet line instead of three cards. The person is real but there is nothing here to act on. |
| `sensitive[i]` | above 0.5 | Fact i is dropped before the Brief Writer sees it. |
| `lead` | any | That card is shown first; the other two keep their order. |

The thresholds are deliberately plain. 0.6 on `match` means "more likely than not, with a margin"; a brief about
the wrong person is worse than a brief that says we found nothing. 0.5 on `sensitive` errs toward dropping a
fact, because a dropped fact costs one line of context and a leaked one breaks the privacy promise in
design/00-product.md.

## Budget and failure

- One request per brief. The evidence is kept under about 3k tokens: at most 12 facts, each truncated to 140 characters.
- Timeout 700 ms via `AbortController`, in parallel with nothing else: it runs after the search and before the
  Brief Writer, so it adds at most 700 ms to the live path when the API is slow and nothing when it answers in time.
- Never throws. Missing key, timeout, non-200 status, a body that does not parse, a missing answer, or an
  answer of `{type: "refusal"}` all return `null`, and the caller uses the match level from the code rules alone.
- Raw `fetch`, no SDK. Tests stub `fetch` and never touch the network.

## Request shape

```json
{
  "model": "gpt-6-luna",
  "input": "Wearer named: Priya Shah, Anduril, recruiter\nWearer's goal: internship (summer 2027 SWE intern)\nFacts found by web search (numbered, each with its source URL):\n0. Priya Shah spoke on autonomy testing at ROSCon 2025. [https://roscon.ros.org/2025/talks]\n1. ...",
  "questions": [
    { "type": "predicate", "name": "match", "instructions": "These facts describe the person the wearer named: the same name and the same organization." },
    { "type": "score", "name": "goal_fit", "instructions": "How useful is talking to this person for the wearer's goal, given only these facts?",
      "levels": [ { "label": "not useful", "description": "..." }, { "label": "somewhat useful", "description": "..." }, { "label": "strongly useful", "description": "..." } ] },
    { "type": "choice", "name": "lead", "instructions": "Which card should the wearer see first?",
      "choices": [ { "value": "connect", "description": "..." }, { "value": "context", "description": "..." }, { "value": "angle", "description": "..." } ] },
    { "type": "predicate", "name": "sensitive_0", "instructions": "Fact 0 mentions private matters: health, family, religion, politics, legal, home, age or appearance." }
  ]
}
```

The response is an `answers` array; each answer carries the question `name`, so order does not matter.
