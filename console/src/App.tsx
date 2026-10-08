import * as React from 'react'
import { hm } from './lib/util.ts'
import { zoneName } from './lib/zone.ts'
import { MAIL, S, W, byId } from './model/world.ts'
import type { View } from './model/types.ts'
import { repaint, useAfterRender, useWorld } from './store.ts'
import { VIEWS, closeDrawer, demoInfo, dismiss, go, isDark, isView, readHash, toggleTheme } from './actions/nav.tsx'
import { escNarrow } from './actions/wide.ts'
import { curChat } from './actions/sources.tsx'
import { LIVE, missingParts, pushSupported, subscribePush } from './live/api.ts'
import { L, down } from './live/boot.ts'
import { REG } from './data/registry.ts'
import { Devices } from './views/Devices.tsx'
import { Ic } from './ui/Icon.tsx'
import { ModalHost, closeModal, isModalOpen } from './ui/modal.tsx'
import { openPalette } from './ui/Palette.tsx'
import { Toasts } from './ui/toasts.tsx'
import { Approvals } from './views/Approvals.tsx'
import { BoardView } from './views/Board.tsx'
import { CalendarView } from './views/Calendar.tsx'
import { TimeView } from './views/Time.tsx'
import { Chats } from './views/Chats.tsx'
import { Drawer } from './views/Drawer.tsx'
import { JobView } from './views/Job.tsx'
import { Jobs } from './views/Jobs.tsx'
import { Knowledge } from './views/Knowledge.tsx'
import { MailView } from './views/Mail.tsx'
import { Nav } from './views/Nav.tsx'
import { Playbooks } from './views/Playbooks.tsx'
import { Today } from './views/Today.tsx'
import { Workspaces } from './views/Workspaces.tsx'

const TITLE: Record<View, string> = {
  jobs: 'Jobs', job: 'Job', approvals: 'Approvals', knowledge: 'Knowledge', today: 'Today', chats: 'Chats', mail: 'Mail',
  calendar: 'Calendar', board: 'Board', time: 'Time', playbooks: 'Playbooks', workspaces: 'Workspaces', devices: 'Devices',
}
const BODY: Record<View, () => React.ReactElement> = {
  jobs: () => <Jobs />, job: () => <JobView />, approvals: () => <Approvals />, knowledge: () => <Knowledge />, today: () => <Today />,
  chats: () => <Chats />, mail: () => <MailView />, calendar: () => <CalendarView />, board: () => <BoardView />, time: () => <TimeView />,
  playbooks: () => <Playbooks />, workspaces: () => <Workspaces />,
  devices: () => <Devices />,
}

/** what the open view settles on as it renders: the chat shown counts as read, and the mail list keeps one message selected */
function settleView() {
  if (S.view === 'chats') { const c = curChat(); if (c) { S.chat[S.ws] = c.id; c.unread = 0 } }
  else if (S.view === 'mail') {
    const inCat = (MAIL[S.ws] || []).filter((x) => x.cat === S.mcat), m = inCat.find((x) => x.id === S.mail) || inCat[0]
    if (m) S.mail = m.id
  }
}

function Clock() {
  const [, tick] = React.useState(0)
  React.useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 10000); return () => clearInterval(t) }, [])
  const w = W()
  return <span className="clock hide-sm" id="clock">{zoneName()} <b>{hm()}</b>{w.tz ? <> · {w.tzl} <b>{hm(new Date(), w.tz)}</b></> : null}</span>
}

const FOCUSABLE = 'button,input,select,textarea,summary,[tabindex]:not([tabindex="-1"])'

