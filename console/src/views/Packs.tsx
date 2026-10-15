import * as React from 'react'
import * as api from '../live/api.ts'
import { KIND_LABEL } from '../model/packs.ts'
import type { PackChange, PackView } from '../model/packs.ts'
import { Ic } from '../ui/Icon.tsx'
import { toast } from '../ui/toasts.tsx'

/* A workspace's packs: each toggle, scope tick or act flag is one grants.json commit and a restart, so there is no
   Save button. An unmanaged workspace sees the list read-only. Candidates are read only here, never by a run. */

const STATE: Record<string, string> = { off: 'off', on: 'on', ok: 'working', warming_up: 'starting', signin_required: 'sign in needed', error: 'error' }
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms))

export function Packs({ ws }: { ws: string }) {
  const [got, setGot] = React.useState<{ managed: boolean; packs: PackView[] } | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [cands, setCands] = React.useState<Record<string, { id: string; name: string }[] | string>>({})
  const [typed, setTyped] = React.useState<Record<string, string>>({})
  const load = React.useCallback(() => api.packs(ws).then(setGot, (e) => toast((e as Error).message)), [ws])
  React.useEffect(() => { setGot(null); void load() }, [load])
  if (!got) return <section className="panel"><header><Ic n="layers" /><h3>Packs</h3></header><div className="pb"><p className="why">Loading…</p></div></section>

  const change = async (p: PackView, ch: PackChange) => {
    setBusy(p.name)
    try {
      setGot(await api.putPack(ws, p.name, ch))
      toast('Saved; the console restarts to apply it')
      // the console comes back on its own; ask again until it answers
      for (let i = 0; i < 30; i++) { await sleep(2000); try { setGot(await api.packs(ws)); break } catch { /* still restarting */ } }
    } catch (e) { toast((e as Error).message) } finally { setBusy(null) }
  }
  const pickFrom = async (p: PackView) => {
    try { setCands({ ...cands, [p.name]: await api.packCandidates(ws, p.name) }) } catch (e) { setCands({ ...cands, [p.name]: (e as Error).message }) }
  }
  const ro = !got.managed
  const row = (p: PackView) => {
    const ids = p.scopes.map((s) => s.id), c = cands[p.name], dis = ro || busy !== null
    return <div key={`${p.name}:${p.problem ?? ''}`} className="dc" style={{ display: 'grid', gap: 8 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span><b>{p.title}</b> <span className="hint">{p.name} · {KIND_LABEL[p.kind]}</span></span>
        <span className="row" style={{ gap: 8 }}>
          <span className={`chip ${p.state}`} title={p.message ?? ''}>{STATE[p.state] ?? p.state.replace(/_/g, ' ')}</span>
          {p.problem && !p.on ? null : <label className="row" style={{ gap: 4 }}><input type="checkbox" aria-label={`${p.title} on`} checked={p.on} disabled={dis} onChange={(e) => void change(p, { on: e.target.checked })} />on</label>}
        </span>
      </div>
      <p className="why" style={{ margin: 0 }}>{p.about}{p.message ? ` — ${p.message}` : ''}</p>
      {p.kind === 'mcp' && p.mcp ? <p className="why mono" style={{ margin: 0 }}>runs {p.mcp}</p> : null}
      {p.on && p.kind === 'browser' && p.state === 'signin_required' && p.host
        ? <div><button className="btn sm" onClick={() => void api.front(ws, p.host!).catch((e) => toast((e as Error).message))}><Ic n="external" sm />Sign in to {p.host}</button></div> : null}
      {p.on && p.kind === 'remote-browser' ? <p className="why" style={{ margin: 0 }}>Sign-in happens on the work machine.</p> : null}
      {p.on && p.scoped ? <div style={{ display: 'grid', gap: 4 }}>
        <span className="hint">Scopes{p.scopeAbout ? ` — ${p.scopeAbout}` : ''}{ids.length ? '' : ': none ticked, so it serves nothing'}</span>
        {p.scopes.map((s) => <label key={s.id} className="row" style={{ gap: 4 }}><input type="checkbox" checked disabled={dis} onChange={() => void change(p, { scopes: ids.filter((x) => x !== s.id) })} />{s.name ?? s.id} <span className="hint mono">{s.id}</span></label>)}
        {Array.isArray(c) ? c.filter((x) => !ids.includes(x.id)).map((x) => <label key={x.id} className="row" style={{ gap: 4 }}><input type="checkbox" checked={false} disabled={dis} onChange={() => void change(p, { scopes: [...ids, x.id] })} />{x.name} <span className="hint mono">{x.id}</span></label>)
          : typeof c === 'string' ? <p className="why" style={{ margin: 0 }}>{c}</p>
            : ro ? null : <div><button className="btn sm ghost" disabled={dis} onClick={() => void pickFrom(p)}>Pick from the account</button></div>}
        {ro ? null : <div className="row" style={{ gap: 4 }}>
          <input className="inp mono" placeholder="an id" value={typed[p.name] ?? ''} onChange={(e) => setTyped({ ...typed, [p.name]: e.target.value })} />
          <button className="btn sm" disabled={dis || !(typed[p.name] ?? '').trim()} onClick={() => { void change(p, { scopes: [...ids, typed[p.name].trim()] }); setTyped({ ...typed, [p.name]: '' }) }}>Add</button>
        </div>}
      </div> : null}
      {p.on && p.actions.length ? <div style={{ display: 'grid', gap: 4 }}>
        {p.actions.map((a) => <div key={a} className="row" style={{ gap: 12 }}>
          <span className="mono">{a}</span>
          <label className="row" style={{ gap: 4 }}><input type="checkbox" checked={p.acts.includes(a)} disabled={dis} onChange={(e) => void change(p, { acts: e.target.checked ? [...p.acts, a] : p.acts.filter((x) => x !== a) })} />I can</label>
          <label className="row" style={{ gap: 4 }}><input type="checkbox" checked={p.llmActs.includes(a)} disabled={dis || !p.acts.includes(a)} onChange={(e) => void change(p, { llmActs: e.target.checked ? [...p.llmActs, a] : p.llmActs.filter((x) => x !== a) })} />runs can</label>
        </div>)}
      </div> : null}
    </div>
  }
  return <section className="panel"><header><Ic n="layers" /><h3>Packs</h3></header>
    <div className="pb" style={{ display: 'grid', gap: 12 }}>
      {ro ? <p className="why" style={{ margin: 0 }}>This workspace has no grants.json: its packs come from its config and are shown read-only.</p> : null}
      {got.packs.filter((p) => p.listed || p.on).map(row)}
    </div></section>
}
