// Backend client. Endpoint names and shapes: design/01-architecture.md section 4,
// checked against backend/src/server.ts. Types come from shared/types.ts.
// No third-party keys here; only our backend origin and the device token.

import type {
  BriefResponse, ConfirmRequest, Goal, GoalRequest, GoalResponse, RecapResponse, SayRequest, SayResponse, StateResponse, SttResponse,
} from '../../shared/types'

export const BACKEND_URL = ((import.meta.env.VITE_BACKEND_URL as string | undefined) ?? '').replace(/\/+$/, '')
const DEVICE_TOKEN = (import.meta.env.VITE_DEVICE_TOKEN as string | undefined) ?? ''

export interface ApiResult<T = unknown> {
  ok: boolean
  status: number      // 0 = network error / timeout (CORS or whitelist problems look like this)
  ms: number
  data?: T
  error?: string      // ErrorCode from the backend ({ error: { code } }) or a transport message
  message?: string    // backend error.message
  fallback?: boolean  // X-Cue-Fallback: template (some card came from the template, not the LLM)
  notes?: string      // X-Cue-Notes
}

async function call<T>(path: string, init: RequestInit = {}, timeoutMs = 15000, signal?: AbortSignal): Promise<ApiResult<T>> {
  const t0 = performance.now()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  signal?.addEventListener('abort', () => ctrl.abort())
  const headers = new Headers(init.headers)
  if (DEVICE_TOKEN) headers.set('Authorization', `Bearer ${DEVICE_TOKEN}`)
  try {
    const res = await fetch(BACKEND_URL + path, { ...init, headers, signal: ctrl.signal })
    const ms = Math.round(performance.now() - t0)
    if (res.status === 304) return { ok: true, status: 304, ms }
    const body = await res.text()
    let data: any = body
    try { data = JSON.parse(body) } catch { /* not JSON */ }
    const fallback = res.headers.get('X-Cue-Fallback') === 'template'
    const notes = res.headers.get('X-Cue-Notes') ?? undefined
    if (!res.ok) {
      return { ok: false, status: res.status, ms, data, fallback, notes,
        error: data?.error?.code ?? `HTTP ${res.status}`, message: data?.error?.message }
    }
    return { ok: true, status: res.status, ms, data, fallback, notes }
  } catch (err) {
    return { ok: false, status: 0, ms: Math.round(performance.now() - t0), error: (err as Error).message }
  } finally {
    clearTimeout(timer)
  }
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})

/** GET /api/state. Called on launch; also the network/whitelist/CORS probe. */
export const getState = () => call<StateResponse>('/api/state', {}, 8000)

export type { SttResponse }

/** POST /api/stt with raw PCM (backend adds the WAV header). */
export const postStt = (pcm: Uint8Array<ArrayBuffer>, signal?: AbortSignal) =>
  call<SttResponse>('/api/stt', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Audio-Format': 'pcm_s16le;rate=16000;channels=1',
    },
    body: pcm,
  }, 15000, signal)

/** POST /api/briefs/text { text } -> { brief } (fast path). */
export const postBriefText = (text: string, signal?: AbortSignal) =>
  call<BriefResponse>('/api/briefs/text', jsonInit('POST', { text }), 15000, signal)

/** GET /api/briefs/:id?since=<version>. 304 (ok, no data) if nothing newer. */
export const getBrief = (id: string, since: number) =>
  call<BriefResponse>(`/api/briefs/${encodeURIComponent(id)}?since=${since}`, {}, 8000)

/** POST /api/briefs/:id/confirm { personId | null } -> { brief } (version + 1). */
export const postConfirm = (id: string, personId: string | null, signal?: AbortSignal) =>
  call<BriefResponse>(`/api/briefs/${encodeURIComponent(id)}/confirm`,
    jsonInit('POST', { personId } satisfies ConfirmRequest), 15000, signal)

/** POST /api/briefs/:id/recap -> { sent, ... } (Photon texts the wearer; sent=false when not set up). */
export const postRecap = (id: string) =>
  call<RecapResponse>(`/api/briefs/${encodeURIComponent(id)}/recap`, jsonInit('POST', {}), 12000)

/** POST /api/say { text, briefId? } -> { intent, brief?, goal?, recap?, say? }: hold and say anything. */
export const postSay = (text: string, briefId: string | undefined, signal?: AbortSignal) =>
  call<SayResponse>('/api/say', jsonInit('POST', { text, briefId } satisfies SayRequest), 20000, signal)

/** POST /api/briefs/:id/debrief { text } -> { brief } (version + 1; the wearer's own spoken note). */
export const postDebrief = (id: string, text: string) =>
  call<BriefResponse>(`/api/briefs/${encodeURIComponent(id)}/debrief`, jsonInit('POST', { text }), 10000)

/** POST /api/briefs/:id/transcript with a raw PCM chunk (consented conversation) -> { chars, added }. */
export const postTranscript = (id: string, pcm: Uint8Array<ArrayBuffer>) =>
  call<{ chars: number; added: number }>(`/api/briefs/${encodeURIComponent(id)}/transcript`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Audio-Format': 'pcm_s16le;rate=16000;channels=1' },
    body: pcm,
  }, 25000)

/** PUT /api/goal { goal, briefId? } -> { goal, brief? } (card 3 regenerated). */
export const putGoal = (goal: Goal, briefId?: string) =>
  call<GoalResponse>('/api/goal', jsonInit('PUT', { goal, briefId } satisfies GoalRequest), 10000)
