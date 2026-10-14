import * as React from 'react'
import * as api from '../live/api.ts'
import { LIVE } from '../live/api.ts'
import { CHATS } from '../model/world.ts'
import { Ic } from './Icon.tsx'
import { toRows } from './chatTo.ts'
import type { ToPick } from './chatTo.ts'

/* The To of a chat message: a listed chat, a person or an address (chatTo.ts); init = the chat the message goes to
   unless changed. A form reads toChat or toAddr, and toName. */

/** typing pauses this long before the people are looked up */
const WAIT = 300

export function ChatTo({ ws, init }: { ws: string; init?: ToPick }) {
  const [q, setQ] = React.useState(''), [at, setAt] = React.useState(0), [pick, setPick] = React.useState<ToPick | null>(init ?? null)
  const changed = React.useRef(false)
  const [found, setFound] = React.useState<{ q: string; people: api.Person[] }>({ q: '', people: [] })
  const [busy, setBusy] = React.useState(false), [err, setErr] = React.useState('')
  const t = q.trim()
  React.useEffect(() => {
    setErr('')
    if (pick || !LIVE.on || t.length < 2) { setBusy(false); return }
    const ac = new AbortController(), timer = setTimeout(() => {
      setBusy(true)
      api.people(ws, t, ac.signal)
        .then((people) => setFound({ q: t, people }), (e) => { if (!ac.signal.aborted) { setFound({ q: t, people: [] }); setErr(e instanceof Error ? e.message : String(e)) } })
        .finally(() => { if (!ac.signal.aborted) setBusy(false) })
    }, WAIT)
    return () => { clearTimeout(timer); ac.abort() }
  }, [t, pick, ws])
  const rows = toRows(q, CHATS[ws] || [], found.q === t ? found.people : []), i = rows.length ? Math.min(at, rows.length - 1) : 0
  const take = (n: number) => { const r = rows[n]; if (r) setPick(r.pick) }
  const icon = (p: ToPick) => ('chat' in p ? 'message' : 'user')

  if (pick) return <div className="to-pick">
    <Ic n={icon(pick)} sm /><b>{pick.name}</b><span className="hint">{'chat' in pick ? 'chat' : `opens a 1:1 with ${pick.addr}`}</span><span className="fsp" />
    <button type="button" className="btn sm ghost" onClick={() => { changed.current = true; setPick(null); setQ(''); setAt(0) }}>Change</button>
    {'chat' in pick ? <input type="hidden" name="toChat" value={pick.chat} /> : <input type="hidden" name="toAddr" value={pick.addr} />}
    <input type="hidden" name="toName" value={pick.name} />
  </div>
  return <div className="to">
    <input className="inp" type="text" role="combobox" aria-expanded={rows.length > 0} aria-controls="to-l" aria-autocomplete="list" aria-label="To"
      aria-activedescendant={rows.length ? 'to-' + i : undefined} placeholder="A name, a chat or a mail address" autoComplete="off" spellCheck={false}
      data-autofocus autoFocus={changed.current} value={q} onChange={(e) => { setQ(e.target.value); setAt(0) }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const n = rows.length; if (n) setAt((i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n) }
        // Enter picks; it never sends a message whose To is still open
        else if (e.key === 'Enter') { e.preventDefault(); take(i) }
      }} />
    {rows.length || busy || err ? <ul id="to-l" className="to-l" role="listbox" aria-label="Who">
      {rows.map((r, n) => <li key={n} id={'to-' + n} role="option" aria-selected={n === i} onMouseDown={(e) => { e.preventDefault(); take(n) }}>
        <Ic n={icon(r.pick)} sm /><span>{r.pick.name}</span><small>{r.sub}</small></li>)}
      {busy ? <li className="why" aria-disabled="true"><span className="spin" />Looking up people…</li> : null}
      {err && !busy ? <li className="why" aria-disabled="true">No people search: {err}</li> : null}
    </ul> : null}
  </div>
}
