import * as React from 'react'
import { clearNew } from './model/world.ts'

/* The world is plain mutable data (model/world.ts). A change goes through commit(), which re-renders
   everything that called useWorld(); what the last change marked new shows once, then clears. */
let version = 0
let changes = 0
const subs = new Set<() => void>()
const after: (() => void)[] = []

const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f) } }
const getVersion = () => version

/** re-render without touching the world (theme, downloads becoming available) */
export function repaint() { version++; subs.forEach((f) => f()) }
/** change the world, then re-render; `then` runs once the DOM shows the change (focus, caret, scroll) */
export function commit<T = void>(fn?: () => T, then?: () => void): T {
  clearNew()
  changes++
  const r = fn?.() as T
  if (then) after.push(then)
  repaint()
  return r
}
/** counts changes, so an element marked new by two changes in a row animates both times */
export const changeNo = () => changes
export function useWorld() { React.useSyncExternalStore(subscribe, getVersion) }
/** the root calls this: its layout effect runs after every child's DOM is in place */
export function useAfterRender() { React.useLayoutEffect(() => { after.splice(0).forEach((f) => f()) }) }
