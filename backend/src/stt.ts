// POST /api/stt: raw PCM (s16le, 16 kHz, mono) -> WAV -> Deepgram nova-3 prerecorded.
// Audio stays in memory and is never logged or written to disk (01 section 6).
// TODO (01 section 7): retry once on Groq Whisper when Deepgram errors or times out.
import { config } from "./config.js";
import { CueError } from "./errors.js";
import { store } from "./store.js";

export function pcmToWav(pcm: Buffer, sampleRate = 16000, channels = 1, bitsPerSample = 16): Buffer {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);            // PCM fmt chunk size
  h.writeUInt16LE(1, 20);             // audio format: PCM
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(bitsPerSample, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** Parse "pcm_s16le;rate=16000;channels=1". Only s16le is supported. */
export function parseAudioFormat(header: string | undefined): { rate: number; channels: number } {
  if (!header) return { rate: 16000, channels: 1 };
  const [codec, ...params] = header.split(";").map((s) => s.trim());
  if (codec !== "pcm_s16le") throw new CueError("BAD_REQUEST", `unsupported audio format ${codec}`);
  const kv = Object.fromEntries(params.map((p) => p.split("=").map((s) => s.trim())));
  const rate = kv.rate === undefined || kv.rate === "" ? 16000 : Number(kv.rate);
  const channels = kv.channels === undefined || kv.channels === "" ? 1 : Number(kv.channels);
  // Out-of-range values would make pcmToWav throw a RangeError (500); reject them as bad input.
  if (!Number.isInteger(rate) || rate < 8000 || rate > 48000) {
    throw new CueError("BAD_REQUEST", `unsupported audio rate ${kv.rate} (8000-48000)`);
  }
  if (!Number.isInteger(channels) || channels < 1 || channels > 2) {
    throw new CueError("BAD_REQUEST", `unsupported audio channels ${kv.channels} (1-2)`);
  }
  return { rate, channels };
}

/** Keyterms: org names and person names in the active event (max 50), plus goal words. */
export function keyterms(): string[] {
  const terms = new Set<string>();
  for (const o of store.eventOrgs()) terms.add(o.name);
  for (const p of store.eventPeople()) if (p.fromEventList || p.confirmed) terms.add(p.name); // not search guesses
  for (const p of store.people.values()) if ((p.fromEventList || p.confirmed) && terms.size < 50) terms.add(p.name); // other loaded events too
  return [...terms].slice(0, 50);
}

interface DeepgramResponse {
  results?: { channels?: { alternatives?: { transcript?: string }[] }[] };
}

export async function transcribe(pcm: Buffer, formatHeader?: string): Promise<string> {
  const { rate, channels } = parseAudioFormat(formatHeader); // bad header -> 400 even without a key
  if (!config.deepgramKey) {
    throw new CueError("STT_FAILED", "Speech-to-text not configured (DEEPGRAM_API_KEY not set)", 503);
  }
  if (!pcm.length) throw new CueError("STT_EMPTY", "Didn't catch that");
  const wav = pcmToWav(pcm.length % 2 ? pcm.subarray(0, pcm.length - 1) : pcm, rate, channels);

  const url = new URL("https://api.deepgram.com/v1/listen");
  url.searchParams.set("model", "nova-3");
  url.searchParams.set("smart_format", "true");
  for (const k of keyterms()) url.searchParams.append("keyterm", k);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Token ${config.deepgramKey}`, "content-type": "audio/wav" },
      body: new Uint8Array(wav),
      signal: AbortSignal.timeout(config.sttTimeoutMs),
    });
  } catch (err) {
    throw new CueError("STT_FAILED", `Deepgram unreachable: ${String(err)}`, 502);
  }
  if (!res.ok) {
    throw new CueError("STT_FAILED", `Deepgram ${res.status}: ${(await res.text()).slice(0, 200)}`, 502);
  }
  const data = (await res.json()) as DeepgramResponse;
  const transcript = data.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? "";
  if (!transcript) throw new CueError("STT_EMPTY", "Didn't catch that");
  return transcript;
}
