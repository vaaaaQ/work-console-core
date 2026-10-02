import type { Board } from '../workspace.ts'

/* The team board as the bridge's board concept serves it: what is free to take, what is on you,
   and what you handed to QA. A workspace's board rule (its key, its Start playbook) and demo items
   live in workspaces/<id>/; the demo and the fake gateway start from the same items. */

export type Lane = 'free' | 'mine' | 'qa'
export interface BoardItem {
  id: string; type: string; title: string; state: string; column: string | null; lane: Lane
  assignedTo: string | null; changedAt: string; link: string
}

/** a board's columns: where a free item waits, and where Start moves it */
export const columns = (b?: Pick<Board, 'ready' | 'dev'>) => ({ ready: b?.ready ?? 'Ready', dev: b?.dev ?? { column: 'Dev', state: 'In Progress' } })

/** what Start does to an item, as a pack would: it goes on `me`, and one in the ready column moves to the dev column */
export function started(it: BoardItem, me: string, b?: Pick<Board, 'ready' | 'dev'>, at = new Date().toISOString()): BoardItem {
  const { ready, dev } = columns(b)
  return { ...it, lane: 'mine', assignedTo: me, changedAt: at, ...(it.column === ready ? { column: dev.column, state: dev.state } : {}) }
}
