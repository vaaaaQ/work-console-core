import { HttpError } from '../events.ts'
import { readToken } from '../config.ts'

/* Speech to text through OpenAI's whisper-1. The key sits in a file read on every call, so placing or
   rotating it needs no restart, and no key means no voice. The key never reaches an error, a log or
   the page: OpenAI's own messages can quote part of it, so they are scrubbed before they leave. */

export interface Voice {
  /** a key is there, so the page shows the mic */
  ready(): boolean
  /** the words in one recording; signal = the page dropped the request */
  transcribe(audio: string, mime: string, signal?: AbortSignal): Promise<string>
}

export interface WhisperOpts {
  keyPath: string
  /** tests stand in for OpenAI */
  fetch?: typeof fetch
  url?: string
  timeoutMs?: number
}

/** the containers whisper-1 reads, by the type a browser's MediaRecorder names */
const EXT: Record<string, string> = {
  'audio/webm': 'webm', 'video/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'mp4', 'video/mp4': 'mp4',
  'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a', 'audio/aac': 'm4a', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/flac': 'flac',
}
const B64 = /^[A-Za-z0-9+/\s]*={0,2}\s*$/

/** an API key, whole or as OpenAI quotes it (sk-ab***yz) */
const KEYISH = /\bsk-[A-Za-z0-9_*.-]{2,}/g
const scrub = (t: string, key: string) => (key ? t.split(key).join('***') : t).replace(KEYISH, 'sk-***')

export function whisper(o: WhisperOpts): Voice {
  const url = o.url ?? 'https://api.openai.com/v1/audio/transcriptions'
  return {
    ready: () => !!readToken(o.keyPath),
    async transcribe(audio, mime, signal) {
      const type = String(mime || '').split(';')[0].trim().toLowerCase(), ext = EXT[type]
      if (!ext) throw new HttpError(400, 'bad_args', `mime must be an audio type whisper reads (${[...new Set(Object.values(EXT))].join(', ')}), not ${type || 'none'}`)
      const raw = String(audio || '').replace(/^data:[^,]*,/, '')
      if (!B64.test(raw)) throw new HttpError(400, 'bad_args', 'audio must be base64')
      const bytes = Buffer.from(raw, 'base64')
      if (!bytes.length) throw new HttpError(400, 'bad_args', 'audio is empty')
      const key = readToken(o.keyPath)
      if (!key) throw new HttpError(503, 'no_key', 'voice is off: there is no OpenAI key in the console folder (openai.key)')
      const form = new FormData()
      form.append('file', new Blob([bytes], { type }), `speech.${ext}`)
      form.append('model', 'whisper-1')
      form.append('response_format', 'json')
      const time = new AbortController(), t = setTimeout(() => time.abort(), o.timeoutMs ?? 120_000)
      let r: Response, txt: string
      try {
        r = await (o.fetch ?? fetch)(url, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form, signal: signal ? AbortSignal.any([signal, time.signal]) : time.signal })
        txt = await r.text()
      } catch (e) {
        if (signal?.aborted) throw new HttpError(499, 'aborted', 'the page dropped the request')
        if (time.signal.aborted) throw new HttpError(504, 'timeout', 'OpenAI did not answer in time')
        throw new HttpError(502, 'unreachable', `OpenAI could not be reached: ${scrub(e instanceof Error ? e.message : String(e), key)}`)
      } finally { clearTimeout(t) }
      let body: { text?: unknown; error?: { message?: unknown } } = {}
      try { body = txt ? JSON.parse(txt) : {} } catch { /* told below */ }
      if (r.status === 401) throw new HttpError(502, 'bad_key', 'OpenAI refused the key in openai.key')
      if (!r.ok) {
        const said = typeof body.error?.message === 'string' ? body.error.message : txt.slice(0, 300)
        throw new HttpError(r.status === 429 ? 503 : 502, r.status === 429 ? 'busy' : 'transcribe_failed', `OpenAI answered ${r.status}: ${scrub(said, key)}`)
      }
      if (typeof body.text !== 'string') throw new HttpError(502, 'bad_reply', 'OpenAI sent no text')
      return body.text.trim()
    },
  }
}
