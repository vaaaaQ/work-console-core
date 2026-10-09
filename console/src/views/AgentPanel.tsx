import * as React from 'react'
import { md } from '../lib/md.ts'
import { tfmt } from '../lib/util.ts'
import * as api from '../live/api.ts'
import { LIVE } from '../live/api.ts'
import type { Where } from '../live/api.ts'
import { L, showAgent } from '../live/boot.ts'
import type { AgentCommit, AgentRec, AgentTurn } from '../model/agent.ts'
import { JOBS, S, W, byId } from '../model/world.ts'
import { commit } from '../store.ts'
import { go } from '../actions/nav.tsx'
import { agentFresh, agentRetry, agentSend, agentStop, agentUndo, closeAgent, openAgent } from '../actions/agent.tsx'
import { Ic } from '../ui/Icon.tsx'
import { VoiceField } from '../ui/VoiceField.tsx'
import { ProposalCard } from './Proposal.tsx'

/* The workspace agent beside every page: on a job page that job's conversation, elsewhere the one picked or the newest
   general one. A proposal it made waits under its turns; a managed workspace's general conversation also lists the
   commits it made, each with Undo. */

const short = (sha: string) => sha.slice(0, 8)
const KIND: Record<AgentCommit['kind'], [string, string]> = { apply: ['Applied', 'check'], undo: ['Undo', 'retry'], grants: ['Grants', 'sliders'], create: ['New workspace', 'plus'], reintegrate: ['Core update fix', 'refresh'] }

function Turn({ t }: { t: AgentTurn }) {
  if (t.who === 'tool') return <div className="ag-tool mono"><Ic n="wrench" sm />{t.t}</div>
  if (t.who === 'note') return <div className="ag-note"><Ic n="alert" sm />{t.t}</div>
  return (
    <div className="turn">
      <div className="turn-q"><b>{t.who === 'you' ? 'You' : 'Agent'}</b><span className="hint">{tfmt(t.at)}</span></div>
      {t.who === 'agent' ? <div className="md">{md(t.t)}</div> : <div className="turn-q">{t.t}</div>}
    </div>
  )
}

function Change({ ws, c, busy }: { ws: string; c: AgentCommit; busy: boolean }) {
  const [l, i] = KIND[c.kind]
  return (
    <li className={c.undoneBy ? 'gh' : undefined}><Ic n={i} sm /><span title={l}>{c.summary}</span>
      <span className="why" title={c.files.join('\n')}>{c.files.join(', ')}</span>
      <span className="mono hint" title={tfmt(c.at)}>{short(c.sha)}</span>
      {c.undoneBy ? <span className="tag">undone by {short(c.undoneBy)}</span>
        : c.kind === 'apply' || c.kind === 'create'
          ? <button className="btn sm ghost" disabled={busy} title={busy ? 'Wait for the agent to finish its turn' : undefined} onClick={() => agentUndo(ws, c)}><Ic n="retry" sm />Undo…</button>
          : <span />}
    </li>
  )
}

/** the conversation the panel shows, as the backend names it */
function whereNow(): Where {
  if (S.agentConv) return { conv: S.agentConv }
  if (S.view === 'job' && S.job && byId(S.job)?.ws === S.ws) return { job: S.job }
  return {}
}
function recOf(ws: string, w: Where): AgentRec | null {
  const l = L(ws)
  if (w.conv) return l.agents[w.conv] ?? null
  if (w.job) return Object.values(l.agents).filter((a) => a.job === w.job).sort((a, b) => b.created.localeCompare(a.created))[0] ?? null
  return l.agent
}
/* a conversation the tab has not loaded is fetched once per workspace and target; one that does not exist yet comes as
   an event when it starts */
const asked = new Set<string>()
function fetchOnce(ws: string, w: Where, key: string) {
  if (asked.has(key)) return
  asked.add(key)
  void api.agentGet(ws, w).then((a) => { if (a) showAgent(ws, a) }, () => { asked.delete(key) })
}

