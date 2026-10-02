import type * as React from 'react'
import type { BoardItem } from './data/board.ts'
import { CAL, CAL_ITEMS, CDR, CHATS0, JOBS0, JR, LLMS, LOG0, MAIL0, OVR, PRI, RET0, TPL0, WORK0 } from './data/demo.ts'
import type { WorkDoc } from './data/demo.ts'
import { PACKS, setDefaultWs } from './data/packs.ts'
import { REG } from './data/registry.ts'
import { CORE_PB, CORE_TPL, PB0 } from './data/playbooks.ts'
import type { TimeItem } from './data/time.ts'
import { MDR } from './data/ui.ts'
import { refill } from './lib/util.ts'
import { adapt } from './live/adapt.ts'
import { resetWorld } from './model/world.ts'
import type { Chat, Job, JobSeed, JournalEntry, LogEntry, Mail, Pack, Playbook, Pr, StepOverride, Tpl, Ws } from './model/types.ts'

/* The page half of a workspace: its pack, playbooks, board rule and demo data. workspaces/page.ts lists the
   registered ones and the page installs them at start; the core's data modules are containers this fills.
   Node may import a WorkspacePage too, so nothing here touches the DOM. */

export type GatewayItem = { id: string; [k: string]: unknown }
export interface Demo {
  jobs: JobSeed[]; chats: Chat[]; log: LogEntry[]
  ovr?: Record<string, Record<string, StepOverride>>; jr?: Record<string, JournalEntry[]>
  ret?: Record<string, { to: string; upTo: string; at: string; why: string; by: string }>
  pri?: Record<string, Pr>; llms?: Record<string, string>; cdr?: Record<string, string>; mdr?: Record<string, string>
  mail?: Mail[]; cal?: GatewayItem[]; board?: () => BoardItem[]; time?: (today: string) => TimeItem[]
  /** work items by id, as the bridge's work get returns them */
  work?: Record<string, WorkDoc>
}
/** start = the playbook Start gives a board item's job; key = the job key of an item id; itemId = the item id in a key, or null */
export interface Board { start: string; key(id: string): string; itemId(key: string): string | null }
export interface WorkspacePage {
  id: Ws; pack: Pack; me?: string   // prompts say "the user" and the board says "You" when unset
  playbooks: Record<string, Playbook>; templates?: Record<string, Tpl[]>
  board: Board; acts?: Record<string, { icon: string; label: string }>; demo: Demo
}
/** page-only: what a click on a workspace act does, and the dialogs it mounts */
export interface WorkspaceUi {
  acts?: Record<string, { run(j: Job): void | Promise<void>; busy?(j: Job): boolean; blocked?(j: Job): string | null; eyebrow?(j: Job): string }>
  Mount?: () => React.ReactElement | null
}
export interface Registered { page: WorkspacePage; ui?: WorkspaceUi }

const WS_ID = /^[a-z][a-z0-9-]{0,31}$/
/* REG, pageOf, wsPage (throws `no workspace <id>`) and itemOf live in a leaf the model can import */
export { REG, itemOf, pageOf, wsPage } from './data/registry.ts'

/** fills PACKS, PB0, TPL0 and the demo maps from the list, sets DEFAULT_WS to the first, resets the world */
export function install(list: Registered[]): void {
  if (!list.length) throw new Error('no workspace is registered')
  const seen = new Set<Ws>()
  for (const { page } of list) {
    if (typeof page.id !== 'string' || !WS_ID.test(page.id)) throw new Error(`workspace id ${page.id} must match ${WS_ID}`)
    if (seen.has(page.id)) throw new Error(`workspace ${page.id} is registered twice`)
    seen.add(page.id)
  }
  REG.splice(0, REG.length, ...list)
  const pages = list.map((r) => r.page)
  /** one map from every workspace's; ids (jobs, steps, chats) are unique across them */
  const merged = <T>(f: (p: WorkspacePage) => Record<string, T> | undefined) => Object.assign({}, ...pages.map((p) => f(p) ?? {})) as Record<string, T>
  /** a map by workspace id, holding only those that have the piece */
  const byWs = <T>(f: (p: WorkspacePage) => T | undefined) => Object.fromEntries(pages.flatMap((p) => { const v = f(p); return v === undefined ? [] : [[p.id, v]] })) as Record<Ws, T>
  refill(PACKS, byWs((p) => p.pack))
  refill(PB0, { ...CORE_PB, ...merged((p) => p.playbooks) })
  refill(TPL0, { ...CORE_TPL, ...merged((p) => p.templates) })
  JOBS0.splice(0, JOBS0.length, ...pages.flatMap((p) => p.demo.jobs))
  refill(OVR, merged((p) => p.demo.ovr)); refill(JR, merged((p) => p.demo.jr)); refill(RET0, merged((p) => p.demo.ret))
  refill(PRI, merged((p) => p.demo.pri)); refill(LLMS, merged((p) => p.demo.llms)); refill(CDR, merged((p) => p.demo.cdr))
  refill(MDR, merged((p) => p.demo.mdr)); refill(WORK0, merged((p) => p.demo.work))
  refill(CHATS0, byWs((p) => p.demo.chats)); refill(LOG0, byWs((p) => p.demo.log)); refill(MAIL0, byWs((p) => p.demo.mail))
  refill(CAL_ITEMS, byWs((p) => p.demo.cal))
  refill(CAL, byWs((p) => p.demo.cal?.map((i) => ({ id: i.id, ...adapt.cal(i, p.pack.tz) }))))
  setDefaultWs(pages[0].id)
  resetWorld()
}
