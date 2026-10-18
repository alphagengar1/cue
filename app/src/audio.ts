// Push-to-talk capture from the glasses mic.
// Format (Even docs + SDK): PCM s16le, 16 kHz, mono = 32,000 bytes per second.
// The bridge pushes frames as event.audioEvent.audioPcm while audioControl(true).

import { AudioInputSource, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { serial } from './layout'

/** A finished clip: plain ArrayBuffer-backed bytes (usable as a fetch body / Blob part). */
export type Clip = Uint8Array<ArrayBuffer>

export const BYTES_PER_SEC = 32000
export const TAIL_MS = 300        // keep capturing after stop (02: Listening)
export const MIN_CLIP_MS = 400    // shorter clips are discarded (02: Listening)
export const MAX_CLIP_MS = 12000  // auto-stop (02: Listening); a spoken debrief needs more than a name
const LATE_MS = 150               // 1-2 frames trickle in after audioControl(false) (measured)

export interface MicStats {
  recording: boolean
  frames: number
  bytes: number
  lastFrameBytes: number
  startedAt: number          // when audioControl(true) was sent
  firstFrameAt: number       // 0 until the first frame
  lastFrameAt: number
  stoppedAt: number          // when audioControl(false) was sent
  lateFrames: number         // frames that arrived after audioControl(false)
  openResult: boolean | undefined   // what audioControl(true) returned
  ignoreUntil: number        // late frames from the previous capture arrive until about here
}

const fresh = (): MicStats => ({
  recording: false, frames: 0, bytes: 0, lastFrameBytes: 0,
  startedAt: 0, firstFrameAt: 0, lastFrameAt: 0, stoppedAt: 0, lateFrames: 0,
  openResult: undefined, ignoreUntil: 0,
})

export class Mic {
  stats: MicStats = fresh()
  private chunks: Uint8Array[] = []
  constructor(private bridge: EvenAppBridge) {}

  /** Seconds of audio received so far. */
  get seconds() { return this.stats.bytes / BYTES_PER_SEC }

  async start() {
    if (this.stats.recording) return
    this.chunks = []
    const lastStop = this.stats.stoppedAt
    this.stats = { ...fresh(), recording: true, startedAt: Date.now(), ignoreUntil: lastStop ? lastStop + LATE_MS : 0 }
    const ok = await serial('audioControl(true)', () =>
      this.bridge.audioControl(true, AudioInputSource.Glasses))
    this.stats.openResult = ok
    console.log('[mic] audioControl(true) ->', ok)
  }

  /** Call with every audioEvent PCM frame. */
  onFrame(pcm: Uint8Array) {
    const now = Date.now()
    if (!this.stats.recording || now < this.stats.ignoreUntil) {
      if (this.stats.stoppedAt || this.stats.ignoreUntil) this.stats.lateFrames++
      return
    }
    this.chunks.push(pcm.slice())
    this.stats.frames++
    this.stats.bytes += pcm.length
    this.stats.lastFrameBytes = pcm.length
    if (!this.stats.firstFrameAt) this.stats.firstFrameAt = now
    this.stats.lastFrameAt = now
  }

  /** Hand over what has been captured so far and keep recording (conversation chunks). */
  drain(): Clip {
    const clip = concat(this.chunks)
    this.chunks = []
    return clip
  }

  /** Stop after the tail; returns the clip (or null if discarded). */
  async stop(opts: { tail?: boolean; discard?: boolean } = {}): Promise<Clip | null> {
    if (!this.stats.recording) return null
    if (opts.tail !== false) await new Promise(r => setTimeout(r, TAIL_MS))
    this.stats.recording = false
    this.stats.stoppedAt = Date.now()
    await serial('audioControl(false)', () => this.bridge.audioControl(false))
    if (opts.discard) { this.chunks = []; return null }
    const clip = concat(this.chunks)
    this.chunks = []
    return clip
  }
}

function concat(parts: Uint8Array[]): Clip {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

/** 44-byte WAV header + PCM, so the phone page can play the clip back. */
export function pcmToWav(pcm: Clip): Blob {
  const h = new DataView(new ArrayBuffer(44))
  const w = (o: number, s: string) => [...s].forEach((c, i) => h.setUint8(o + i, c.charCodeAt(0)))
  w(0, 'RIFF'); h.setUint32(4, 36 + pcm.length, true); w(8, 'WAVE')
  w(12, 'fmt '); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true)
  h.setUint32(24, 16000, true); h.setUint32(28, BYTES_PER_SEC, true)
  h.setUint16(32, 2, true); h.setUint16(34, 16, true)
  w(36, 'data'); h.setUint32(40, pcm.length, true)
  return new Blob([h.buffer, pcm], { type: 'audio/wav' })
}

/** Peak level 0..1 of s16le PCM, to see if the mic hears anything at all. */
export function peak(pcm: Uint8Array): number {
  const v = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  let max = 0
  for (let i = 0; i + 1 < pcm.length; i += 2) max = Math.max(max, Math.abs(v.getInt16(i, true)))
  return max / 32768
}
