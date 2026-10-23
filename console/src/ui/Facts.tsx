import * as React from 'react'
import { CTX } from '../model/world.ts'
import { factLamp, factText, isNone, short, stripParts } from '../model/facts.ts'
import type { Fact } from '../model/facts.ts'
import { factsNow, stepOf } from '../model/transitions.ts'
import type { Job } from '../model/types.ts'
import { copy } from './bits.tsx'
import { Ic } from './Icon.tsx'

/* Facts on the page: a step's rows in the inspector and a past round's detail, and the job header's strip. */

const ext = { target: '_blank', rel: 'noreferrer noopener' } as const

/** one fact in a row: its lamp, its words with the links on names, and where it came from */
function FactRow({ j, f }: { j: Job; f: Fact }) {
  const from = stepOf(CTX, j, f.step)?.t ?? f.step, l = factLamp(f)
  const body = (() => {
    if (isNone(f)) return <>{f.kind}: nothing to report, {f.none}</>
    switch (f.kind) {
      case 'branch': return <>branch <b>{f.name}</b> at <code>{short(f.sha)}</code>
        <button className="iconbtn" aria-label={`Copy ${f.sha}`} title="Copy the sha" onClick={() => copy(f.sha, null, `Copied ${short(f.sha)}`)}><Ic n="copy" sm /></button>
        <span className="why"> repo {f.repo}{f.base ? `, from ${f.base}` : ''}</span></>
      case 'pr': return <><a href={f.url} {...ext}>PR{f.n ? ` #${f.n}` : ''}</a>{f.title ? ` ${f.title}` : ''} · {f.state}
        {f.checks.map((c, i) => <span key={i} className="fx-chk"><span className={'lamp ' + (c.state === 'pass' ? 'ok' : c.state === 'fail' ? 'bad' : 'wait')} />
          {c.url ? <a href={c.url} {...ext}>{c.name}</a> : c.name}</span>)}</>
      case 'deploy': return <>deployed <b>{f.what}</b> at <code>{f.version}</code> on {f.where}: {f.ok ? 'ok' : 'failed'}{f.url ? <> · <a href={f.url} {...ext}>link</a></> : null}</>
      case 'check': return <>check <b>{f.name}</b> {f.ok ? 'passed' : 'failed'}{f.against ? <> against <code>{f.against}</code></> : null}
        {f.url ? <> · <a href={f.url} {...ext}>evidence</a></> : f.art ? <> · artifact {f.art}</> : null}{f.note ? <span className="why"> {f.note}</span> : null}</>
      default: return <>{factText(f, (id) => stepOf(CTX, j, id)?.t ?? id)}</>
    }
  })()
  return <div className="fx-row"><span className={'lamp ' + l} /><div><div>{body}</div><div className="why">from “{from}”</div></div></div>
}

/** a step's facts: what it left, then what its waiting draft would leave */
export function FactList({ j, fx, draft }: { j: Job; fx?: Fact[]; draft?: Fact[] }) {
  if (!fx?.length && !draft?.length) return null
  return <div className="fx">
    {(fx ?? []).map((f, i) => <FactRow key={'f' + i} j={j} f={f} />)}
    {draft?.length ? <><div className="why">The draft would leave:</div>{draft.map((f, i) => <FactRow key={'d' + i} j={j} f={f} />)}</> : null}
  </div>
}

/** the job header's strip: branch · PR checks · deployed version · live check, the latest of each */
export function FactStrip({ j }: { j: Job }) {
  const ps = stripParts(factsNow(CTX, j))
  if (!ps.length) return null
  return <div className="fx-strip" aria-label="Facts">{ps.map((p, i) => (
    <span key={p.kind} className="fx-p">{i ? <span className="fx-sep">·</span> : null}<span className={'lamp ' + p.l} />{p.url ? <a href={p.url} {...ext}>{p.t}</a> : p.t}</span>))}</div>
}
