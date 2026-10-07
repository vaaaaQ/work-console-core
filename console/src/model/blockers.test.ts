import '../testkit.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PB0 } from '../data/playbooks.ts'
import { TPL0 } from '../data/demo.ts'
import type { Flow, Job } from './types.ts'
import { apply, freshJob } from './transitions.ts'
import type { Ctx } from './transitions.ts'
import { holdsOf, openOf, reaches, settled, waitsM } from './blockers.ts'

const X: Ctx = { PB: PB0, TPL: TPL0, now: () => new Date('2026-10-07T12:00:00Z') }
const mk = (id: string): Job => apply(X, freshJob(X, id, { t: id, key: 'NEW', pb: 'action', prj: '', ws: 'acme' }), { op: 'start' }).job
const link = (j: Job, step: string, to: string, st: 'open' | 'done' | 'cancelled' = 'open') => { j.flow[step].w = [...(j.flow[step].w || []), { j: to, st }]; return j }
const flow = (o: Partial<Flow>): Flow => ({ s: 'cur', m: '', arts: [], b: [], rv: null, dr: null, out: null, run: null, sent: {}, ...o })

test('openOf and waitsM name only the open links', () => {
  const f = flow({ w: [{ j: 'A-1', st: 'open' }, { j: 'A-2', st: 'done' }, { j: 'A-3', st: 'open' }] })
  assert.deepEqual(openOf(f).map((l) => l.j), ['A-1', 'A-3'])
  assert.equal(waitsM(f), 'waits for A-1, A-3')
})

test('holdsOf lists the live steps of open jobs that wait for a job', () => {
  const a = link(mk('A-1'), 'tr', 'A-9'), b = link(mk('A-2'), 'dr', 'A-9'), c = link(mk('A-3'), 'tr', 'A-9', 'done')
  const d = link(mk('A-4'), 'tr', 'A-9'); d.st = 'cancelled'
  assert.deepEqual(holdsOf([a, b, c, d], 'A-9').map((h) => `${h.job.id}/${h.step}`), ['A-1/tr', 'A-2/dr'])
})

test('reaches follows open links at any depth and ignores closed jobs', () => {
  const a = link(mk('A-1'), 'tr', 'A-2'), b = link(mk('A-2'), 'dr', 'A-3'), c = mk('A-3')
  const m = new Map([a, b, c].map((j) => [j.id, j])), of = (id: string) => m.get(id)
  assert.equal(reaches(of, 'A-1', 'A-3'), true)
  assert.equal(reaches(of, 'A-3', 'A-1'), false)
  b.st = 'done'
  assert.equal(reaches(of, 'A-1', 'A-3'), false)
})

test('settled: cancelled → bad, open or a draft → wait, a cleared wait → cur, future steps are left', () => {
  assert.equal(settled(flow({ w: [{ j: 'A', st: 'cancelled' }, { j: 'B', st: 'open' }] })), 'bad')
  assert.equal(settled(flow({ w: [{ j: 'A', st: 'open' }] })), 'wait')
  assert.equal(settled(flow({ s: 'wait', dr: { t: 'd', at: '' }, w: [{ j: 'A', st: 'done' }] })), 'wait')
  assert.equal(settled(flow({ s: 'wait', w: [{ j: 'A', st: 'done' }] })), 'cur')
  assert.equal(settled(flow({ s: 'bad', m: 'blocker A cancelled' })), 'cur')
  assert.equal(settled(flow({ s: 'bad', m: 'vetoed' })), null)
  assert.equal(settled(flow({ s: 'fut', w: [{ j: 'A', st: 'cancelled' }] })), null)
  assert.equal(settled(flow({ s: 'done', w: [{ j: 'A', st: 'open' }] })), null)
})
