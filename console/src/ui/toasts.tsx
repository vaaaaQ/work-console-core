import * as React from 'react'

type Toast = { id: number; msg: React.ReactNode; act?: string; fn?: () => void }
let list: Toast[] = []
let seq = 0
const subs = new Set<() => void>()
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f) } }
const getList = () => list
function set(l: Toast[]) { list = l; subs.forEach((f) => f()) }
const drop = (id: number) => set(list.filter((t) => t.id !== id))

/** a note at the bottom that goes away by itself; `act` adds one button that runs `fn` */
export function toast(msg: React.ReactNode, act?: string, fn?: () => void, ms = 5200) {
  const id = ++seq
  set([...list, { id, msg, act, fn }])
  setTimeout(() => drop(id), ms)
}

export function Toasts() {
  const L = React.useSyncExternalStore(subscribe, getList)
  return (
    <div className="toasts" id="toasts" aria-live="polite">
      {L.map((t) => (
        <div className="toast" key={t.id}>
          <span>{t.msg}</span>
          {t.act ? <button onClick={() => { drop(t.id); t.fn?.() }}>{t.act}</button> : null}
        </div>
      ))}
    </div>
  )
}
