import * as React from 'react'
import * as api from '../live/api.ts'
import { LIVE } from '../live/api.ts'
import type { ProviderId, ProviderInfo, ProviderSettings } from '../live/api.ts'
import { commit } from '../store.ts'
import { Ic } from '../ui/Icon.tsx'
import { toast } from '../ui/toasts.tsx'

/* Which LLM app the console uses, set on the PC: auto runs by itself (runs, Ask by itself, replies,
   the New job builder), manual is what a step's Open button opens. The paths name the apps' own
   binaries when they are not found by themselves. One file for the console, applied from the next run. */

const box = (t: React.ReactNode) => <div className="pb"><p className="why" style={{ margin: 0 }}>{t}</p></div>
const head = <div className="vh"><div><div className="eyebrow">Setup</div><h1>Settings</h1>
  <p>Which LLM app the console runs by itself, and which one a step opens in when you take it up by hand.</p></div></div>

export function Settings() {
  const [got, setGot] = React.useState<{ settings: ProviderSettings; providers: ProviderInfo[] } | null>(null)
  const [form, setForm] = React.useState<ProviderSettings | null>(null)
  const [busy, setBusy] = React.useState(false)
  React.useEffect(() => {
    if (LIVE.on && LIVE.pc) api.settings().then((r) => { setGot(r); setForm(r.settings) }, (e) => toast((e as Error).message))
  }, [])
  if (!LIVE.on || !LIVE.pc) return <>{head}{box(LIVE.on ? 'Settings are changed on the PC, at http://127.0.0.1.' : 'Settings belong to the console backend on your PC. This demo has no backend.')}</>
  if (!got || !form) return <>{head}{box('Loading…')}</>
  const set = (k: keyof ProviderSettings, v: string) => setForm({ ...form, [k]: v })
  const save = async () => {
    setBusy(true)
    try {
      const r = await api.putSettings({ auto: form.auto, manual: form.manual, claudePath: form.claudePath ?? '', cursorPath: form.cursorPath ?? '' })
      setGot(r); setForm(r.settings)
      const label = r.providers.find((p) => p.id === r.settings.manual)?.label ?? r.settings.manual
      commit(() => { LIVE.providers = { auto: r.settings.auto, manual: r.settings.manual, manualLabel: label } })
      toast('Saved; it applies from the next run')
    } catch (e) { toast((e as Error).message) } finally { setBusy(false) }
  }
  const pick = (k: 'auto' | 'manual', only?: (p: ProviderInfo) => boolean) => (
    <select className="sel" aria-label={k === 'auto' ? 'Runs by itself' : 'Opens by hand'} value={form[k]} onChange={(e) => set(k, e.target.value as ProviderId)}>
      {got.providers.map((p) => <option key={p.id} value={p.id} disabled={only && !only(p)}>{p.label}{only && !only(p) ? ' (not verified yet)' : ''}</option>)}
    </select>
  )
  const path = (k: 'claudePath' | 'cursorPath', label: string, ph: string) => (
    <label className="field"><span>{label}</span>
      <input className="inp mono" value={form[k] ?? ''} placeholder={ph} spellCheck={false} onChange={(e) => set(k, e.target.value)} /></label>
  )
  const changed = JSON.stringify(form) !== JSON.stringify(got.settings)
  return <>
    {head}
    <div className="cols">
      <section className="panel"><header><Ic n="bot" /><h3>LLM app</h3></header>
        <div className="pb" style={{ display: 'grid', gap: 12 }}>
          <label className="field"><span>Runs by itself</span>{pick('auto', (p) => p.auto)}</label>
          <p className="why" style={{ margin: 0 }}>Ask LLM, the steps that ask by themselves, replies to a draft and the New job builder.</p>
          <label className="field"><span>Opens by hand</span>{pick('manual')}</label>
          <p className="why" style={{ margin: 0 }}>A step's Open button. The same app resumes the step's session; another starts a new one. The session hands its draft in through the work-console MCP server.</p>
        </div></section>
      <section className="panel"><header><Ic n="terminal" /><h3>Paths</h3></header>
        <div className="pb" style={{ display: 'grid', gap: 12 }}>
          {path('claudePath', 'Claude Code binary', 'found by itself')}
          {path('cursorPath', 'Cursor agent binary', 'found by itself')}
          <p className="why" style={{ margin: 0 }}>Leave a path empty to use the one found by itself. A path must name an existing file.</p>
        </div></section>
    </div>
    <div className="row" style={{ marginTop: 12 }}>
      <button className="btn pri" disabled={busy || !changed} onClick={() => void save()}><Ic n="check" sm />Save</button>
      {changed ? <button className="btn ghost" disabled={busy} onClick={() => setForm(got.settings)}>Undo changes</button> : null}
    </div>
  </>
}
