import * as React from 'react'
import { failText } from '../actions/flow.tsx'
import { tfmt } from '../lib/util.ts'
import * as api from '../live/api.ts'
import { LIVE } from '../live/api.ts'
import { confirmContent, confirmFields } from '../model/confirm.ts'
import type { ConfirmValues } from '../model/confirm.ts'
import type { RunRec } from '../model/types.ts'
import { commit } from '../store.ts'
import { Ic } from './Icon.tsx'
import { toast } from './toasts.tsx'

/* An MCP server's question a run waits on (elicitation): its text word for word, the form its schema asks for, and
   Confirm or Decline. Nothing goes back to the server until a button is pressed; no answer in 10 minutes declines it. */

export function Confirm({ run, head }: { run: RunRec; head?: React.ReactNode }) {
  const cf = run.cf!
  const fields = React.useMemo(() => confirmFields(cf.schema), [cf.id])
  const [vals, setVals] = React.useState<ConfirmValues>({})
  const [busy, setBusy] = React.useState(false)
  const answer = async (action: 'accept' | 'decline') => {
    const { content, missing } = confirmContent(fields, vals)
    if (action === 'accept' && missing.length) { toast(`Fill in ${missing.join(', ')}`); return }
    setBusy(true)
    try {
      const r = await api.elicit(run.id, cf.id, action, action === 'accept' ? content : undefined)
      commit(() => { LIVE.runs[r.run.id] = r.run })
    } catch (e) { toast(failText(e)) } finally { setBusy(false) }
  }
  const set = (k: string, v: string | boolean) => setVals((x) => ({ ...x, [k]: v }))
  return (
    <div className="talk-box confirm" role="group" aria-label={`Confirm what ${cf.srv} asks`}>
      {head}
      <div className="hint"><Ic n="alert" sm /> <b>{cf.title || `The MCP server ${cf.srv} asks`}</b> · {cf.srv} · {tfmt(cf.at)}</div>
      <pre className="out" style={{ whiteSpace: 'pre-wrap' }}>{cf.msg}</pre>
      {cf.description ? <div className="why">{cf.description}</div> : null}
      {fields.map((f) => {
        const v = vals[f.key] ?? f.value
        return <label key={f.key} className="row" style={{ gap: 6 }} title={f.about}>
          {f.kind === 'boolean' ? <input type="checkbox" checked={v === true} disabled={busy} onChange={(e) => set(f.key, e.target.checked)} /> : null}
          <span>{f.label}{f.required ? ' *' : ''}</span>
          {f.kind === 'choice' ? <select className="inp" value={String(v)} disabled={busy} onChange={(e) => set(f.key, e.target.value)}>{f.choices.map((c) => <option key={c.v} value={c.v}>{c.label}</option>)}</select>
            : f.kind === 'boolean' ? null
              : <input className="inp" inputMode={f.kind === 'number' ? 'decimal' : undefined} value={String(v)} disabled={busy} onChange={(e) => set(f.key, e.target.value)} />}
        </label>
      })}
      <div className="row">
        <button type="button" className="btn sm pri" disabled={busy} onClick={() => void answer('accept')}><Ic n="check" sm />Confirm</button>
        <button type="button" className="btn sm" disabled={busy} onClick={() => void answer('decline')}><Ic n="x" sm />Decline</button>
      </div>
    </div>
  )
}
