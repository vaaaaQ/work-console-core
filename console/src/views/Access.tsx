import * as React from 'react'
import { tfmt } from '../lib/util.ts'
import { go } from '../actions/nav.tsx'
import { requestAccept, requestReject } from '../actions/access.tsx'
import * as api from '../live/api.ts'
import type { AccessChange, AccessRequest, AccessView } from '../live/api.ts'
import { KNOWN_RUN_TOOLS } from '../model/access.ts'
import { Ic } from '../ui/Icon.tsx'
import { toast } from '../ui/toasts.tsx'

/* Settings → Access: what grants.json lets the runs reach besides the packs. Each change is one commit and a restart,
   as in Packs, so there is no Save button. A pack's own MCP server is shown but changed only in Packs. */

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms))
const diffLine = (l: string, i: number) => <span key={i} className={l[0] === '+' ? 'add' : l[0] === '-' || l[0] === '!' ? 'del' : undefined}>{l}{'\n'}</span>

/** a run's request to add to the grants; by = each job/step that asked */
export function RequestCard({ ws, r }: { ws: string; r: AccessRequest }) {
  const bad = r.lines.some((l) => l.startsWith('!'))
  return (
    <article className="dc">
      <div className="dc-h"><span className="st"><Ic n="sliders" sm /><b>Access · request</b></span>
        {r.by.map((b) => { const i = b.indexOf('/'), job = i > 0 ? b.slice(0, i) : b, step = i > 0 ? b.slice(i + 1) : undefined
          return <button key={b} className="lnk mono" onClick={() => go('job', job, step)}>{b}</button> })}
        <span className="src">{tfmt(r.at)}</span></div>
      <div className="why">{r.reason}</div>
      <pre className="out diff">{r.lines.length ? r.lines.map(diffLine) : 'the grants already hold it'}</pre>
      <div className="row"><button className="btn sm pri" disabled={bad} onClick={() => void requestAccept(ws, r.id)}><Ic n="check" sm />Accept</button>
        <button className="btn sm" onClick={() => requestReject(ws, r.id)}><Ic n="x" sm />Reject…</button></div>
    </article>
  )
}

/** a list of names: each with a remove button, and a field to add one */
function Names({ label, items, ph, dis, min = 0, onChange }: { label: string; items: string[]; ph: string; dis: boolean; min?: number; onChange: (xs: string[]) => Promise<boolean> }) {
  const [typed, setTyped] = React.useState('')
  const add = async () => { const v = typed.trim(); if (v && !items.includes(v) && await onChange([...items, v])) setTyped('') }
  return <div style={{ display: 'grid', gap: 4 }}>
    {items.length ? <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
      {items.map((x) => <span key={x} className="chip mono">{x}
        {dis ? null : <button className="lnk" aria-label={`Remove ${x}`} disabled={items.length <= min} onClick={() => void onChange(items.filter((y) => y !== x))}><Ic n="x" sm /></button>}</span>)}
    </div> : <p className="why" style={{ margin: 0 }}>None.</p>}
    {dis ? null : <div className="row" style={{ gap: 4 }}>
      <input className="inp mono" placeholder={ph} aria-label={label} value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void add() }} />
      <button className="btn sm" disabled={!typed.trim()} onClick={() => void add()}>Add</button>
    </div>}
  </div>
}

const json = (x: unknown) => JSON.stringify(x, null, 2)
const parseCfg = (t: string): Record<string, unknown> | string => {
  try { const v = JSON.parse(t); return v && typeof v === 'object' && !Array.isArray(v) ? v : 'a server is a JSON object: command and args, or url' } catch (e) { return (e as Error).message }
}

type Checked = 'checking' | api.McpCheck
/** the tools a Check listed, each with a tick: on = runs may call it as mcp__<server>__<tool> */
function ToolTicks({ c, picked, dis, onPick }: { c: Checked | undefined; picked: string[]; dis: boolean; onPick(xs: string[]): void }) {
  if (!c) return null
  if (c === 'checking') return <p className="why" style={{ margin: 0 }}>Starting the server; a first start downloads it and can take a few minutes…</p>
  if (!c.ok) return <p className="why" style={{ margin: 0 }}><span className="chip error">did not start</span> {c.error}</p>
  return <div style={{ display: 'grid', gap: 4 }}>
    <span className="hint">{c.server ?? 'The server'} answered with {c.tools.length} tools. Ticked ones runs may call; a read-only one comes ticked</span>
    {c.tools.map((t) => <label key={t.name} className="row" style={{ gap: 4 }} title={t.about}>
      <input type="checkbox" checked={picked.includes(t.name)} disabled={dis} onChange={(e) => onPick(e.target.checked ? [...picked, t.name] : picked.filter((x) => x !== t.name))} />
      <span className="mono">{t.name}</span>{t.readOnly ? <span className="hint">reads</span> : <span className="chip error">{t.destructive ? 'destructive' : 'may change things'}</span>}
    </label>)}
  </div>
}

