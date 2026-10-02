import * as React from 'react'
import { PACKS } from '../data/packs.ts'
import { store } from '../lib/util.ts'
import { S, W, byId } from '../model/world.ts'
import { opener } from '../model/home.ts'
import type { View, Ws } from '../model/types.ts'
import { commit, repaint } from '../store.ts'
import { closeModal, modal, modalForm } from '../ui/modal.tsx'
import { toast } from '../ui/toasts.tsx'
import { newJob } from './playbooks.tsx'

export const VIEWS: View[] = ['jobs', 'job', 'approvals', 'knowledge', 'today', 'chats', 'mail', 'calendar', 'board', 'time', 'playbooks', 'workspaces', 'devices']
export const isView = (h: string): h is View => (VIEWS as string[]).includes(h)

/** the hash is a bare token: a job id or a view name */
export function setHash() {
  const h = S.view === 'job' ? S.job : S.view
  try { history.replaceState(null, '', '#' + h) } catch { /* a sandboxed frame may refuse it */ }
}
export function readHash() { try { return decodeURIComponent(location.hash.slice(1)) } catch { return '' } }
export function fromHash() {
  const h = readHash()
  if (!h) return
  const j = byId(h)
  if (j) { S.ws = j.ws; S.job = h; S.view = 'job' }
  else if (isView(h) && h !== 'job' && !(h === 'mail' && !W().src.mail)) S.view = h
}

/** open a view; a job opens in its own workspace, and `sel` opens one of its steps */
export function go(v: View, id?: string, sel?: string) {
  const j = v === 'job' && id ? byId(id) : undefined
  if (v === 'job' && !j) return
  commit(() => {
    if (j) { if (j.ws !== S.ws) setWs(j.ws, true); if (S.job !== j.id) S.sel = null; S.job = j.id }
    else S.sel = null
    S.view = v === 'mail' && !W().src.mail ? 'jobs' : v
    if (sel) S.sel = sel
  }, () => window.scrollTo(0, 0))
  setHash()
}
opener.go = (v) => go(v)

/** quiet only changes the state, for a caller that renders itself */
export function setWs(ws: Ws, quiet?: boolean) {
  if (!PACKS[ws] || (ws === S.ws && !quiet)) return
  const f = () => {
    S.ws = ws; store.set('ws', ws); S.f = 'all'; S.prj = 'all'; S.q = ''; S.pbv = null
    if (S.view === 'mail' && !W().src.mail) S.view = 'jobs'
    if (S.view === 'job' && (S.job ? byId(S.job)?.ws : undefined) !== ws) { S.view = 'jobs'; S.job = null; S.sel = null }
  }
  if (quiet) { f(); return }
  commit(f)
  setHash()
  toast(<>Workspace: <b>{W().n}</b> · {W().d}</>)
}

export const isDark = () => {
  const t = document.documentElement.dataset.theme
  return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches
}
export function applyStoredTheme() { const t = store.get<string | null>('theme', null); if (t) document.documentElement.dataset.theme = t }
export function toggleTheme() {
  const t = isDark() ? 'light' : 'dark'
  document.documentElement.dataset.theme = t
  store.set('theme', t)
  repaint()
}

/** Cancel, Close, Escape: a dialog opened over New job goes back to it with what was typed */
export function dismiss() {
  if (S.pbRet === 'newjob' && modalForm() !== 'newjob') { S.pbRet = null; newJob(S.njDraft || {}) }
  else { S.pbRet = null; closeModal() }
}

export function closeDrawer() {
  const had = S.sel
  commit(() => { S.sel = null; S.focusB = null }, () => { const h = had && document.getElementById('h-' + had); if (h) h.focus() })
}

export function demoInfo() {
  modal({
    title: 'What is real here',
    body: <>
      <p style={{ margin: 0 }}>A clickable prototype on local demo data. No Jira, GitHub, Slack, Jenkins or LLM is called, and changes last until you reload.</p>
      <dl className="kv"><dt>Core</dt><dd>Jobs, playbooks, steps, approvals, sources. The same in every workspace.</dd>
        <dt>Packs</dt><dd>A workspace maps its tools onto the core and adds its own playbooks. The demo's Acme: Jira, GitHub, Slack, Jenkins, Zoom, Confluence.</dd>
        <dt>Who runs steps</dt><dd>You. Mark a step done yourself, or ask the LLM for a draft and accept, edit or reject it. Nothing runs on its own.</dd></dl>
    </>,
    foot: <button type="button" className="btn pri" onClick={dismiss}>Got it</button>,
  })
}
