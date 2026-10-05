import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { RunRec } from './types.ts'
import { thread } from './thread.ts'

const R = (id: string, at: string, o: Partial<RunRec> = {}): RunRec => ({ id, job: 'J-1', step: 's', q: id, state: 'draft', at, ...o })

test('thread follows parent from the latest run back to its root', () => {
  const runs = [R('a', '1'), R('b', '2', { parent: 'a' }), R('x', '0', { step: 't' }), R('c', '3', { parent: 'b' })]
  assert.deepEqual(thread(runs, 'J-1', 's').map((r) => r.id), ['a', 'b', 'c'])
})

test('a fresh ask starts a new thread; no run is no thread', () => {
  assert.deepEqual(thread([R('a', '1'), R('b', '2', { parent: 'a' }), R('n', '4')], 'J-1', 's').map((r) => r.id), ['n'])
  assert.deepEqual(thread([], 'J-1', 's'), [])
})