export function Access({ ws }: { ws: string }) {
  const [got, setGot] = React.useState<AccessView | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [tool, setTool] = React.useState('')
  const [edit, setEdit] = React.useState<{ name: string; text: string; was?: string } | null>(null)
  const [only, setOnly] = React.useState(false)
  const [checked, setChecked] = React.useState<Checked | undefined>(undefined)
  const [picked, setPicked] = React.useState<string[]>([])
  const gen = React.useRef(0)
  React.useEffect(() => {
    const my = ++gen.current
    setGot(null); setBusy(false); setEdit(null); setOnly(false); setChecked(undefined); setPicked([])
    api.grants(ws).then((r) => { if (gen.current === my) setGot(r) }, (e) => { if (gen.current === my) toast((e as Error).message) })
    return () => { gen.current++ }
  }, [ws])
  const head = <header><Ic n="sliders" /><h3>Access</h3></header>
  if (!got) return <section className="panel">{head}<div className="pb"><p className="why">Loading…</p></div></section>
  const g = got.grants
  if (!got.managed || !g) return <section className="panel">{head}<div className="pb"><p className="why" style={{ margin: 0 }}>This workspace has no grants.json: what its runs reach comes from its config.</p></div></section>

  const change = async (ch: AccessChange): Promise<boolean> => {
    const my = gen.current
    setBusy(true)
    try {
      const r = await api.putGrants(ws, ch)
      if (gen.current !== my) return true
      setGot(r)
      if (!r.restart) return true
      toast('Saved; the console restarts to apply it')
      // the old process may still answer until the restart: show the PUT result, and trust a GET only after one failed
      let down = false
      for (let i = 0; i < 60; i++) {
        await sleep(2000)
        if (gen.current !== my) return true
        try { const x = await api.grants(ws); if (down) { if (gen.current === my) setGot(x); break } } catch { down = true }
      }
      return true
    } catch (e) { if (gen.current === my) toast((e as Error).message); return false } finally { if (gen.current === my) setBusy(false) }
  }
  const tools = [...KNOWN_RUN_TOOLS, ...g.runTools.filter((t) => !KNOWN_RUN_TOOLS.includes(t))]
  const own = (n: string) => got.packMcp.includes(n)
  const saveMcp = async () => {
    if (!edit) return
    const name = edit.name.trim(), cfg = parseCfg(edit.text)
    if (!name) { toast('Name the server'); return }
    if (typeof cfg === 'string') { toast(`Not JSON: ${cfg}`); return }
    if (name !== edit.was && Object.hasOwn(g.mcp, name)) { toast(`There is a server ${name} already`); return }
    const next = Object.fromEntries(Object.entries(g.mcp).filter(([k]) => k !== edit.was))
    next[name] = cfg
    // after a Check the ticked tools go in the same commit, the old name's and the new one's replaced
    const own = (t: string) => t.startsWith(`mcp__${name}__`) || (edit.was ? t.startsWith(`mcp__${edit.was}__`) : false)
    const rt = checked && checked !== 'checking' && checked.ok ? { runTools: [...g.runTools.filter((t) => !own(t)), ...picked.map((t) => `mcp__${name}__${t}`)] } : {}
    if (await change({ mcp: next, ...rt })) { setEdit(null); setChecked(undefined); setPicked([]) }
  }
  const checkEdit = async () => {
    if (!edit) return
    const cfg = parseCfg(edit.text)
    if (typeof cfg === 'string') { toast(`Not JSON: ${cfg}`); return }
    const my = gen.current, name = edit.name.trim()
    setChecked('checking')
    let v: Checked
    try { v = await api.mcpCheck(ws, { config: cfg }) } catch (e) { v = { ok: false, error: (e as Error).message } }
    if (gen.current !== my) return
    setChecked(v)
    // what the grants already let runs call stays ticked; a new server's read-only tools come ticked
    const had = g.runTools.filter((t) => t.startsWith(`mcp__${name}__`)).map((t) => t.slice(`mcp__${name}__`.length))
    if (v.ok) setPicked(had.length ? had : v.tools.filter((t) => t.readOnly).map((t) => t.name))
  }
  // "only these" waits for its first site before it is written: an allowlist names at least one
  const mode = only ? 'only' : !g.browser ? 'off' : g.browser.allow ? 'only' : 'any'
  const sub = (t: string) => <span className="hint">{t}</span>

  return <section className="panel">{head}
    <div className="pb" style={{ display: 'grid', gap: 16 }}>
      <p className="why" style={{ margin: 0 }}>What the runs reach besides the packs. Each change is one grants.json commit and a console restart.</p>

      <div style={{ display: 'grid', gap: 4 }}>{sub('Hosts the runs may call (exact, or *.domain)')}
        <Names label="Add a host" items={g.hosts} ph="api.example.org or *.example.org" dis={busy} onChange={(hosts) => change({ hosts })} /></div>

      <div style={{ display: 'grid', gap: 4 }}>{sub('Tools of the LLM app a run may use')}
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          {tools.map((t) => <label key={t} className="row" style={{ gap: 4 }}><input type="checkbox" checked={g.runTools.includes(t)} disabled={busy}
            onChange={(e) => void change({ runTools: e.target.checked ? [...g.runTools, t] : g.runTools.filter((x) => x !== t) })} /><span className="mono">{t}</span></label>)}
        </div>
        <div className="row" style={{ gap: 4 }}>
          <input className="inp mono" placeholder="another tool name" aria-label="Add a run tool" value={tool} disabled={busy} onChange={(e) => setTool(e.target.value)} />
          <button className="btn sm" disabled={busy || !tool.trim()} onClick={() => void change({ runTools: [...g.runTools, tool.trim()] }).then((ok) => { if (ok) setTool('') })}>Add</button>
        </div></div>

      <div style={{ display: 'grid', gap: 8 }}>{sub('MCP servers the runs get')}
        {Object.keys(g.mcp).length ? Object.entries(g.mcp).map(([n, c]) => <div key={n} className="dc" style={{ display: 'grid', gap: 4 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}><b className="mono">{n}</b>
            {own(n) ? <span className="hint">from the pack {n}: change it in Packs</span>
              : <span className="row" style={{ gap: 4 }}>
                <button className="btn sm ghost" disabled={busy} onClick={() => setEdit({ name: n, text: json(c), was: n })}><Ic n="pen" sm />Edit</button>
                <button className="btn sm ghost" disabled={busy} onClick={() => void change({ mcp: Object.fromEntries(Object.entries(g.mcp).filter(([k]) => k !== n)) })}><Ic n="x" sm />Remove</button></span>}
          </div>
          {edit?.was === n ? null : <pre className="out mono" style={{ margin: 0 }}>{json(c)}</pre>}
        </div>) : <p className="why" style={{ margin: 0 }}>None.</p>}
        {edit ? <div className="dc" style={{ display: 'grid', gap: 4 }}>
          <input className="inp mono" placeholder="name" aria-label="MCP server name" value={edit.name} disabled={busy} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
          <textarea className="inp mono" rows={6} aria-label="MCP server config" value={edit.text} disabled={busy} spellCheck={false} onChange={(e) => setEdit({ ...edit, text: e.target.value })} />
          <span className="hint">A secret goes in mcp.env in the console's home and here as {'${env:NAME}'}; a literal one is refused</span>
          <ToolTicks c={checked} picked={picked} dis={busy} onPick={setPicked} />
          <div className="row" style={{ gap: 4 }}><button className="btn sm pri" disabled={busy || checked === 'checking'} onClick={() => void saveMcp()}><Ic n="check" sm />{edit.was ? 'Save' : 'Add'}</button>
            <button className="btn sm ghost" disabled={busy || checked === 'checking'} onClick={() => void checkEdit()}><Ic n="refresh" sm />Check</button>
            <button className="btn sm ghost" disabled={busy} onClick={() => { setEdit(null); setChecked(undefined); setPicked([]) }}>Cancel</button></div>
        </div> : <div><button className="btn sm ghost" disabled={busy} onClick={() => setEdit({ name: '', text: json({ command: '', args: [] }) })}><Ic n="plus" sm />Add a server</button></div>}
      </div>

      <div style={{ display: 'grid', gap: 4 }}>{sub("The runs' browser")}
        <div className="row" style={{ gap: 12 }}>
          <label className="row" style={{ gap: 4 }}><input type="radio" name="run-browser" checked={mode === 'off'} disabled={busy} onChange={() => { setOnly(false); if (g.browser) void change({ browser: null }) }} />off</label>
          <label className="row" style={{ gap: 4 }}><input type="radio" name="run-browser" checked={mode === 'any'} disabled={busy} onChange={() => { setOnly(false); void change({ browser: { allow: null } }) }} />any site</label>
          <label className="row" style={{ gap: 4 }}><input type="radio" name="run-browser" checked={mode === 'only'} disabled={busy} onChange={() => setOnly(true)} />only these sites</label>
        </div>
        {mode === 'only' ? <Names label="Add a site" items={g.browser?.allow ?? []} ph="portal.example.org" dis={busy} min={1}
          onChange={(allow) => change({ browser: { allow } })} /> : null}
      </div>
    </div></section>
}
