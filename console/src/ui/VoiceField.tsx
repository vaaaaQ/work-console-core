import * as React from 'react'
import * as api from '../live/api.ts'
import { LIVE } from '../live/api.ts'
import type { RunIntent } from '../model/types.ts'
import { S } from '../model/world.ts'
import { Ic } from './Icon.tsx'
import { canRecord, micError, Recorder } from './voice.ts'
import { insertAt, swap } from './voiceText.ts'

/* A textarea that also takes speech: the recording's words go in at the cursor at once, then the
   formatter's clean text replaces them. A form reads it like any textarea. */

/** a recording stops on its own after this long */
const REC_MAX = 10 * 60_000
/** how much of the text being answered goes to the formatter */
const CTX_MAX = 8000
const INTENT_L: Record<RunIntent, string> = { revise: 'Revise', accept: 'Revise and accept', ask: 'Ask' }
type Busy = null | 'wait' | 'rec' | 'stt' | 'fmt'
const BUSY_L: Record<Exclude<Busy, null>, string> = { wait: 'Waiting for the mic…', rec: 'Listening…', stt: 'Turning it into text…', fmt: 'Tidying up…' }

/** value + onChange to hold it outside, or name + defaultValue inside a form; onIntent shows the revise/accept/ask
    choice and lets the formatter pick it from the words */
export function VoiceField(p: {
  name?: string; defaultValue?: string; value?: string; onChange?(v: string): void; ctx?: string; target: 'llm' | 'people'
  intent?: RunIntent; onIntent?(i: RunIntent): void; rows?: number; placeholder?: string; autoFocus?: boolean; maxLength?: number
}) {
  const [own, setOwn] = React.useState(p.defaultValue ?? '')
  const v = p.value ?? own, vr = React.useRef(v)
  vr.current = v
  const set = (t: string) => { vr.current = t; if (p.value === undefined) setOwn(t); p.onChange?.(t) }
  const ta = React.useRef<HTMLTextAreaElement>(null), at = React.useRef<number | null>(null), ac = React.useRef<AbortController | null>(null)
  const [busy, setBusy] = React.useState<Busy>(null), [err, setErr] = React.useState(''), [said, setSaid] = React.useState('')
  // the cap calls the newest stop, not the one of the render that made the Recorder
  const rec = React.useRef<Recorder | null>(null), stopNow = React.useRef<() => Promise<void>>(async () => {})
  rec.current ??= new Recorder({ max: REC_MAX, onCap: () => { void stopNow.current() } })
  React.useEffect(() => () => { rec.current?.cancel(); ac.current?.abort() }, [])
  const ws = S.ws, ctx = p.ctx?.slice(0, CTX_MAX)

  /** the formatter's text over the raw words at a..b; field = the text around them */
  async function tidy(raw: string, field: string, a: number, b: number) {
    const c = new AbortController()
    ac.current = c; setBusy('fmt')
    try {
      const r = await api.format(ws, { text: raw, ctx, field, target: p.target, intents: !!p.onIntent }, c.signal)
      if (ac.current !== c) return
      const next = swap(vr.current, a, b, raw, r.text)
      if (next != null) set(next)
      if (r.intent && p.onIntent) p.onIntent(r.intent)
    } catch (e) {
      const x = e as api.ApiError
      if (ac.current === c && x.status !== 499) setErr(`Not tidied up; the words are as said. ${x.message}`)
    } finally { if (ac.current === c) { ac.current = null; setBusy(null) } }
  }
  async function start() {
    setErr('')
    at.current = ta.current && document.activeElement === ta.current ? ta.current.selectionStart : null
    setBusy('wait')
    try { if (!(await rec.current!.start())) return } catch (e) { setBusy(null); setErr(micError(e)); return }
    setBusy('rec')
  }
  async function stop() {
    let a: { audio: string; mime: string } | null
    try { a = await rec.current!.stop() } catch (e) { setBusy(null); setErr(`The recording failed: ${(e as Error).message}`); return }
    if (!a) { setBusy(null); return }
    if (!a.audio) { setBusy(null); setErr('Nothing was recorded.'); return }
    const c = new AbortController()
    ac.current = c; setBusy('stt')
    let raw: string
    try { raw = (await api.transcribe(ws, a.audio, a.mime, c.signal)).trim() } catch (e) {
      const x = e as api.ApiError
      if (ac.current === c) { ac.current = null; setBusy(null); if (x.status !== 499) setErr(`The recording was not turned into text: ${x.message}`) }
      return
    }
    if (ac.current !== c) return
    if (!raw) { ac.current = null; setBusy(null); setErr('Nothing was heard.'); return }
    const field = vr.current, put = insertAt(field, at.current, raw)
    set(put.v); setSaid(raw)
    await tidy(raw, field, put.a, put.b)
  }
  stopNow.current = stop
  const cancel = () => { rec.current?.cancel(); ac.current?.abort(); ac.current = null; setBusy(null) }
  const mic = LIVE.voice && canRecord(), recOn = busy === 'rec' || busy === 'wait'
  return (
    <div className="vf">
      <textarea ref={ta} className="ta" name={p.name} value={v} rows={p.rows ?? 4} placeholder={p.placeholder} maxLength={p.maxLength}
        data-autofocus={p.autoFocus ? '' : undefined} onChange={(e) => set(e.currentTarget.value)} readOnly={recOn} />
      <div className="vf-bar">
        {mic && (recOn
          ? <button type="button" className="btn sm nj-mic on" onClick={() => { void stop() }} disabled={busy === 'wait'} aria-label="Stop and use the recording"><Ic n="stop" sm />Done</button>
          : <button type="button" className="btn sm" onClick={() => { void start() }} disabled={!!busy} title="Say it; the words go in at the cursor"><Ic n="mic" sm />Speak</button>)}
        {LIVE.voice && !busy && <button type="button" className="btn sm" disabled={!v.trim()} title="The formatter cleans up the whole text"
          onClick={() => { const t = vr.current; void tidy(t, '', 0, t.length) }}>Tidy up</button>}
        {busy && <button type="button" className="btn sm" onClick={cancel} title="Stop; the text stays as it is"><Ic n="x" sm />Cancel</button>}
        {p.onIntent && <span className="seg">{(['revise', 'accept', 'ask'] as RunIntent[]).map((i) =>
          <button key={i} type="button" aria-pressed={p.intent === i} onClick={() => p.onIntent!(i)}>{INTENT_L[i]}</button>)}</span>}
        {busy && <span className="vf-st">{BUSY_L[busy]}</span>}
      </div>
      {err && <div className="vf-err">{err}</div>}
      {said && <details className="vf-said"><summary>What you said</summary>{said}</details>}
    </div>
  )
}
