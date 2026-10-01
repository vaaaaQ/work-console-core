/* The team board as the bridge's board concept serves it: what is free to take, what is on you,
   and what you handed to QA. The demo and the fake gateway start from the same items. */

export type Lane = 'free' | 'mine' | 'qa'
export interface BoardItem {
  id: string; type: string; title: string; state: string; column: string | null; lane: Lane
  assignedTo: string | null; changedAt: string; link: string
}
/** the playbook Start gives a board item's new job */
export const DEFAULT_PB = 'dev-item'
/** who "on me" is in the demo; a live board names the signed-in user */
export const ME = 'You'

const ago = (h: number) => new Date(Date.now() - h * 3600e3).toISOString()
const it = (id: string, type: string, title: string, state: string, column: string | null, lane: Lane, assignedTo: string | null, h: number): BoardItem =>
  ({ id, type, title, state, column, lane, assignedTo, changedAt: ago(h), link: `https://jira.example/browse/${id}` })

export const BOARD0 = (): BoardItem[] => [
  it('ACME-512', 'Story', 'Public API: rate limiting per token', 'In Progress', 'Code Review', 'mine', ME, 1),
  it('ACME-561', 'Bug', 'Settings: time zone list ignores the region', 'In Progress', 'Dev', 'mine', ME, 20),
  it('ACME-603', 'Bug', 'Projects grid: export ignores the filter', 'To Do', 'Ready', 'free', null, 6),
  it('ACME-604', 'Story', 'Members: bulk invite from CSV', 'To Do', 'Ready', 'free', null, 30),
  it('ACME-530', 'Story', 'Search: index archived projects', 'In Progress', 'QA', 'qa', 'Sam Rivera', 3),
  it('ACME-480', 'Story', 'Login: remember the last workspace', 'Done', 'Done', 'qa', 'Sam Rivera', 200),
]

/** the job a board item belongs to: its key is the item's own key */
export const boardKey = (id: string) => id

/** what Start does to an item, as a pack would: it goes on you, and a Ready one moves to Dev */
export const started = (it: BoardItem, me = ME, at = new Date().toISOString()): BoardItem =>
  ({ ...it, lane: 'mine', assignedTo: me, changedAt: at, ...(it.column === 'Ready' ? { column: 'Dev', state: 'In Progress' } : {}) })
