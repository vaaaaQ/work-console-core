import * as React from 'react'
import { md } from '../lib/md.ts'
import { store } from '../lib/util.ts'
import { repaint } from '../store.ts'

/* An LLM draft or an accepted output: Markdown by default, the text as written on request. The choice
   is the device's and applies to every such text on the page. */

export type OutView = 'md' | 'raw'
const h = React.createElement

// set once the user picks; until then the stored choice, so blocked storage still switches for the visit
let picked: OutView | null = null
export const outView = (): OutView => picked ?? (store.get<string>('outView', 'md') === 'raw' ? 'raw' : 'md')
export function setOutView(v: OutView) { picked = v; store.set('outView', v); repaint() }

export const OutText = ({ t }: { t: string }) =>
  outView() === 'raw' ? h('pre', { className: 'out' }, t) : h('div', { className: 'md out-md' }, md(t))

export function OutSeg() {
  const v = outView(), b = (x: OutView, l: string) => h('button', { key: x, type: 'button', 'aria-pressed': v === x, onClick: () => setOutView(x) }, l)
  return h('div', { className: 'seg out-seg', role: 'group', 'aria-label': 'Show the text as' }, b('md', 'MD'), b('raw', 'Raw'))
}
