import * as React from 'react'
import { MCAT } from '../data/ui.ts'
import { MAIL, S, W, byId } from '../model/world.ts'
import type { Mail } from '../model/types.ts'
import { go } from '../actions/nav.tsx'
import { mailDone, mailJob, mailReply, pickMail, pickMcat } from '../actions/sources.tsx'
import { Ic } from '../ui/Icon.tsx'
import { loadMailBody, srcState } from '../live/boot.ts'
import { SumBox, Unavailable } from './Chats.tsx'

function MailPane({ m }: { m: Mail }) {
  const j = m.job ? byId(m.job) : undefined
  React.useEffect(() => { if (!m.body) loadMailBody(m.id) }, [m.id])
  return <>
    <div className="mail-h"><h2>{m.subj}</h2><div className="src">{m.from} · {m.at}{m.done ? ' · handled' : ''}</div></div>
    <SumBox id={m.id} text={m.sum} />
    <div className="mail-b"><p style={{ whiteSpace: 'pre-wrap' }}>{m.body || m.sum}</p>
      {m.sent ? <div className="tplm sent"><div className="ch"><Ic n="send" sm />Your reply · {m.sent.at}</div><div className="body">{m.sent.t}</div></div> : null}
      <div className="row">
        {j ? <button className="btn sm" onClick={() => go('job', j.id)}><Ic n="list" sm />{j.id} · {j.key}</button>
          : <button className="btn sm" onClick={() => mailJob(m.id)}><Ic n="plus" sm />Create job</button>}
        {m.cat === 'auto' ? null : <button className="btn sm" onClick={() => mailReply(m.id)}><Ic n="bot" sm />{m.cat === 'wait' ? 'Draft a follow-up…' : 'Draft a reply…'}</button>}
        {m.cat === 'reply' && !m.done ? <button className="btn sm ghost" onClick={() => mailDone(m.id)}><Ic n="check" sm />Mark handled</button> : null}
      </div></div>
  </>
}

export function MailView() {
  const w = W(), L = MAIL[S.ws] || [], inCat = L.filter((x) => x.cat === S.mcat), m = inCat.find((x) => x.id === S.mail) || inCat[0]
  const st = srcState('mail')
  if (st && st !== 'ok') return <Unavailable what="Mail" st={st} concept="mail" />
  return <>
    <div className="vh"><div><div className="eyebrow">{w.n} · sources</div><h1>Mail</h1>
      <p>{w.src.mail?.n} Inbox and Sent, sorted by what each message needs from you. Replies are drafted on request and shown to you before they go out.</p></div></div>
    <div className="fbar">{MCAT.map(([k, l, i]) => (
      <button key={k} className="fb" aria-pressed={S.mcat === k} onClick={() => pickMcat(k)}><Ic n={i} sm />{l}<span className="n">{L.filter((x) => x.cat === k && !x.done).length}</span></button>))}</div>
    <div className="split">
      <div className="list">{inCat.length ? inCat.map((x) => (
        <button key={x.id} className="li" aria-current={x === m} onClick={() => pickMail(x.id)}>
          <span className="r1"><span className="nm">{x.from}</span><span className="ts">{x.at}</span></span><span className="sub">{x.done ? 'handled · ' : ''}{x.subj}</span>
        </button>)) : <div className="empty">Nothing here.</div>}</div>
      <div className="pane">{m ? <MailPane m={m} /> : <div className="empty">Pick a message.</div>}</div>
    </div>
  </>
}
