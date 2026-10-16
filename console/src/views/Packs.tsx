import * as React from 'react'
import * as api from '../live/api.ts'
import { KIND_LABEL } from '../model/packs.ts'
import type { PackChange, PackView } from '../model/packs.ts'
import { Ic } from '../ui/Icon.tsx'
import { toast } from '../ui/toasts.tsx'

/* A workspace's packs: each toggle, scope tick or act flag is one grants.json commit and a restart, so there is no
   Save button. An unmanaged workspace sees the list read-only. Candidates are read only here, never by a run. */

const STATE: Record<string, string> = { off: 'off', on: 'on', ok: 'working', warming_up: 'starting', signin_required: 'sign in needed', error: 'error' }
type Cand = 'reading' | { err: string } | { id: string; name: string }[]
type Checked = 'checking' | api.McpCheck
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms))

export function Packs({ ws }: { ws: string }) {
  const [got, setGot] = React.useState<{ managed: boolean; packs: PackView[] } | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [cands, setCands] = React.useState<Record<string, Cand>>({})
  const [typed, setTyped] = React.useState<Record<string, string>>({})
  const [checks, setChecks] = React.useState<Record<string, Checked>>({})
  const gen = React.useRef(0)
  // a new ws or an unmount ends any restart poll still running for the old one
  React.useEffect(() => {
    const my = ++gen.current
    setGot(null); setBusy(null); setCands({}); setTyped({}); setChecks({})
    api.packs(ws).then((r) => { if (gen.current === my) setGot(r) }, (e) => { if (gen.current === my) toast((e as Error).message) })
    return () => { gen.current++ }
  }, [ws])
  if (!got) return <section className="panel"><header><Ic n="layers" /><h3>Packs</h3></header><div className="pb"><p className="why">Loading…</p></div></section>

  const change = async (p: PackView, ch: PackChange): Promise<boolean> => {
    const my = gen.current
    setBusy(p.name)
    try {
      const r = await api.putPack(ws, p.name, ch)
      if (gen.current !== my) return true
      setGot(r)
      if (!r.restart) return true
      toast('Saved; the console restarts to apply it')
      // the old process may still answer until the restart: show the PUT result, and trust a GET only after one failed
      let down = false
      for (let i = 0; i < 60; i++) {
        await sleep(2000)
        if (gen.current !== my) return true
        try { const x = await api.packs(ws); if (down) { if (gen.current === my) setGot(x); break } } catch { down = true }
      }
      return true
    } catch (e) { if (gen.current === my) toast((e as Error).message); return false } finally { if (gen.current === my) setBusy(null) }
  }
  const pickFrom = async (p: PackView) => {
    const my = gen.current
    setCands((c) => ({ ...c, [p.name]: 'reading' }))
    let v: Cand
    try { v = await api.packCandidates(ws, p.name) } catch (e) { v = { err: (e as Error).message } }
    if (gen.current === my) setCands((c) => ({ ...c, [p.name]: v }))
  }
  const check = async (p: PackView) => {
    const my = gen.current
    setChecks((c) => ({ ...c, [p.name]: 'checking' }))
    let v: Checked
    try { v = await api.mcpCheck(ws, { name: p.name }) } catch (e) { v = { ok: false, error: (e as Error).message } }
    if (gen.current === my) setChecks((c) => ({ ...c, [p.name]: v }))
  }
  const add = async (p: PackView, ids: string[]) => {
    const id = (typed[p.name] ?? '').trim()
    if (id && await change(p, { scopes: [...ids, id] })) setTyped((t) => ({ ...t, [p.name]: '' }))
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
      {p.kind === 'mcp' && p.mcp !== undefined ? <p className="why mono" style={{ margin: 0 }}>{p.mcp ? `runs ${p.mcp}` : 'runs a server set in its config'}</p> : null}
      {p.hosts?.length ? <p className="why mono" style={{ margin: 0 }}>reaches {p.hosts.join(', ')}</p> : null}
      {p.kind === 'mcp' && p.config?.length ? <div style={{ display: 'grid', gap: 2 }}>
        <span className="hint">Settings, in config.json under workspaces.{ws}.packConfig.{p.name}; a secret goes in mcp.env as {'${env:NAME}'}</span>
        {p.config.map((c) => <span key={c.key} className="why" style={{ margin: 0 }}><span className="mono">{c.key}</span>{c.required ? ' *' : ''}: {c.value === undefined ? <i>not set</i> : <span className="mono">{Array.isArray(c.value) ? c.value.join(', ') : c.value}</span>} — {c.about}</span>)}
      </div> : null}
      {p.kind === 'mcp' && !p.problem ? <McpChecked p={p} c={checks[p.name]} dis={busy !== null} onCheck={() => void check(p)} /> : null}
      {p.on && p.tools?.length ? <div style={{ display: 'grid', gap: 4 }}>
        <span className="hint">Tools runs may call: the read ones come on with the pack; tick one that changes things only when a job needs it</span>
        {p.tools.map((t) => <label key={t.name} className="row" style={{ gap: 4 }}>
          <input type="checkbox" aria-label={`${p.title} tool ${t.name}`} checked={t.on} disabled={dis}
            onChange={(e) => void change(p, { tools: p.tools!.filter((x) => (x.name === t.name ? e.target.checked : x.on)).map((x) => x.name) })} />
          <span className="mono">{t.name}</span>{t.act ? <span className="chip error">changes things</span> : <span className="hint">reads</span>}
        </label>)}
      </div> : null}
      {p.on && p.kind === 'browser' && p.state === 'signin_required' && p.host
        ? <div><button className="btn sm" onClick={() => void api.front(ws, p.host!).catch((e) => toast((e as Error).message))}><Ic n="external" sm />Sign in to {p.host}</button></div> : null}
      {p.on && p.kind === 'remote-browser' ? <p className="why" style={{ margin: 0 }}>Sign-in happens on the work machine.</p> : null}
      {p.on && p.scoped ? <div style={{ display: 'grid', gap: 4 }}>
        <span className="hint">Scopes{p.scopeAbout ? ` — ${p.scopeAbout}` : ''}{ids.length ? '' : ': none ticked, so it serves nothing'}</span>
        {p.scopes.map((s) => <label key={s.id} className="row" style={{ gap: 4 }}><input type="checkbox" checked disabled={dis} onChange={() => void change(p, { scopes: ids.filter((x) => x !== s.id) })} />{s.name ?? s.id} <span className="hint mono">{s.id}</span></label>)}
        {Array.isArray(c) ? c.filter((x) => !ids.includes(x.id)).map((x) => <label key={x.id} className="row" style={{ gap: 4 }}><input type="checkbox" checked={false} disabled={dis} onChange={() => void change(p, { scopes: [...ids, x.id] })} />{x.name} <span className="hint mono">{x.id}</span></label>)
          : c === 'reading' ? <p className="why" style={{ margin: 0 }}>Reading…</p>
            : c ? <p className="why" style={{ margin: 0 }}>{c.err} <button className="btn sm ghost" disabled={dis} onClick={() => void pickFrom(p)}>Try again</button></p>
              : ro ? null : <div><button className="btn sm ghost" disabled={dis} onClick={() => void pickFrom(p)}>Pick from the account</button></div>}
        {ro ? null : <div className="row" style={{ gap: 4 }}>
          <input className="inp mono" placeholder="an id" aria-label={`${p.title} scope id`} value={typed[p.name] ?? ''} disabled={dis} onChange={(e) => setTyped({ ...typed, [p.name]: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter' && !dis) void add(p, ids) }} />
          <button className="btn sm" disabled={dis || !(typed[p.name] ?? '').trim()} onClick={() => void add(p, ids)}>Add</button>
        </div>}
      </div> : null}
      {p.on && p.actions.length ? <div style={{ display: 'grid', gap: 4 }}>
        {p.actions.map((a) => <div key={a} className="row" style={{ gap: 12 }}>
          <span className="mono">{a}</span>
          <label className="row" style={{ gap: 4 }}><input type="checkbox" aria-label={`${a}: I can`} checked={p.acts.includes(a)} disabled={dis} onChange={(e) => void change(p, { acts: e.target.checked ? [...p.acts, a] : p.acts.filter((x) => x !== a) })} />I can</label>
          <label className="row" style={{ gap: 4 }}><input type="checkbox" aria-label={`${a}: runs can`} checked={p.llmActs.includes(a)} disabled={dis || !p.acts.includes(a)} onChange={(e) => void change(p, { llmActs: e.target.checked ? [...p.llmActs, a] : p.llmActs.filter((x) => x !== a) })} />runs can</label>
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

/** Check starts the pack's server as a run would and lists its tools; the first start may download it, which takes minutes */
function McpChecked({ p, c, dis, onCheck }: { p: PackView; c: Checked | undefined; dis: boolean; onCheck(): void }) {
  const act = new Set((p.tools ?? []).filter((t) => t.act).map((t) => t.name)), named = new Set((p.tools ?? []).map((t) => t.name))
  return <div style={{ display: 'grid', gap: 4 }}>
    <div className="row" style={{ gap: 8 }}>
      <button className="btn sm ghost" disabled={dis || c === 'checking'} onClick={onCheck}><Ic n="refresh" sm />Check</button>
      <span className="hint">{c === 'checking' ? 'Starting the server; a first start downloads it and can take a few minutes…' : c === undefined ? 'starts the server once, lists its tools, stops it' : ''}</span>
    </div>
    {c && c !== 'checking' ? c.ok
      ? <div className="why" style={{ margin: 0 }}>{c.server ?? 'the server'} answered with {c.tools.length} tools:{' '}
          {c.tools.map((t) => <span key={t.name} className="mono" title={t.about}>{t.name}{act.has(t.name) ? ' (changes things)' : named.size && !named.has(t.name) ? ' (not in the pack)' : ''}{' '}</span>)}</div>
      : <p className="why" style={{ margin: 0 }}><span className="chip error">did not start</span> {c.error}</p> : null}
  </div>
}
