import type { BoardItem, Lane } from '../../../src/data/board.ts'

/* Acme's team board in the demo; the fake gateway starts from the same items. Acme names no user, so "on me" is 'You' */
const ago = (h: number) => new Date(Date.now() - h * 3600e3).toISOString()
const it = (id: string, type: string, title: string, state: string, column: string | null, lane: Lane, assignedTo: string | null, h: number): BoardItem =>
  ({ id, type, title, state, column, lane, assignedTo, changedAt: ago(h), link: `https://jira.example/browse/${id}` })

export const BOARD0 = (): BoardItem[] => [
  it('ACME-512', 'Story', 'Public API: rate limiting per token', 'In Progress', 'Code Review', 'mine', 'You', 1),
  it('ACME-561', 'Bug', 'Settings: time zone list ignores the region', 'In Progress', 'Dev', 'mine', 'You', 20),
  it('ACME-603', 'Bug', 'Projects grid: export ignores the filter', 'To Do', 'Ready', 'free', null, 6),
  it('ACME-604', 'Story', 'Members: bulk invite from CSV', 'To Do', 'Ready', 'free', null, 30),
  it('ACME-530', 'Story', 'Search: index archived projects', 'In Progress', 'QA', 'qa', 'Sam Rivera', 3),
  it('ACME-480', 'Story', 'Login: remember the last workspace', 'Done', 'Done', 'qa', 'Sam Rivera', 200),
]