export function AgentPanel() {
  const ws = S.ws, open = LIVE.on && S.agentOpen
  const w = whereNow(), key = `${ws}|${w.conv ?? ''}|${w.job ?? ''}`
  const a = open ? recOf(ws, w) : null
  const [t, setT] = React.useState('')
  const [sending, setSending] = React.useState(false)
  React.useEffect(() => { if (open && !a && (w.conv || w.job)) fetchOnce(ws, w, key) }, [open, key, !a])
  if (!open) return null
  const l = L(ws), running = a?.status === 'running'
  const job = byId(a?.job ?? w.job), general = !job
  const mine = a ? JOBS.filter((j) => j.ws === ws && j.pp?.by === a.id) : []
  const send = async () => {
    setSending(true)
    if (await agentSend(ws, t.trim(), a ? { conv: a.id } : w)) setT('')
    setSending(false)
  }
  const pick = (id: string) => commit(() => { S.agentConv = id || null })
  const empty = job
    ? `Ask about ${job.id}, or say what a meeting decided: the agent proposes changes to this job's steps, and you accept them on its board.`
    : a?.interview
      ? 'This workspace is new. Say hello: the agent asks which tools you work in, what a work item is for you and which jobs repeat, then proposes what the workspace may reach and sets up its board and playbooks.'
      : l.managed ? "Ask about this workspace's jobs, or say what to change in it: the board, playbooks, plugins and tools."
        : "Ask about this workspace's jobs, or have the agent link one job to another."
  return (
    <aside className="agp" id="agp" aria-label="Agent">
      <header className="agp-h">
        <Ic n="bot" />
        <div className="agp-t"><b>Agent · {W().n}</b>
          {job ? (S.view === 'job' && S.job === job.id ? <span className="hint">About {job.id} · {job.t}</span>
            : <button className="lnk mono" onClick={() => go('job', job.id)}>{job.id} · {job.t}</button>)
            : <span className="hint">{a?.reintegrate ? `Core update ${a.reintegrate.core.slice(0, 7)}` : 'General'}</span>}</div>
        <button className="iconbtn" aria-label="New conversation" title="New conversation" onClick={() => void agentFresh(ws)}><Ic n="plus" /></button>
        <button className="iconbtn" aria-label="Close the agent" title="Close (Esc)" onClick={closeAgent}><Ic n="x" /></button>
      </header>
      <div className="agp-pick">
        <select aria-label="Conversation" value={a?.id ?? ''} onChange={(e) => pick(e.target.value)}>
          {a ? null : <option value="">{job ? `${job.id} · no conversation yet` : 'New conversation'}</option>}
          {l.convs.map((c) => <option key={c.id} value={c.id}>{c.job ? `${c.job} · ` : ''}{c.title}{c.status === 'running' ? ' · answering' : c.status === 'failed' ? ' · failed' : ''}</option>)}
        </select>
      </div>
      <div className="agp-b">
        {general && l.managed && a?.pending ? <div className="dc ag-wait"><div className="dc-h"><span className="st"><Ic n="sliders" sm /><b>A grants change waits for you</b></span><span className="hint">{tfmt(a.pending.at)}</span></div>
          <div className="why">{a.pending.reason}</div>
          <div className="row"><button className="btn sm pri" onClick={() => go('approvals')}><Ic n="check" sm />Open Approvals</button></div></div> : null}
        {a?.turns.length ? a.turns.map((x, i) => <Turn key={i} t={x} />) : <p className="why" style={{ margin: 0 }}>{empty}</p>}
        {mine.map((j) => <ProposalCard key={j.id} j={j} where="panel" />)}
        {running ? <div className="why ag-run"><span className="spin" />The agent is answering…</div> : null}
        {a?.status === 'failed' ? <div className="errs">The last turn failed: {a.error || 'no reason given'}
          <div className="row"><button className="btn sm" onClick={() => void agentRetry(ws, a.id)}><Ic n="retry" sm />Retry</button></div></div> : null}
        {general && l.managed && a?.commits.length ? <section className="sec"><h3>Changes</h3>
          <ul className="al">{[...a.commits].reverse().map((c) => <Change key={c.sha} ws={ws} c={c} busy={running} />)}</ul></section> : null}
      </div>
      <div className="agp-f">
        <VoiceField value={t} onChange={setT} target="llm" rows={3} placeholder={running ? 'The agent is answering; your next message waits for it' : job ? `About ${job.id}: a question, or what was decided` : 'A question, or what to change'} />
        <div className="row"><button className="btn sm pri" disabled={!t.trim() || sending || running} onClick={() => void send()}><Ic n="send" sm />Send</button>
          {running && a ? <button className="btn sm" onClick={() => void agentStop(ws, a.id)}><Ic n="stop" sm />Stop</button> : null}</div>
      </div>
    </aside>
  )
}

/** the bottom-right button that opens the panel; a dot while any conversation of the workspace is answering */
export function AgentButton() {
  if (!LIVE.on || S.agentOpen) return null
  const busy = L().convs.some((c) => c.status === 'running')
  return <button className="agb" aria-label={busy ? 'Open the agent (answering)' : 'Open the agent'} title="Agent" onClick={() => openAgent()}>
    <Ic n="bot" />{busy ? <i className="agb-dot" /> : null}</button>
}
