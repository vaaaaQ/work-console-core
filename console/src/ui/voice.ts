/* The mic: one recording through MediaRecorder, handed over as base64 with the type the browser recorded in
   (webm on most, mp4 on Safari). The browser asks for the mic on the first recording; it offers one only on
   a secure page, which the PC and the LAN side both are. */

export const canRecord = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined'

export interface Recording {
  /** ends it: the audio as base64 and its type */
  stop(): Promise<{ audio: string; mime: string }>
  /** ends it and drops the audio */
  cancel(): void
}

const TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']

export async function record(): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const type = TYPES.find((t) => MediaRecorder.isTypeSupported(t))
  let mr: MediaRecorder
  try { mr = new MediaRecorder(stream, type ? { mimeType: type } : undefined) } catch (e) { stream.getTracks().forEach((t) => t.stop()); throw e }
  const parts: Blob[] = [], off = () => stream.getTracks().forEach((t) => t.stop())
  mr.ondataavailable = (e) => { if (e.data.size) parts.push(e.data) }
  const ended = new Promise<void>((res) => { mr.onstop = () => res() })
  mr.start()
  const end = () => { if (mr.state !== 'inactive') mr.stop(); off() }
  return {
    async stop() {
      end()
      await ended
      const blob = new Blob(parts, { type: mr.mimeType || type || 'audio/webm' })
      return { audio: await base64(blob), mime: blob.type }
    },
    cancel: end,
  }
}

/** one recording at a time with a length cap; cancel also works while the browser still asks for the mic */
export class Recorder {
  private r: Recording | null = null
  private cap?: ReturnType<typeof setTimeout>
  private want = false
  private o: { max: number; onCap: () => void; record?: () => Promise<Recording> }
  constructor(o: Recorder['o']) { this.o = o }
  get on() { return this.want }
  /** false when it was cancelled or stopped while the browser asked; throws why the mic did not start */
  async start() {
    this.want = true
    let r: Recording
    try { r = await (this.o.record ?? record)() } catch (e) { this.want = false; throw e }
    if (!this.want || this.r) { r.cancel(); return false }
    this.r = r
    this.cap = setTimeout(this.o.onCap, this.o.max)
    return true
  }
  /** the audio, or null when nothing was recording */
  async stop() {
    clearTimeout(this.cap); this.want = false
    const r = this.r; this.r = null
    return r ? r.stop() : null
  }
  cancel() { clearTimeout(this.cap); this.want = false; this.r?.cancel(); this.r = null }
}

/** why the mic could not start, in words */
export function micError(e: unknown) {
  const n = (e as { name?: string } | null)?.name
  if (n === 'NotAllowedError' || n === 'SecurityError') return 'The browser did not allow the mic. Allow it for this page and try again.'
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'No mic was found.'
  if (n === 'NotReadableError') return 'The mic is busy in another app.'
  return `The mic did not start: ${(e as Error)?.message || String(e)}`
}

async function base64(b: Blob) {
  const u = new Uint8Array(await b.arrayBuffer())
  let s = ''
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000))
  return btoa(s)
}
