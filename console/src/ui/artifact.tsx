import * as React from 'react'
import { artText } from '../live/api.ts'
import { parseCsv } from '../lib/csv.ts'
import { md } from '../lib/md.ts'
import { Ic } from './Icon.tsx'
import { modal } from './modal.tsx'

/* Every artifact downloads; Markdown and CSV also open in a viewer on the page. */

const MAX = 2 << 20, ROWS = 1000

export const viewable = (n: string) => /\.(md|markdown|csv)$/i.test(n)
export const dlHref = (link: string) => link + (link.includes('?') ? '&' : '?') + 'dl=1'

export function openArtifact(n: string, link: string) {
  modal({
    title: n, cls: 'wide', body: <ArtBody n={n} link={link} />,
    foot: <a className="btn pri" href={dlHref(link)} download={n}><Ic n="download" sm />Download</a>,
  })
}

function ArtBody({ n, link }: { n: string; link: string }) {
  const [st, set] = React.useState<{ t?: string; err?: string }>({})
  React.useEffect(() => {
    let on = true
    artText(link).then((t) => { if (on) set({ t }) }, (e: Error) => { if (on) set({ err: e.message }) })
    return () => { on = false }
  }, [link])
  if (st.err) return <p className="why">Could not open {n}: {st.err}</p>
  if (st.t === undefined) return <p className="why">Loading…</p>
  if (st.t.length > MAX) return <p className="why">Too big to show here; download it instead.</p>
  return /\.csv$/i.test(n) ? <Csv t={st.t} /> : <div className="md">{md(st.t)}</div>
}

function Csv({ t }: { t: string }) {
  const [head, ...rows] = parseCsv(t)
  if (!head) return <p className="why">The file is empty.</p>
  return <>
    <div className="tw"><table className="mt"><thead><tr>{head.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
      <tbody>{rows.slice(0, ROWS).map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody></table></div>
    {rows.length > ROWS ? <p className="why">The first {ROWS} of {rows.length} rows; the download has them all.</p> : null}
  </>
}

/** an artifact's name in a list: opens the viewer, or downloads what the viewer cannot show */
export const ArtName = ({ n, link }: { n: string; link: string }) => viewable(n)
  ? <button type="button" className="lnk" onClick={() => openArtifact(n, link)}>{n}</button>
  : <a href={dlHref(link)} download={n}>{n}</a>
