import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ActReq, ActRes, ConceptReply } from '../bridge/wire.ts'
import { Bus, HttpError } from '../events.ts'
import { Jobs } from '../jobs/jobs.ts'
import { fileStore } from '../store/file.ts'
import { demoCtx, demoSeed } from '../testkit.ts'
import { startItem } from './start.ts'

function setup(o: { act?: ActRes; board?: ConceptReply; up?: boolean } = {}) {
  const store = fileStore(join(mkdtempSync(join(tmpdir(), 'wc-start-')), 's.json'), demoSeed)
  const jobs = new Jobs({ store, bus: new Bus(), ctx: demoCtx, gate: () => true })
  const acts: ActReq[] = []
  const bridge = {
    available: () => o.up ?? true,
    act: async (a: ActReq) => { acts.push(a); return o.act ?? { status: 'ok' as const, result: { id: a.args.id, type: 'Bug', title: 'Grid export ignores the filter', state: 'In Progress' } } },
    read: async () => ({ board: o.board ?? { status: 'ok', items: [{ id: 'ACME-631', title: 'From the board' }] } }),
  }
  return { jobs, acts, start: startItem({ jobs, ctx: demoCtx, bridge }) }
}

test('an item with an open job: A starts it and the job is returned as is', async () => {
  const s = setup(), before = await s.jobs.get('J-0412')
  const r = await s.start('ACME-512')
  assert.equal(r.created, false)
  assert.equal(r.job.id, 'J-0412'); assert.equal(r.job.v, before!.v)
  assert.deepEqual(s.acts.map((a) => [a.action, a.args]), [['work.start', { id: 'ACME-512' }]])
})

test('an item without an open job: a dev-item job is created and started', async () => {
  const s = setup(), n = (await s.jobs.all()).length
  const r = await s.start('ACME-603', undefined, 'session')
  assert.equal(r.created, true)
  assert.equal((await s.jobs.all()).length, n + 1)
  assert.equal(r.job.key, 'ACME-603'); assert.equal(r.job.t, 'Grid export ignores the filter')
  assert.equal(r.job.pb, 'dev-item'); assert.equal(r.job.prj, 'platform'); assert.equal(r.job.ws, 'acme')
  assert.equal(r.job.st, 'active')
  assert.match(r.job.jr[0].a, /Claude Code/)
  // a done job for the key is not reused
  const again = await s.start('ACME-480')
  assert.equal(again.created, true); assert.notEqual(again.job.id, 'J-0398')
})

test('two Starts on one item at once make one job', async () => {
  const s = setup(), n = (await s.jobs.all()).length
  const [a, b] = await Promise.all([s.start('ACME-603'), s.start(' ACME-603 ', undefined, 'session')])
  assert.equal((await s.jobs.all()).length, n + 1)
  assert.deepEqual([a.created, b.created], [true, false])
  assert.equal(b.job.id, a.job.id)
})

test('without a title from A the board names the job, then the key', async () => {
  const s = setup({ act: { status: 'ok' } })
  assert.equal((await s.start('ACME-631')).job.t, 'From the board')
  assert.equal((await s.start('ACME-632')).job.t, 'ACME-632')
})

test("A's refusal, a bad key, an unknown playbook and a missing bridge change nothing", async () => {
  const refused = setup({ act: { status: 'error', error: { code: 'source_error', message: 'tracker: bad_args: ACME-620 is assigned to Anna' } } })
  const n = (await refused.jobs.all()).length
  await assert.rejects(refused.start('ACME-620'), (e: unknown) => e instanceof HttpError && e.status === 400 && e.code === 'refused' && e.message === 'ACME-620 is assigned to Anna')
  assert.equal((await refused.jobs.all()).length, n)
  const unknown = setup({ act: { status: 'outcome_unknown', error: { code: 'outcome_unknown', message: 'tracker: the write may or may not have landed' } } })
  await assert.rejects(unknown.start('ACME-603'), (e: unknown) => e instanceof HttpError && e.status === 502 && e.code === 'outcome_unknown')
  const s = setup()
  await assert.rejects(s.start('bad key!'), (e: unknown) => e instanceof HttpError && e.code === 'bad_args')
  await assert.rejects(s.start('ACME-603', 'no-such-playbook'), (e: unknown) => e instanceof HttpError && /no playbook/.test(e.message))
  assert.equal(s.acts.length, 0)
  await assert.rejects(setup({ up: false }).start('ACME-603'), (e: unknown) => e instanceof HttpError && e.status === 503)
})

test("an input the board rule does not accept is refused; a key is accepted", async () => {
  const s = setup(), n = (await s.jobs.all()).length
  for (const bad of ['acme-603', 'ACME603', '603', 'ACME-', 'ACME 603', '']) {
    await assert.rejects(s.start(bad), (e: unknown) => e instanceof HttpError && e.status === 400 && e.code === 'bad_args' && e.message === `${bad} is not a board item key`)
  }
  assert.equal(s.acts.length, 0); assert.equal((await s.jobs.all()).length, n)
  const r = await s.start('ACME-603')
  assert.equal(r.created, true); assert.equal(r.job.key, 'ACME-603')
  assert.deepEqual(s.acts.map((a) => a.args), [{ id: 'ACME-603' }])
})

test("an item key is at most 64 characters, counted after trimming", async () => {
  const s = setup(), n = (await s.jobs.all()).length
  const long = 'A-' + '1'.repeat(63), edge = 'A-' + '1'.repeat(62)
  assert.equal(long.length, 65); assert.equal(edge.length, 64)
  await assert.rejects(s.start(long), (e: unknown) => e instanceof HttpError && e.status === 400 && e.code === 'bad_args' && e.message === `${long} is not a board item key`)
  assert.equal(s.acts.length, 0); assert.equal((await s.jobs.all()).length, n)
  const r = await s.start(`  ${edge} `)
  assert.equal(r.created, true); assert.equal(r.job.key, edge)
  assert.deepEqual(s.acts.map((a) => a.args), [{ id: edge }])
})
