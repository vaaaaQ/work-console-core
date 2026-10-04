import * as React from 'react'
import { PACKS } from '../data/packs.ts'
import { JOBS, PB, S, pbs } from '../model/world.ts'
import type { Ws } from '../model/types.ts'
import { go, isDark, setWs, toggleTheme } from '../actions/nav.tsx'
import { newJob } from '../actions/newjob.tsx'
import { pbAdd } from '../actions/playbooks.tsx'
import { navDef } from '../views/Nav.tsx'
import { Ic } from './Icon.tsx'
import { closeModal, modal } from './modal.tsx'

type Item = { l: string; i: string; s: string; f: () => void }

function items(): Item[] {
  const it: Item[] = []
  navDef().forEach(([g, L]) => L.forEach(([v, l, i]) => it.push({ l, i, s: g.toLowerCase(), f: () => go(v) })))
  it.push({ l: 'New job', i: 'plus', s: 'action', f: () => newJob() }, { l: 'Add playbook', i: 'upload', s: 'action', f: () => pbAdd() })
  ;(Object.keys(PACKS) as Ws[]).filter((k): boolean => k !== S.ws).forEach((k) => it.push({ l: `Switch to ${PACKS[k].n}`, i: 'sliders', s: 'workspace', f: () => setWs(k) }))
  it.push({ l: isDark() ? 'Light theme' : 'Dark theme', i: isDark() ? 'sun' : 'moon', s: 'action', f: toggleTheme })
  JOBS.forEach((j) => it.push({ l: `${j.key} · ${j.t}`, i: 'list', s: `${PACKS[j.ws].n} · ${j.id}`, f: () => go('job', j.id) }))
  pbs().forEach((k) => it.push({ l: PB[k].n, i: 'layers', s: 'playbook', f: () => { S.pbv = k; go('playbooks') } }))
  return it
}

function PaletteBody() {
  const [all] = React.useState(items)
  const [q, setQ] = React.useState('')
  const [pi, setPi] = React.useState(0)
  const ql = q.trim().toLowerCase()
  const L = all.filter((x) => !ql || (x.l + ' ' + x.s).toLowerCase().includes(ql)).slice(0, 40)
  const at = L.length ? Math.min(Math.max(pi, 0), L.length - 1) : 0
  const run = (i: number) => { const x = L[i]; if (!x) return; closeModal(); x.f() }
  React.useLayoutEffect(() => { document.getElementById('pal-' + at)?.scrollIntoView({ block: 'nearest' }) })
  return <>
    <input id="pal-q" type="text" role="combobox" aria-expanded="true" aria-controls="pal-l" aria-autocomplete="list" aria-label="Jump to"
      placeholder="A job, view or action…" autoComplete="off" spellCheck={false} data-autofocus
      aria-activedescendant={L.length ? 'pal-' + at : undefined} value={q}
      onChange={(e) => { setQ(e.target.value); setPi(0) }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const n = L.length; if (n) setPi((at + (e.key === 'ArrowDown' ? 1 : n - 1)) % n) }
        else if (e.key === 'Enter') { e.preventDefault(); run(at) }
      }} />
    <ul id="pal-l" role="listbox" aria-label="Results">
      {L.length
        ? L.map((x, i) => <li key={i} role="option" id={'pal-' + i} aria-selected={i === at} onClick={() => run(i)}><Ic n={x.i} sm /><span>{x.l}</span><small>{x.s}</small></li>)
        : <li className="why" aria-disabled="true">No matches</li>}
    </ul>
  </>
}

export function openPalette() { modal({ title: 'Jump to', cls: 'pal', body: <PaletteBody /> }) }
