import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { RunRec } from './types.ts'
import { approveTo, thread } from './thread.ts'

const R = (id: string, at: string, o: Partial<RunRec> = {}): RunRec => ({ id, job: 'J-1', step: 's', q: id, state: 'draft', at, ...o })

test('thread follows parent from the latest run back to its root', () => {
  const runs = [R('a', '1'), R('b', '2', { parent: 'a' }), R('x', '0', { step: 't' }), R('c', '3', { parent: 'b' })]
  assert.deepEqual(thread(runs, 'J-1', 's').map((r) => r.id), ['a', 'b', 'c'])
})

test('a fresh ask starts a new thread; no run is no thread', () => {
  assert.deepEqual(thread([R('a', '1'), R('b', '2', { parent: 'a' }), R('n', '4')], 'J-1', 's').map((r) => r.id), ['n'])
  assert.deepEqual(thread([], 'J-1', 's'), [])
})

test('approveTo: the newest run of a thread with a session, only for a draft that waits for commands and was not handed in by hand', () => {
  const t = [R('a', '1', { session: 'S1' }), R('b', '2', { parent: 'a' })]
  const dr = { t: 'x', at: '2026-01-01T00:00:00.000Z', cm: ['git push'] }
  assert.equal(approveTo(dr, t)?.id, 'b')
  assert.equal(approveTo({ ...dr, cm: undefined }, t), null, 'no commands')
  assert.equal(approveTo(dr, [R('a', '1')]), null, 'no session to continue')
  assert.equal(approveTo(dr, []), null)
  // a draft handed in by hand was never written by that session, even when the step had an earlier LLM run
  assert.equal(approveTo({ ...dr, hd: 1 }, t), null)
})
