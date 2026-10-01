import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as T from '../../src/model/transitions.ts'
import type { Job } from '../../src/model/types.ts'
import { demoCtx } from '../testkit.ts'
import { Reminders } from './reminders.ts'

const MIN = 60e3, DUE = Date.parse('2026-10-01T15:00:00Z') // 12:00 at home (UTC−3)

const job = (id: string, due: number, o: Partial<Job> = {}): Job =>
  ({ ...T.freshJob(demoCtx(), id, { t: `Prep ${id}`, key: 'NEW', pb: 'action', prj: 'p', ws: 'acme', due: new Date(due).toISOString() }), ...o })

function setup(jobs: Job[], dir = mkdtempSync(join(tmpdir(), 'wc-rem-'))) {
  const clock = { t: 0 }, sent: { title: string; body: string; url: string }[] = []
  const r = new Reminders({ dir, jobs: () => jobs, push: async (title, body, url) => { sent.push({ title, body, url }) }, now: () => clock.t })
  return { r, clock, sent, dir }
}

test('fires once, an hour before by default, with the home-zone time and a link to the job', async () => {
  const { r, clock, sent } = setup([job('J-1', DUE, { key: 'ACME-512' })])
  clock.t = DUE - 61 * MIN; assert.deepEqual(await r.tick(), [])
  clock.t = DUE - 60 * MIN; assert.deepEqual(await r.tick(), ['J-1@2026-10-01T15:00:00.000Z'])
  clock.t = DUE - 59 * MIN; assert.deepEqual(await r.tick(), [])
  assert.deepEqual(sent, [{ title: 'Prep J-1: due 12:00', body: 'J-1 · ACME-512', url: '/?job=J-1' }])
})

test('a restart remembers what was sent; a moved due date reminds again', async () => {
  const jobs = [job('J-1', DUE)], a = setup(jobs)
  a.clock.t = DUE - 30 * MIN; await a.r.tick()
  const b = setup(jobs, a.dir)
  b.clock.t = DUE - 20 * MIN; assert.deepEqual(await b.r.tick(), [])
  jobs[0] = { ...jobs[0], due: new Date(DUE + 120 * MIN).toISOString() }
  b.clock.t = DUE + 60 * MIN; assert.deepEqual(await b.r.tick(), ['J-1@2026-10-01T17:00:00.000Z'])
  assert.equal(b.sent[0].title, 'Prep J-1: due 14:00')
})

test('stale, closed and undated jobs stay quiet; remind 0 still has its hour after the due time', async () => {
  const now = DUE
  const { r, clock, sent } = setup([
    job('J-old', now - 2 * 60 * MIN), job('J-done', now, { st: 'done' }), job('J-none', now, { due: undefined }),
    job('J-zero', now - 30 * MIN, { remind: 0 }), job('J-15', now + 20 * MIN, { remind: 15 }), job('J-day', now + 20 * 60 * MIN, { remind: 1440 }),
  ])
  clock.t = now
  assert.deepEqual((await r.tick()).map((k) => k.split('@')[0]), ['J-zero', 'J-day'])
  clock.t = now + 5 * MIN
  assert.deepEqual((await r.tick()).map((k) => k.split('@')[0]), ['J-15'])
  assert.equal(sent.length, 3)
})

test('entries older than 40 days are pruned from reminded.json', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wc-rem-')), now = DUE
  writeFileSync(join(dir, 'reminded.json'), JSON.stringify({ 'J-9@old': now - 41 * 86400e3, 'J-8@recent': now - 86400e3 }))
  const { r, clock } = setup([], dir)
  clock.t = now; await r.tick()
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, 'reminded.json'), 'utf8'))), ['J-8@recent'])
})

test('started, the loop ticks on its own until stopped', async () => {
  const sent: string[] = [], dir = mkdtempSync(join(tmpdir(), 'wc-rem-'))
  const r = new Reminders({ dir, jobs: () => [job('J-1', DUE)], push: async (t) => { sent.push(t) }, now: () => DUE - 10 * MIN, every: 5 }).start()
  try {
    const t0 = Date.now()
    while (!sent.length) { if (Date.now() - t0 > 2000) throw new Error('no tick'); await new Promise((ok) => setTimeout(ok, 5)) }
  } finally { r.stop() }
  assert.deepEqual(sent, ['Prep J-1: due 12:00'])
})
