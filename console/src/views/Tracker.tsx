import * as React from 'react'
import { PRS0, WORK0 } from '../data/demo.ts'
import * as api from '../live/api.ts'
import { LIVE } from '../live/api.ts'
import { md } from '../lib/md.ts'
import { ago } from '../lib/util.ts'
import { ctxOf } from '../model/context.ts'
import { buildTracker } from '../model/tracker.ts'
import type { Policy, PrRow, TrackerGet, TrackerView, Vote, WorkCard } from '../model/tracker.ts'
import type { Job } from '../model/types.ts'
import { failText } from '../actions/flow.tsx'
import { Ic } from '../ui/Icon.tsx'
import { pageOf } from '../workspace.ts'

/* The job's work items and the pull requests linked to them, above its board: read through the backend
   (cached there for five minutes, ↻ reads again), in the demo from demo data through the same builder.
   A workspace without a tracker, or a job without a work item, shows neither panel. */

const demoGet: TrackerGet = async (c, id) => {
  if (c === 'work') return WORK0[id] ? { status: 'ok', items: WORK0[id] } : { status: 'source_error', message: `no work item ${id} in the demo` }
  return PRS0[id] ? { status: 'ok', items: { threads: [], pr: PRS0[id] } } : { status: 'source_error', message: `no PR ${id} in the demo` }
}

const VOTE: Record<string, [icon: string, word: string, cls: string]> = {
  '10': ['check', 'approved', 'ok'], '5': ['check', 'approved with suggestions', 'ok'], '0': ['hourglass', 'no vote yet', ''],
  '-5': ['warn', 'waiting for the author', 'wait'], '-10': ['x', 'rejected', 'bad'],
}
const POLICY: Record<string, [string, string]> = {
  approved: ['check', 'ok'], rejected: ['x', 'bad'], broken: ['x', 'bad'], queued: ['hourglass', 'wait'], running: ['hourglass', 'wait'], notApplicable: ['skip', ''],
}
const PR_LAMP: Record<string, string> = { active: 'cur', completed: 'ok', abandoned: 'tpl' }
const first = (name: string) => name.includes(',') ? name.split(',')[1].trim().split(' ')[0] : name.split(' ')[0]
const day = (iso?: string | null) => (iso && /^\d{4}-\d\d-\d\d/.test(iso) ? iso.slice(0, 10) : '')

const Text = ({ h, t }: { h: string; t?: string }) => (t && t.trim()
  ? <details className="trk-d"><summary>{h}</summary><div className="md">{md(t)}</div></details> : null)

function Card({ c, keyOf }: { c: WorkCard; keyOf: (id: string) => string }) {
  const name = keyOf(c.id)
  if (c.err) return <li><div className="trk-h"><Ic n="file" sm /><b>{name}</b></div><p className="why trk-m"><Ic n="warn" sm /> Could not read it: {c.err}</p></li>
  const meta = [c.state, c.assignedTo ?? 'unassigned', c.iteration, c.area].filter(Boolean)
  return <li>
    <div className="trk-h"><Ic n="file" sm /><span className="cx-k">{c.type ? `${c.type} ` : ''}</span>
      {c.link ? <a href={c.link} target="_blank" rel="noreferrer"><b>{name}</b></a> : <b>{name}</b>}<span className="trk-t">{c.title}</span></div>
    <p className="why trk-m">{meta.join(' · ')}</p>
    <Text h="Description" t={c.description} /><Text h="Repro steps" t={c.reproSteps} /><Text h="Acceptance criteria" t={c.acceptanceCriteria} />
  </li>
}

const Votes = ({ vs }: { vs: Vote[] }) => <span className="trk-v">{vs.map((v, i) => {
  const [ic, word, cls] = VOTE[String(v.vote)] ?? VOTE['0']
  return <span key={i} className={cls} title={`${v.reviewer}: ${word}`}><Ic n={ic} sm />{first(v.reviewer)}</span>
})}</span>
const Policies = ({ ps }: { ps: Policy[] }) => <span className="trk-v">{ps.map((p, i) => {
  const [ic, cls] = POLICY[p.status] ?? ['help', '']
  return <span key={i} className={cls} title={`${p.name}: ${p.status}${p.blocking ? '' : ' (optional)'}`}><Ic n={ic} sm />{p.name}</span>
})}</span>

