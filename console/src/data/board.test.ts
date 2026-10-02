import { test } from 'node:test'
import assert from 'node:assert/strict'
import { columns, started } from './board.ts'
import type { BoardItem } from './board.ts'

const item = (column: string): BoardItem => ({
  id: 'T-1', type: 'Task', title: 'x', state: 'New', column, lane: 'free', assignedTo: null, changedAt: '2026-10-01T09:00:00Z', link: 'https://tracker.example/T-1',
})

test('Start puts an item on me; one in the Ready column moves to Dev, In Progress, by default', () => {
  assert.deepEqual(columns(), { ready: 'Ready', dev: { column: 'Dev', state: 'In Progress' } })
  const up = started(item('Ready'), 'Me', undefined, '2026-10-02T10:00:00Z')
  assert.deepEqual([up.lane, up.assignedTo, up.column, up.state, up.changedAt], ['mine', 'Me', 'Dev', 'In Progress', '2026-10-02T10:00:00Z'])
  const other = started(item('Code Review'), 'Me')
  assert.deepEqual([other.lane, other.column, other.state], ['mine', 'Code Review', 'New'], 'an item in another column stays where it is')
})

test("a board's own columns: its ready one moves to its dev one, and Ready is just a column", () => {
  const b = { ready: 'Approved', dev: { column: 'Build', state: 'Active' } }
  const up = started(item('Approved'), 'Me', b)
  assert.deepEqual([up.column, up.state], ['Build', 'Active'])
  const ready = started(item('Ready'), 'Me', b)
  assert.deepEqual([ready.column, ready.state], ['Ready', 'New'])
  assert.deepEqual(columns({ ready: 'Approved' }).dev, { column: 'Dev', state: 'In Progress' }, 'each field falls back on its own')
})
