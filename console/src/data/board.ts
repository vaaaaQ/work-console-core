/* The team board as the bridge's board concept serves it: what is free to take, what is on you,
   and what you handed to QA. A workspace's board rule (its key, its Start playbook) and demo items
   live in workspaces/<id>/; the demo and the fake gateway start from the same items. */

export type Lane = 'free' | 'mine' | 'qa'
export interface BoardItem {
  id: string; type: string; title: string; state: string; column: string | null; lane: Lane
  assignedTo: string | null; changedAt: string; link: string
}

/** what Start does to an item, as a pack would: it goes on `me`, and a Ready one moves to Dev */
export const started = (it: BoardItem, me: string, at = new Date().toISOString()): BoardItem =>
  ({ ...it, lane: 'mine', assignedTo: me, changedAt: at, ...(it.column === 'Ready' ? { column: 'Dev', state: 'In Progress' } : {}) })
