import * as React from 'react'
import { BOARD0, DEFAULT_PB, boardKey, started } from '../data/board.ts'
import { DEFAULT_WS, PACKS } from '../data/packs.ts'
import type { BoardItem, Lane } from '../data/board.ts'
import { ago } from '../lib/util.ts'
import { JOBS, W, applyLocal, createJob, isClosed, putJob } from '../model/world.ts'
import type { Job } from '../model/types.ts'
import { commit, repaint } from '../store.ts'
import * as api from '../live/api.ts'
import { LIVE } from '../live/api.ts'
import { srcState } from '../live/boot.ts'
import { go } from '../actions/nav.tsx'
import { failText } from '../actions/flow.tsx'
import { Pill } from '../ui/bits.tsx'
import { Ic } from '../ui/Icon.tsx'
import { toast } from '../ui/toasts.tsx'
import { Unavailable } from './Chats.tsx'

/* The team board in three lists: free to take, on you, handed to QA. Start takes a free item in
   the tracker and starts its job; without a backend the demo does both in memory. */

const LANES: [Lane, string, string][] = [
  ['free', 'Available', 'Ready and unassigned on the team board.'],
  ['mine', 'On me', 'Assigned to you and not closed.'],
  ['qa', 'Handed to QA', 'Was yours and went through QA in the last 3 months; the column is where it is now.'],
]
const DEMO = BOARD0()
const busy = new Set<string>()

/** the item's job: the open one for its key, else the latest */
const jobOf = (id: string): Job | undefined => JOBS.filter((j) => j.key === boardKey(id))
  .sort((a, b) => Number(isClosed(a)) - Number(isClosed(b)) || b.ts - a.ts)[0]

async function start(it: BoardItem) {
  if (!LIVE.on) {
    const j = commit(() => {
      let j = jobOf(it.id)
      if (!j || isClosed(j)) { j = createJob({ t: it.title, key: boardKey(it.id), pb: DEFAULT_PB, prj: PACKS[DEFAULT_WS].prj[0], ws: DEFAULT_WS }); j = applyLocal(j.id, { op: 'start' }).job }
      Object.assign(it, started(it))
      return j
    })
    toast(`${boardKey(it.id)} is on you, in Dev · ${j.id} started`, 'Open', () => go('job', j.id))
    return
  }
  busy.add(it.id); repaint()
  try {
    const r = await api.startItem(it.id)
    commit(() => { putJob(r.job) })
    toast(`${boardKey(it.id)} is on you, in Dev · ${r.job.id} ${r.created ? 'started' : 'already open'}`, 'Open', () => go('job', r.job.id))
  } catch (e) { toast(failText(e)) } finally { busy.delete(it.id); repaint() }
}

function Card({ it }: { it: BoardItem }) {
  const j = jobOf(it.id)
  return (
    <div className="bc">
      <div className="r1"><a className="lnk key" href={it.link} target="_blank" rel="noreferrer">{boardKey(it.id)}</a><span className="tag">{it.type}</span>
        <span className="ts">{ago(Date.parse(it.changedAt))}</span></div>
      <div className="t">{it.title}</div>
      <div className="sub">{it.column || 'no column'} · {it.state}{it.lane === 'qa' && it.assignedTo ? ` · ${it.assignedTo}` : ''}</div>
      <div className="row">
        {j ? <button className="btn sm" onClick={() => go('job', j.id)} title={j.t}>{j.id}<Pill st={j.st} /></button> : <span className="sub">no job</span>}
        {it.lane === 'free' ? <button className="btn sm pri" disabled={busy.has(it.id)} onClick={() => void start(it)}>
          <Ic n="play" sm />{busy.has(it.id) ? 'Starting…' : 'Start'}</button> : null}
      </div>
    </div>
  )
}

export function BoardView() {
  const w = W(), st = srcState('board')
  if (st && st !== 'ok') return <Unavailable what="Board" st={st} />
  const items = LIVE.on ? LIVE.board : DEMO
  return <>
    <div className="vh"><div><div className="eyebrow">{w.n} · sources</div><h1>Board</h1>
      <p>{w.src.work?.n} items: what you can take, what is on you, and what you handed to QA. Start assigns the item to you, moves it to Dev and starts its job.</p></div></div>
    <div className="bd">{LANES.map(([lane, name, about]) => {
      const L = items.filter((i) => i.lane === lane).sort((a, b) => Date.parse(b.changedAt) - Date.parse(a.changedAt))
      return (
        <section key={lane} className="panel">
          <header><h2>{name}</h2><span className="src">{L.length}</span></header>
          <p className="bd-about">{about}</p>
          {L.length ? L.map((it) => <Card key={it.id} it={it} />) : <div className="empty">Nothing here.</div>}
        </section>
      )
    })}</div>
  </>
}
