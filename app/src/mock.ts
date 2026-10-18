// MOCK mode: fixed sample Briefs (shared/types.ts shape) so the whole card flow
// can be demoed on the glasses with no API keys and no backend.
//
// VITE_MOCK (or ?mock= in the URL, which wins):
//   "1"  always mock: no STT or brief calls; every lookup returns the sample.
//   "0"  never mock: show whatever the backend returns, errors included.
//   unset / "auto" (default): call the backend, and fall back to the sample when
//        /api/stt fails with STT_FAILED (no Deepgram key) or the network, or when
//        /api/briefs/text returns a template fallback brief or fails.
//
// People and wording are sample data, not real research.

import type { Brief, Card, Goal } from '../../shared/types'

export type MockMode = 'on' | 'off' | 'auto'

function readMode(): MockMode {
  let raw = (import.meta.env.VITE_MOCK as string | undefined) ?? ''
  try {
    const q = new URLSearchParams(location.search).get('mock')
    if (q !== null) raw = q
  } catch { /* no location */ }
  if (raw === '1' || raw === 'on' || raw === 'true') return 'on'
  if (raw === '0' || raw === 'off' || raw === 'false') return 'off'
  return 'auto'
}

export const MOCK: MockMode = readMode()

/** What the mock "heard" when there is no real STT. */
export const MOCK_TRANSCRIPT = 'Jordan, Sentry, developer advocate'
export const MOCK_AMBIGUOUS_TRANSCRIPT = 'Marcus, Helio Labs, founder'

const ANGLE: Record<Goal, string> = {
  internship: 'Pitch: Cue traces every lookup in\nSentry. Ask: do DevRel or SDK teams\ntake interns? Who should you email?',
  cofounder: 'Not a cofounder lead. Ask: which\nSentry alumni started dev-tool\ncompanies? Any intro to one?',
  learn: 'Ask: what should a new app trace\nfirst? What do teams over-instrument\nin their first week?',
  teammates_sponsors: 'Ask: does Sentry sponsor student\nhackathons beyond LA Hacks? Who runs\nthe student program?',
  mentorship: 'Ask: how did you get into DevRel?\nWould you look at a demo writeup\nafter the event?',
}

const now = () => new Date().toISOString()
let seq = 0
const mockId = () => `mock_${Date.now().toString(36)}_${++seq}`

function jordan(goal: Goal): Brief {
  const t = now()
  return {
    id: mockId(), version: 1, eventId: 'lahacks-f26',
    transcript: MOCK_TRANSCRIPT,
    query: { name: 'Jordan', org: 'Sentry', role: 'developer advocate' },
    match: { personId: 'per_sentry-jordan-lee', confidence: 'high', candidates: [] },
    cards: [
      { kind: 'connect', title: 'Connect',
        body: 'You both ship dev tools at hackathons.\nAsk Jordan which Sentry setup step\ntrips up first-time teams most.',
        source: 'sentry.io/welcome' },
      { kind: 'context', title: 'Context',
        body: 'Developer advocate at Sentry. Sentry\ndoes error monitoring, tracing, logs\nand session replay; LA Hacks sponsor.',
        source: 'sentry.io/welcome' },
      { kind: 'angle', title: 'Your angle', body: ANGLE[goal], source: null },
    ],
    slowPath: { status: 'running', runId: 'mock_run' },
    createdAt: t, updatedAt: t,
  }
}

function marcus(): Brief {
  const t = now()
  return {
    id: mockId(), version: 1, eventId: 'lahacks-f26',
    transcript: MOCK_AMBIGUOUS_TRANSCRIPT,
    query: { name: 'Marcus', org: 'Helio Labs', role: 'founder' },
    match: {
      personId: 'per_helio-marcus-chen', confidence: 'medium',
      candidates: [
        { personId: 'per_helio-marcus-chen', label: 'Marcus Chen | founder' },
        { personId: 'per_helio-marcus-webb', label: 'Marcus Webb | grid eng' },
      ],
    },
    cards: [
      { kind: 'connect', title: 'Connect',
        body: 'Both build open-source tools. Ask\nMarcus what made solar forecasting\nthe first product.', source: 'heliolabs.dev/about' },
      { kind: 'context', title: 'Context',
        body: 'Founder of Helio Labs, a 4-person seed\nstartup: open-source solar forecasting,\ngrid API planned for Sep.', source: 'heliolabs.dev/about' },
      { kind: 'angle', title: 'Your angle',
        body: 'Ask: who is the first hire? Would they\ntake a student builder for the API?', source: null },
    ],
    slowPath: { status: 'none' },
    createdAt: t, updatedAt: t,
  }
}

/** The sample brief for a lookup. "marcus" in the text gives the ambiguous one (Confirm screen). */
export function mockBrief(text: string, goal: Goal): Brief {
  return /marcus/i.test(text) ? marcus() : jordan(goal)
}

const bump = (b: Brief, patch: Partial<Brief>): Brief =>
  ({ ...b, ...patch, version: b.version + 1, updatedAt: now() })

/** Local version of POST /api/briefs/:id/confirm (01 section 4.2). */
export function mockConfirm(b: Brief, personId: string | null): Brief {
  if (personId === null) {
    const org = b.query.org
    const card: Card = { kind: 'context', title: 'Context',
      body: `${b.query.name} not confirmed. ${org} is a\n4-person seed startup: open-source\nsolar forecasting, grid API in Sep.\nAsk who they are hiring first.`,
      source: 'heliolabs.dev/about' }
    return bump(b, { match: { ...b.match, personId: null, confidence: 'low' }, cards: [card] })
  }
  if (personId === b.match.candidates[0]?.personId) {
    return bump(b, { match: { ...b.match, personId, confidence: 'high' } })
  }
  const label = b.match.candidates.find(c => c.personId === personId)?.label ?? b.query.name
  const name = label.split(' | ')[0]
  return bump(b, {
    match: { ...b.match, personId, confidence: 'high' },
    cards: [
      { kind: 'connect', title: 'Connect', body: `${name.split(' ')[0]} works on the grid API.\nAsk what data sources it will use.`, source: 'heliolabs.dev/team' },
      { kind: 'context', title: 'Context', body: 'Grid engineer at Helio Labs, a 4-person\nseed startup shipping a grid API in Sep.', source: 'heliolabs.dev/team' },
      b.cards.find(c => c.kind === 'angle') ?? { kind: 'angle', title: 'Your angle', body: 'Ask what they need help with first.', source: null },
    ],
  })
}

/** Local version of PUT /api/goal: only card 3 changes. */
export function mockGoal(b: Brief, goal: Goal): Brief {
  if (!b.cards.some(c => c.kind === 'angle')) return b
  const body = /sentry/i.test(b.query.org) ? ANGLE[goal] : b.cards.find(c => c.kind === 'angle')!.body
  return bump(b, { cards: b.cards.map(c => (c.kind === 'angle' ? { ...c, body } : c)) })
}

/** Simulated slow-path (CREAO) result: card 1 gets a sharper hook, version + 1. */
export function mockSlowPath(b: Brief): Brief {
  return bump(b, {
    slowPath: { status: 'done', runId: 'mock_run' },
    cards: b.cards.map(c => c.kind === 'connect'
      ? { ...c, body: 'Jordan wrote a guide on tracing\nhackathon apps. Ask which mistake\nfrom it shows up most at LA Hacks.' }
      : c),
  })
}