function Pr({ p, keyOf }: { p: PrRow; keyOf: (id: string) => string }) {
  const id = <b>{p.id}</b>
  if (p.err) return <li><div className="trk-h"><Ic n="pr" sm />{id}</div><p className="why trk-m"><Ic n="warn" sm /> Could not read it: {p.err}</p></li>
  const meta = [p.repo, p.source || p.target ? `${p.source ?? '?'} → ${p.target ?? '?'}` : '', p.draft ? 'draft' : '',
    p.status === 'active' && p.merge ? `merge ${p.merge}` : '', p.status !== 'active' && day(p.closedAt) ? `${p.status} ${day(p.closedAt)}` : '',
    `for ${p.items.map(keyOf).join(', ')}`].filter(Boolean)
  return <li>
    <div className="trk-h"><Ic n="pr" sm />{p.link ? <a href={p.link} target="_blank" rel="noreferrer">{id}</a> : id}
      <span className="trk-t">{p.title ?? ''}</span>{p.status ? <span className="trk-s"><span className={'lamp ' + (PR_LAMP[p.status] ?? '')} />{p.status}</span> : null}</div>
    <p className="why trk-m">{meta.join(' · ')}</p>
    {p.votes?.length || p.policies?.length ? <p className="trk-m">{p.votes?.length ? <Votes vs={p.votes} /> : null}{p.policies?.length ? <Policies ps={p.policies} /> : null}</p> : null}
  </li>
}

export function TrackerPanels({ j }: { j: Job }) {
  const ids = ctxOf(j).filter((c) => c.k === 'work').map((c) => c.id), want = ids.join('\n')
  const [st, set] = React.useState<{ t?: TrackerView; err?: string; busy?: boolean }>({})
  const seq = React.useRef(0)
  const load = React.useCallback((fresh: boolean) => {
    const n = ++seq.current
    set((s) => ({ ...s, busy: true, err: undefined }))
    const p = LIVE.on ? api.tracker(j.id, fresh) : buildTracker(ids, demoGet, new Date().toISOString())
    p.then((t) => { if (n === seq.current) set({ t }) }, (e: Error) => { if (n === seq.current) set((s) => ({ t: s.t, err: failText(e) })) })
  }, [j.id, want])
  React.useEffect(() => { set({}); if (ids.length) load(false) }, [load])
  if (!ids.length || (st.t && !st.t.supported)) return null
  const board = pageOf(j.ws)?.board, keyOf = (id: string) => board?.key(id) ?? id
  const t = st.t, at = t ? Date.parse(t.at) : 0
  const status = st.busy ? 'reading…' : t?.offline ? `bridge offline · ${t.items.some((c) => !c.err) ? `from ${ago(at)}` : 'nothing read yet'}` : t ? `updated ${ago(at)}` : ''
  return <div className="trk">
    <section className="panel"><header><Ic n="file" /><h3>Work items</h3>
      <span className="src" title={t?.offline}>{status}</span>
      <button className="iconbtn" aria-label="Read again" title="Read again" disabled={st.busy} onClick={() => load(true)}><Ic n="refresh" sm /></button></header>
      <div className="pb">
        {st.err ? <p className="why" style={{ margin: 0 }}><Ic n="warn" sm /> Could not read them: {st.err}</p> : null}
        {t ? <ul className="trk-l">{t.items.map((c) => <Card key={c.id} c={c} keyOf={keyOf} />)}</ul> : st.err ? null : <p className="why" style={{ margin: 0 }}>Reading…</p>}
      </div></section>
    <section className="panel"><header><Ic n="pr" /><h3>Pull requests</h3>
      <span className="src">{t ? `${t.prs.filter((p) => p.status === 'active').length} active of ${t.prs.length}` : ''}</span></header>
      <div className="pb">
        {t ? t.prs.length ? <ul className="trk-l">{t.prs.map((p) => <Pr key={p.id} p={p} keyOf={keyOf} />)}</ul>
          : <p className="why" style={{ margin: 0 }}>No pull request is linked to these work items.</p> : <p className="why" style={{ margin: 0 }}>{st.err ? '' : 'Reading…'}</p>}
      </div></section>
  </div>
}
