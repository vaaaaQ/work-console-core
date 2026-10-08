import * as React from 'react'
import { md } from '../lib/md.ts'
import { tfmt } from '../lib/util.ts'
import { LIVE } from '../live/api.ts'
import { L } from '../live/boot.ts'
import type { AgentCommit, AgentTurn } from '../model/agent.ts'
import { S, W } from '../model/world.ts'
import { go } from '../actions/nav.tsx'
import { agentFresh, agentSend, agentStop, agentUndo } from '../actions/agent.tsx'
import { Ic } from '../ui/Icon.tsx'
import { VoiceField } from '../ui/VoiceField.tsx'

/* A managed workspace's agent: one conversation that shapes the workspace, and the commits it made, each with Undo. */

const box = (t: React.ReactNode) => <div className="pb"><p className="why" style={{ margin: 0 }}>{t}</p></div>
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

export function AgentView() {
  const ws = S.ws
  const [t, setT] = React.useState('')
  const [sending, setSending] = React.useState(false)
  React.useEffect(() => { setT('') }, [ws])
  const head = (acts?: React.ReactNode) => (
    <div className="vh"><div><div className="eyebrow">{W().n} · setup</div><h1>Agent</h1>
      <p>Shape this workspace by talking to its agent: the board, playbooks, plugins and tools. It changes only this workspace's folder and the tools folder; each change it applies is a commit you can undo. What the workspace may reach waits in Approvals.</p></div>{acts}</div>
  )
  if (!LIVE.on) return <>{head()}{box('The workspace agent runs on the PC. This demo has no backend.')}</>
  const l = L(ws)
  if (!l.managed) return <>{head()}{box('This workspace has no agent: it has no grants.json. A workspace an agent creates has one from the start.')}</>
  const a = l.agent, running = a?.status === 'running'
  const send = async () => {
    setSending(true)
    if (await agentSend(ws, t.trim())) setT('')
    setSending(false)
  }
  const commits = a?.commits ?? []
  return <>
    {head(<div className="acts"><button className="btn" disabled={running || !a?.turns.length} onClick={() => agentFresh(ws)}><Ic n="plus" sm />New conversation</button></div>)}
    {a?.pending ? <div className="dc ag-wait"><div className="dc-h"><span className="st"><Ic n="sliders" sm /><b>A grants change waits for you</b></span><span className="hint">{tfmt(a.pending.at)}</span></div>
      <div className="why">{a.pending.reason}</div>
      <div className="row"><button className="btn sm pri" onClick={() => go('approvals')}><Ic n="check" sm />Open Approvals</button></div></div> : null}
    <div className="cols ag">
      <section className="panel"><header><Ic n="bot" /><h3>Conversation</h3>{a?.interview ? <span className="tag">first conversation</span> : null}<span className="src">{a?.provider ?? ''}</span></header>
        <div className="pb ag-talk">
          {a?.turns.length ? a.turns.map((x, i) => <Turn key={i} t={x} />)
            : <p className="why" style={{ margin: 0 }}>{a?.interview
              ? 'This workspace is new. Say hello: the agent asks which tools you work in, what a work item is for you and which jobs repeat, then proposes what the workspace may reach and sets up its board and playbooks.'
              : a ? 'Say what to change in this workspace.'
                : 'Say hello to start. In a new workspace the agent first asks which tools you work in, what a work item is for you and which jobs repeat.'}</p>}
          {running ? <div className="why ag-run"><span className="spin" />The agent is answering…</div> : null}
          {a?.status === 'failed' ? <div className="errs">The last turn failed: {a.error || 'no reason given'}</div> : null}
          <VoiceField value={t} onChange={setT} target="llm" rows={3} placeholder={running ? 'The agent is answering; your next message waits for it' : 'What to change, or a question'} />
          <div className="row"><button className="btn sm pri" disabled={!t.trim() || sending || running} onClick={() => void send()}><Ic n="send" sm />Send</button>
            {running ? <button className="btn sm" onClick={() => void agentStop(ws)}><Ic n="stop" sm />Stop</button> : null}</div>
        </div></section>
      <section className="panel"><header><Ic n="layers" /><h3>Changes</h3><span className="src">{commits.length}</span></header>
        {commits.length ? <div className="pb"><ul className="al">{[...commits].reverse().map((c) => <Change key={c.sha} ws={ws} c={c} busy={running} />)}</ul></div>
          : box('No changes yet. Each change the agent applies shows here, with Undo.')}</section>
    </div>
  </>
}
