import * as React from 'react'
import { Ic } from './Icon.tsx'

export type ModalSpec = {
  title: string; body: React.ReactNode; foot?: React.ReactNode; cls?: string
  /** a named form: Enter and Ctrl+Enter submit it, and onSubmit gets its FormData */
  form?: string; onSubmit?: (fd: FormData, f: HTMLFormElement) => void
  /** runs once the dialog is in the DOM and focused */
  onOpen?: (el: HTMLElement) => void
}
let cur: (ModalSpec & { seq: number }) | null = null
let seq = 0
let lastFocus: Element | null = null
const subs = new Set<() => void>()
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f) } }
const getCur = () => cur
const notify = () => subs.forEach((f) => f())

/** one dialog at a time: a new one replaces the open one, and closing returns focus to where the first was opened from */
export function modal(spec: ModalSpec) {
  const a = document.activeElement, sc = document.getElementById('scrim')
  if (!(sc && a && sc.contains(a))) lastFocus = a
  cur = { ...spec, seq: ++seq }
  notify()
}
export function closeModal() {
  if (!cur) return
  cur = null
  notify()
  if (lastFocus instanceof HTMLElement && lastFocus.isConnected) lastFocus.focus()
}
export const modalForm = () => cur?.form ?? null
export const isModalOpen = () => !!cur

export function ModalHost({ onDismiss }: { onDismiss: () => void }) {
  const m = React.useSyncExternalStore(subscribe, getCur)
  return (
    <div className="scrim" id="scrim" hidden={!m} onClick={(e) => { if (e.target === e.currentTarget) onDismiss() }}>
      {m ? <Dialog key={m.seq} m={m} onDismiss={onDismiss} /> : null}
    </div>
  )
}

function Dialog({ m, onDismiss }: { m: ModalSpec; onDismiss: () => void }) {
  const ref = React.useRef<HTMLElement | null>(null)
  const setRef = (e: HTMLElement | null) => { ref.current = e }
  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const f = el.querySelector<HTMLElement>('[data-autofocus]') || el.querySelector<HTMLElement>('input,textarea,select') || el.querySelector<HTMLElement>('button')
    f?.focus()
    m.onOpen?.(el)
  }, [])
  const cls = 'modal ' + (m.cls || '')
  const inner = <>
    <div className="m-h"><h2>{m.title}</h2><button type="button" className="iconbtn" aria-label="Close" onClick={onDismiss}><Ic n="x" /></button></div>
    <div className="m-b">{m.body}</div>
    {m.foot ? <div className="m-f">{m.foot}</div> : null}
  </>
  if (!m.form) return <div ref={setRef} className={cls} role="dialog" aria-modal="true" aria-label={m.title}>{inner}</div>
  return (
    <form ref={setRef} className={cls} role="dialog" aria-modal="true" aria-label={m.title} data-form={m.form} noValidate
      onSubmit={(e) => { e.preventDefault(); m.onSubmit?.(new FormData(e.currentTarget), e.currentTarget) }}>{inner}</form>
  )
}
