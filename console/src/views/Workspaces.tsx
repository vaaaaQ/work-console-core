import * as React from 'react'
import { CORE } from '../data/core.ts'
import { PACKS } from '../data/packs.ts'
import { REG } from '../data/registry.ts'
import { JOBS, PB, S, W, isClosed } from '../model/world.ts'
import type { Ws } from '../model/types.ts'
import { setWs } from '../actions/nav.tsx'

export function Workspaces() {
  const ks = Object.keys(PACKS) as Ws[]
  const cur = (k: Ws) => k === S.ws ? 'cur-ws' : undefined, own = (k: Ws) => Object.keys(PB).filter((x) => PB[x].ws === k)
  /** the step actions a workspace adds, as actOf shows them: named by its page and handled by its ui; the row shows once some workspace adds one */
  const acts = (k: Ws) => {
    const r = REG.find((x) => x.page.id === k), ui = r?.ui?.acts || {}
    return Object.entries(r?.page.acts || {}).filter(([n]) => Object.hasOwn(ui, n)).map(([, a]) => a.label)
  }
  return <>
    <div className="vh"><div><div className="eyebrow">{W().n} · setup</div><h1>Workspaces</h1>
      <p>The core is the same everywhere: jobs, playbooks, steps, approvals and sources. A workspace is a pack: it maps its tools onto the core concepts and brings its own playbooks, so a new workplace is a new pack, not a new core.</p></div></div>
    <div className="packs">{ks.map((k) => {
      const p = PACKS[k], on = k === S.ws, nj = JOBS.filter((j) => j.ws === k && !isClosed(j)).length
      return (
        <div key={k} className={'pk' + (on ? ' on' : '')}>
          <div className="r1"><h2>{p.n}</h2>{on ? <span className="tag">current</span> : <button className="btn sm" onClick={() => setWs(k)}>Switch</button>}</div>
          <div className="why">{p.d}</div>
          <dl className="kv"><dt>Team time</dt><dd>{p.tz ? p.tzl : <span className="why">not set</span>}</dd><dt>Review rule</dt><dd>{p.rule}</dd>
            <dt>Open jobs</dt><dd className="num">{nj}</dd><dt>Own playbooks</dt><dd className="num">{own(k).length}</dd></dl>
        </div>
      )
    })}</div>
    <div className="tw"><table className="mt" style={{ minWidth: 600 }}>
      <thead><tr><th>Core concept</th>{ks.map((k) => <th key={k} className={cur(k)}>{PACKS[k].n}</th>)}</tr></thead>
      <tbody>
        {CORE.map(([c, n, d]) => <tr key={c}><td className="cn">{n}<small>{d}</small></td>{ks.map((k) => {
          const s = PACKS[k].src[c]
          return <td key={k} className={cur(k)}>{s && s.n ? <>{s.n}{s.item ? <small className="why" style={{ display: 'block' }}>{s.item}</small> : null}</> : <span className="na">not set</span>}</td>
        })}</tr>)}
        <tr><td className="cn">Playbooks<small>flows its jobs follow</small></td>{ks.map((k) => {
          const o = own(k)
          return <td key={k} className={cur(k)}>{o.length ? o.map((x, i) => <React.Fragment key={x}>{i ? <br /> : null}{PB[x].n}</React.Fragment>) : <span className="na">none</span>}</td>
        })}</tr>
        {ks.some((k) => acts(k).length) ? <tr><td className="cn">Step actions<small>console buttons its steps offer</small></td>{ks.map((k) => {
          const a = acts(k)
          return <td key={k} className={cur(k)}>{a.length ? a.map((x, i) => <React.Fragment key={i}>{i ? <br /> : null}{x}</React.Fragment>) : <span className="na">none</span>}</td>
        })}</tr> : null}
      </tbody>
    </table></div>
    <p className="hint">Core playbooks ({Object.keys(PB).filter((x) => !PB[x].ws).map((x) => PB[x].n).join(', ')}) are offered in every workspace. “not set” marks a concept a pack does not map yet.</p>
  </>
}
