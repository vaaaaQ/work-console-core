import * as React from 'react'
import { snip, tfmt } from '../lib/util.ts'
import * as api from '../live/api.ts'
import { LIVE } from '../live/api.ts'
import type { Hit, Note, NoteIndex } from '../live/api.ts'
import { L } from '../live/boot.ts'
import { editNote } from '../actions/knowledge.tsx'
import { S, W } from '../model/world.ts'
import { Ic } from '../ui/Icon.tsx'
import { toast } from '../ui/toasts.tsx'

/* Notes an LLM reads on the workplace: the domain, and the machine itself. The user reads and edits
   them here; an LLM only proposes, and its proposals wait in Approvals. */

const box = (t: React.ReactNode) => <div className="pb"><p className="why" style={{ margin: 0 }}>{t}</p></div>

export function Knowledge() {
  const [q, setQ] = React.useState('')
  const [hits, setHits] = React.useState<Hit[] | null>(null)
  const [sel, setSel] = React.useState<Note | null>(null)
  // notes are the workspace's on screen: a switch drops what the other one showed
  const ws = S.ws
  React.useEffect(() => { setSel(null); setHits(null) }, [ws])
  // a reply for a workspace no longer on screen is dropped
  const mine = <T,>(f: (x: T) => void) => (x: T) => { if (S.ws === ws) f(x) }
  React.useEffect(() => {
    if (!LIVE.on || !q.trim()) { setHits(null); return }
    const t = setTimeout(() => { api.searchNotes(ws, q.trim()).then(mine(setHits), mine((e: unknown) => toast((e as Error).message))) }, 250)
    return () => clearTimeout(t)
  }, [q, ws])
  const head = (acts?: React.ReactNode) => (
    <div className="vh"><div><div className="eyebrow">{W().n} · workplace</div><h1>Knowledge</h1>
      <p>Notes an LLM reads on the workplace: the domain, and the machine itself. An LLM only proposes; proposals wait in Approvals.</p></div>{acts}</div>
  )
  if (!LIVE.on) return <>{head()}{box('Knowledge lives in the bridge on the workplace. This demo has no backend.')}</>
  const open = (id: string) => api.note(ws, id).then(mine(setSel), mine((e: unknown) => toast((e as Error).message)))
  const l = L(ws), list: (NoteIndex | Hit)[] = hits ?? l.notes
  return <>
    {head(<div className="acts"><button className="btn pri" onClick={() => editNote(null, setSel)}><Ic n="plus" sm />New note</button></div>)}
    <div className="fbar"><span className="fsp" />
      <label className="search"><Ic n="search" sm /><input type="search" placeholder="Search notes" aria-label="Search notes" value={q} onChange={(e) => setQ(e.target.value)} /></label></div>
    <div className="cols">
      <section className="panel"><header><Ic n="list" /><h3>{hits ? 'Found' : 'Notes'}</h3><span className="src">{list.length}</span></header>
        {!hits && l.kn !== 'ok' ? box(l.kn === 'loading' ? 'Loading…' : l.kn)
          : list.length ? <ul className="al">{list.map((n) => (
            <li key={n.id}><Ic n="file" sm /><button className="lnk" onClick={() => void open(n.id)}>{n.title}</button>
              <span className="why">{'snippet' in n ? snip(n.snippet, 120) : n.tags.join(', ')}</span></li>))}</ul>
            : box(hits ? 'No note matches.' : 'No notes yet. Add one, or accept a proposal in Approvals.')}</section>
      <section className="panel"><header><Ic n="file" /><h3>{sel ? sel.title : 'Note'}</h3>
        {sel ? <button className="btn sm ghost" onClick={() => editNote(sel, setSel)}><Ic n="pen" sm />Edit…</button> : null}</header>
        {sel ? <div className="pb" style={{ display: 'grid', gap: 8 }}>
          <div className="why">{sel.tags.join(', ') || 'no tags'} · v{sel.v} · {tfmt(sel.updated)}</div><pre className="out">{sel.text}</pre></div>
          : box('Pick a note to read it.')}</section>
    </div>
  </>
}
