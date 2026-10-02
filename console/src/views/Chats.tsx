import * as React from 'react'
import { CHATS, JOBS, S, W } from '../model/world.ts'
import type { Chat, Msg } from '../model/types.ts'
import { LIVE } from '../live/api.ts'
import { loadThread, srcState } from '../live/boot.ts'
import { repaint } from '../store.ts'
import { go } from '../actions/nav.tsx'
import { HID, chatSubmit, curChat, hiddenOf, hideChat, loadHidden, msgDraft, msgJob, pickChat, summarize, toggleHidden, unhideChat } from '../actions/sources.tsx'
import { Ic } from '../ui/Icon.tsx'

/** the LLM summary of a thread or a mail, made only on request */
export function SumBox({ id, text }: { id: string; text: string }) {
  if (LIVE.on) return null
  const s = S.sum[id]
  if (s === 'ok') return <div className="sum"><Ic n="bot" /><div><b>LLM summary</b> · {text}</div></div>
  if (s === 'run') return <div className="sum"><span className="spin" /><div>Summarizing…</div></div>
  return (
    <div className="sum"><Ic n="bot" /><div className="row" style={{ flex: 1 }}><span className="why">No summary yet. The LLM runs only when you ask.</span><span className="fsp" />
      <button className="btn sm" onClick={() => summarize(id)}>Summarize</button></div></div>
  )
}

const last = (x: Chat) => x.msgs[x.msgs.length - 1] as Msg | undefined

/** a source the bridge cannot serve right now says so instead of looking empty */
export function Unavailable({ what, st }: { what: string; st: string }) {
  return <div className="empty">{st === 'loading' ? `Loading ${what}…` : `${what} unavailable: ${st}.`}</div>
}

export function Chats() {
  const w = W(), ws = S.ws, L = CHATS[ws] || [], c = curChat(), st = srcState('chat'), hid = hiddenOf(ws)
  React.useEffect(() => { if (c) loadThread(c.id) }, [c?.id, st])
  // a hide or unhide anywhere changes the list, so the count follows it
  React.useEffect(() => { void loadHidden(ws) }, [ws, st, L.length])
  if (st && st !== 'ok') return <Unavailable what="Chats" st={st} />
  if (!c && !hid.length) return <div className="empty">{LIVE.on ? 'No chats.' : `No chat source in ${w.n}.`}</div>
  const jobs = c ? JOBS.filter((j) => j.chat === c.id) : [], tool = w.src.chat?.n
  return <>
    <div className="vh"><div><div className="eyebrow">{w.n} · sources</div><h1>Chats</h1>
      <p>{tool} threads you follow. Start a job from a message, or let the LLM draft a reply; nothing is posted until you confirm it.</p></div></div>
    <div className="split">
      <div className="list">
        <div className="list-tg"><button className="fb" aria-pressed={HID.open} onClick={toggleHidden}><Ic n="archive" sm />Hidden<span className="n">{hid.length}</span></button></div>
        {HID.open ? (hid.length ? hid.map((h) => (
          <div key={h.id} className="li"><span className="r1"><span className="nm">{h.name}</span><span className="fsp" /><button className="btn sm ghost" onClick={() => unhideChat(h.id, ws)}><Ic n="inbox" sm />Unhide</button></span></div>))
          : <div className="empty">No hidden threads.</div>)
          : L.map((x) => {
            const l = last(x)
            return (
              <button key={x.id} className="li" aria-current={x.id === c?.id} onClick={() => pickChat(x.id)}>
                <span className="r1"><span className="nm">{x.name}</span>{x.unread ? <span className="unr">{x.unread}</span> : null}<span className="ts">{l?.at || ''}</span></span>
                <span className="sub">{x.hidden && x.mentioned ? <span className="tag">hidden · mentioned you</span> : null}{x.kind} · {l?.me ? 'You: ' : ''}{l?.t || ''}</span>
              </button>
            )
          })}</div>
      {c ? <div className="pane">
        <div className="mail-h"><div className="row"><h2>{c.name}</h2><span className="src">{tool} · {c.kind}</span><span className="fsp" />
          {c.hidden ? <button className="btn sm ghost" onClick={() => unhideChat(c.id, ws)}><Ic n="inbox" sm />Unhide</button>
            : <button className="btn sm ghost" title="Hide this thread here; the chat tool is not changed" onClick={() => hideChat(c.id)}><Ic n="archive" sm />Hide</button>}</div>
          {jobs.length ? <div className="row">{jobs.map((j) => <button key={j.id} className="btn sm ghost" onClick={() => go('job', j.id)}><Ic n="list" sm />{j.id} · {j.key}</button>)}</div> : null}</div>
        <SumBox id={c.id} text={c.sum} />
        <div className="msgs-l">{c.msgs.map((m, i) => (
          <div key={i} className={'msg' + (m.me ? ' me' : '')}><div className="who"><b>{m.who}</b> · {m.at}</div><div className="tx">{m.t}</div>
            {m.me ? null : <div className="ma"><button className="btn sm ghost" onClick={() => msgJob(i)}><Ic n="plus" sm />Create job</button>
              {m.bot ? null : <button className="btn sm ghost" onClick={() => msgDraft(i)}><Ic n="bot" sm />Draft a reply</button>}</div>}
          </div>))}</div>
        <form className="composer" data-form="chat" noValidate onSubmit={(e) => { e.preventDefault(); chatSubmit(new FormData(e.currentTarget)) }}>
          <textarea className="ta" id="cmp" name="t" rows={3} placeholder={`Reply in ${c.name}. You see it again before it goes out.`} aria-label={`Reply in ${c.name}`}
            value={S.cd[c.id] || ''} onChange={(e) => { S.cd[c.id] = e.target.value; e.target.removeAttribute('aria-invalid'); repaint() }} />
          <div className="row"><span className="hint">Ctrl+Enter to review</span><span className="fsp" /><button className="btn sm pri" type="submit"><Ic n="send" sm />Send…</button></div>
        </form>
      </div> : <div className="pane"><div className="empty">Every thread is hidden.</div></div>}
    </div>
  </>
}
