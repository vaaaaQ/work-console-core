import * as React from 'react'
import { CHATS, MAIL, S, W, approvals, needsYou, proposals, wsJobs } from '../model/world.ts'
import type { View } from '../model/types.ts'
import { LIVE } from '../live/api.ts'
import { L } from '../live/boot.ts'
import { go } from '../actions/nav.tsx'
import { Ic } from '../ui/Icon.tsx'
import { closeModal } from '../ui/modal.tsx'

type NavItem = [View, string, string, string?]

/** the sections, grouped; a source shows the tool that backs it in this workspace */
export function navDef(): [string, NavItem[]][] {
  const w = W()
  const src = (on: unknown, it: NavItem): NavItem[] => (on ? [it] : [])
  return ([['Work', [['jobs', 'Jobs', 'list'], ['approvals', 'Approvals', 'check'], ['knowledge', 'Knowledge', 'file'], ['today', 'Today', 'zap']]],
    ['Sources', [...src(w.src.chat, ['chats', 'Chats', 'message', w.src.chat?.n]), ...src(w.src.mail, ['mail', 'Mail', 'mail', w.src.mail?.n]),
      ...src(w.src.cal, ['calendar', 'Calendar', 'calendar', w.src.cal?.n]), ...src(w.src.work, ['board', 'Board', 'wrench', w.src.work?.n]),
      ...src(w.src.time, ['time', 'Time', 'hourglass', w.src.time?.n])]],
    ['Setup', [['playbooks', 'Playbooks', 'layers'], ['workspaces', 'Workspaces', 'sliders'], ...(LIVE.on && LIVE.pc ? [['devices', 'Devices', 'user'], ['settings', 'Settings', 'bot']] as NavItem[] : [])]]] as [string, NavItem[]][])
    // a workspace without sources has no Sources heading either
    .filter(([, items]) => items.length)
}

function counts(): Partial<Record<View, number>> {
  return {
    jobs: wsJobs().filter(needsYou).length, approvals: approvals().length + proposals().length + (LIVE.on ? L().proposals.length + (L().agent?.pending ? 1 : 0) : 0),
    chats: (CHATS[S.ws] || []).reduce((a, c) => a + c.unread, 0), mail: (MAIL[S.ws] || []).filter((m) => m.cat === 'reply' && !m.done).length,
  }
}
const HOT: Partial<Record<View, 1>> = { jobs: 1, approvals: 1 }

export function Nav() {
  const c = counts()
  return (
    <nav className="nav" id="nav" aria-label="Sections">
      {navDef().map(([g, items]) => (
        <React.Fragment key={g}>
          <div className="nav-lbl">{g}</div>
          {items.map(([v, l, i, sub]) => {
            const on = S.view === v || (v === 'jobs' && S.view === 'job')
            return (
              <button key={v} aria-current={on ? 'page' : undefined} onClick={() => { closeModal(); go(v) }}>
                <Ic n={i} /><span>{l}</span>{sub ? <span className="sub">{sub}</span> : null}{c[v] ? <span className={'cnt' + (HOT[v] ? ' hot' : '')}>{c[v]}</span> : null}
              </button>
            )
          })}
        </React.Fragment>
      ))}
    </nav>
  )
}