/* Keys work across the whole page, so they listen on the document; React's own handlers run first. */
function listen() {
  const key = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return
    const k = e.key, mod = e.ctrlKey || e.metaKey, open = isModalOpen(), t = e.target as HTMLElement
    if (mod && (k === 'k' || k === 'K')) { e.preventDefault(); if (open) dismiss(); else openPalette(); return }
    if (k === 'Escape') {
      if (open) { e.preventDefault(); dismiss() } else if (document.getElementById('drawer')?.hidden === false && !escNarrow()) closeDrawer()
      return
    }
    if (mod && k === 'Enter') { const f = t.closest?.('form[data-form]') as HTMLFormElement | null; if (f) { e.preventDefault(); f.requestSubmit() } return }
    if (k === 'Tab' && open) {
      const sc = document.getElementById('scrim')
      const L = sc ? [...sc.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => !(x as HTMLButtonElement).disabled && !x.hidden && x.getClientRects().length) : []
      if (!L.length) return
      const a = L[0], z = L[L.length - 1]
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus() }
      else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus() }
      return
    }
    if (k === '/' && !open && !mod && S.view === 'jobs' && !/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) {
      const q = document.getElementById('q')
      if (q) { e.preventDefault(); q.focus() }
    }
  }
  /* a field marked invalid is fixed by typing in it; the playbook box and the search fields check themselves */
  const input = (e: Event) => {
    const t = e.target as HTMLElement
    if (t.id === 'pbjson' || t.id === 'q' || t.id === 'pal-q') return
    if (t.getAttribute?.('aria-invalid') === 'true') t.removeAttribute('aria-invalid')
  }
  const hash = () => {
    const h = readHash()
    if (!h || h === (S.view === 'job' ? S.job : S.view)) return
    closeModal()
    if (byId(h)) go('job', h)
    else if (isView(h) && h !== 'job') go(h)
  }
  const mq = matchMedia('(prefers-color-scheme: dark)'), scheme = () => repaint()
  document.addEventListener('keydown', key)
  document.addEventListener('input', input)
  window.addEventListener('hashchange', hash)
  try { mq.addEventListener('change', scheme) } catch { /* old engines: the theme then follows on the next change */ }
  return () => {
    document.removeEventListener('keydown', key)
    document.removeEventListener('input', input)
    window.removeEventListener('hashchange', hash)
    try { mq.removeEventListener('change', scheme) } catch { /* as above */ }
  }
}

export function App() {
  useWorld()
  useAfterRender()
  React.useEffect(listen, [])
  settleView()
  const dark = isDark()
  return <>
    <div className="app">
      <header className="top">
        <div className="brand"><span className="brand-mark" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /><i /><i /></span>Work Console</div>
        <button className="kbtn" id="kbtn" aria-label="Command palette" onClick={openPalette}><Ic n="search" /><span>Jump to a job, view or action…</span><kbd>Ctrl K</kbd></button>
        <span className="tgap" />
        <Clock />
        {LIVE.on ? <>
          {LIVE.push && pushSupported() && Notification.permission === 'default'
            ? <button className="btn sm ghost hide-sm" onClick={() => void subscribePush(LIVE.push, true).then(repaint)}>Enable notifications</button> : null}
          <span className={'live' + (L().bridge === 'ok' ? '' : ' off')} title={L().bridge === 'ok' ? `Connected to ${down().name}` : down().off}>{L().bridge === 'ok' ? 'Live' : 'Offline'}</span>
        </> : <button className="demo" title="What is real here" onClick={demoInfo}>Demo</button>}
        <button className="iconbtn" id="theme" aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'} onClick={toggleTheme}><Ic n={dark ? 'sun' : 'moon'} /></button>
      </header>
      {LIVE.on && LIVE.updated ? <div className="banner note" role="status"><Ic n="refresh" sm />Updated — press Ctrl+F5</div> : null}
      {LIVE.on && L().bridge !== 'ok' ? <div className="banner" role="status"><Ic n="warn" sm />{down().banner}</div> : null}
      {LIVE.on && missingParts().length ? <div className="banner" role="status"><Ic n="warn" sm />The state store did not answer: {missingParts().join(' and ')} are unavailable, not empty. Retrying.</div> : null}
      <Nav />
      <main id="main">{VIEWS.map((v) => (
        <section key={v} id={'v-' + v} className="view" hidden={S.view !== v} aria-label={TITLE[v]}>{S.view === v ? BODY[v]() : null}</section>
      ))}</main>
    </div>
    <Drawer />
    <ModalHost onDismiss={dismiss} />
    <Toasts />
    {REG.map(({ page, ui }) => { const M = ui?.Mount; return M ? <M key={page.id} /> : null })}
  </>
}
