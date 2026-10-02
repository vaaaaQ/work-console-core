import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { demoSeed, demoCtx } from '../testkit.ts'
import * as T from '../../src/model/transitions.ts'
import { Bus, HttpError } from '../events.ts'
import type { Ev } from '../events.ts'
import { fileStore } from '../store/file.ts'
import { Jobs } from './jobs.ts'

function setup(open = { v: true }) {
  const store = fileStore(join(mkdtempSync(join(tmpdir(), 'wc-jobs-')), 's.json'), demoSeed)
  const bus = new Bus(), evs: Ev[] = []
  bus.on((e) => evs.push(e))
  const jobs = new Jobs({ store, bus, ctx: demoCtx, gate: () => open.v })
  return { store, bus, evs, jobs, open }
}
const code = (status: number, c?: string) => (e: unknown) => e instanceof HttpError && e.status === status && (!c || e.code === c)
async function openJob(jobs: Jobs) {
  const x = demoCtx()
  return (await jobs.all()).find((j) => !T.isClosed(j) && j.st !== 'recurring' && j.st !== 'draft' && !!T.atOf(x, j))!
}

test('a command applies, bumps v and emits the job', async () => {
  const { jobs, evs } = setup(), j = await openJob(jobs), at = T.atOf(demoCtx(), j)!
  const r = await jobs.cmd(j.id, { op: 'stepDone', step: at }, j.v)
  assert.equal(r.job.v, j.v! + 1)
  assert.equal(r.job.flow[at].s, 'done')
  assert.equal(r.prev.v, j.v)
  assert.equal(evs.at(-1)!.kind, 'job')
})

test('a command on a stale version is 409 and changes nothing', async () => {
  const { jobs } = setup(), j = await openJob(jobs), at = T.atOf(demoCtx(), j)!
  await jobs.cmd(j.id, { op: 'noteAdd', step: at, k: 'q', t: 'from the phone' }, j.v)
  await assert.rejects(jobs.cmd(j.id, { op: 'stepDone', step: at }, j.v), code(409, 'conflict'))
  assert.equal((await jobs.get(j.id))!.flow[at].s === 'done', false)
})

test('undo at the right version puts prev back with a new v', async () => {
  const { jobs } = setup(), j = await openJob(jobs), at = T.atOf(demoCtx(), j)!
  const r = await jobs.cmd(j.id, { op: 'stepDone', step: at }, j.v)
  const u = await jobs.undo(j.id, r.job.v!, r.prev)
  assert.equal(u.v, r.job.v! + 1)
  assert.equal(u.flow[at].s, j.flow[at].s)
})

test('undo after someone else changed the job is 409, not a rollback of their change', async () => {
  const { jobs } = setup(), j = await openJob(jobs), at = T.atOf(demoCtx(), j)!
  const r = await jobs.cmd(j.id, { op: 'noteAdd', step: at, k: 'q', t: 'mine' }, j.v)
  await jobs.cmd(j.id, { op: 'noteAdd', step: at, k: 'q', t: 'theirs' }, r.job.v)
  await assert.rejects(jobs.undo(j.id, r.job.v!, r.prev), code(409))
  assert.ok((await jobs.get(j.id))!.flow[at].b.some((b) => b.t === 'theirs'))
})

test('with the bridge down, page commands, creates and undos are 503; runner commands still land', async () => {
  const { jobs, open } = setup(), j = await openJob(jobs), at = T.atOf(demoCtx(), j)!
  open.v = false
  await assert.rejects(jobs.cmd(j.id, { op: 'stepDone', step: at }, j.v), code(503))
  await assert.rejects(jobs.create({ t: 'x', key: 'K', pb: 'action', prj: 'p', ws: 'acme' }), code(503))
  const r = await jobs.cmd(j.id, { op: 'runStart', step: at, q: 'q', id: 'r1' }, undefined, 'runner')
  assert.equal(r.job.flow[at].run!.id, 'r1')
})

test('the page cannot send runner commands; bad steps are 400', async () => {
  const { jobs } = setup(), j = await openJob(jobs)
  await assert.rejects(jobs.cmd(j.id, { op: 'runDraft', step: 'x', t: 'forged' }, j.v), code(400, 'bad_args'))
  await assert.rejects(jobs.cmd(j.id, { op: 'stepDone', step: 'nope' }, j.v), code(400, 'bad_step'))
  await assert.rejects(jobs.cmd('J-9999', { op: 'start' }), code(404))
})

test('the console may tick a step, record an artifact and a journal line, and nothing else of the page', async () => {
  const { jobs } = setup(), j = await openJob(jobs), at = T.atOf(demoCtx(), j)!
  const a = await jobs.cmd(j.id, { op: 'artifact', step: at, n: 'out.pdf', link: '/api/artifacts/x/out.pdf' }, undefined, 'console')
  assert.equal(a.job.flow[at].arts.find((x) => x.n === 'out.pdf')!.ok, true)
  const m = await jobs.cmd(j.id, { op: 'artifact', step: at, n: 'out.pdf', ok: false }, undefined, 'console')
  assert.equal(m.job.flow[at].arts.find((x) => x.n === 'out.pdf')!.ok, false)
  const l = await jobs.cmd(j.id, { op: 'journal', o: 'Console wrote a file.', c: '-', n: '-' }, undefined, 'console')
  assert.ok(l.job.jr.some((e) => e.o === 'Console wrote a file.'))
  const d = await jobs.cmd(j.id, { op: 'stepDone', step: at }, undefined, 'console')
  assert.equal(d.job.flow[at].s, 'done')
  await assert.rejects(jobs.cmd(j.id, { op: 'close', st: 'done' }, undefined, 'console'), code(400, 'bad_args'))
  await assert.rejects(jobs.cmd(j.id, { op: 'stepSkip', step: T.atOf(demoCtx(), d.job)! }, undefined, 'console'), code(400, 'bad_args'))
})

test('a runner command retries over a concurrent page change', async () => {
  const { jobs } = setup(), j = await openJob(jobs), at = T.atOf(demoCtx(), j)!
  const [a, b] = await Promise.all([
    jobs.cmd(j.id, { op: 'noteAdd', step: at, k: 'q', t: 'page' }, j.v),
    jobs.cmd(j.id, { op: 'journal', o: 'LLM read the item.', c: '-', n: '-' }, undefined, 'runner'),
  ])
  assert.ok(a.job.v && b.job.v)
  const now = (await jobs.get(j.id))!
  assert.ok(now.flow[at].b.some((x) => x.t === 'page'))
  assert.ok(now.jr.some((e) => e.o === 'LLM read the item.'))
})

test('a job that starts needing you fires once; create marks its mail', async () => {
  const { jobs, store } = setup(), seen: string[] = []
  jobs.onNeedsYou((j) => seen.push(j.id))
  const j = await jobs.create({ t: 'From mail', key: 'K-9', pb: 'action', prj: 'p', ws: 'acme', mail: 'm2' })
  assert.equal(j.st, 'ready')
  assert.deepEqual(seen, [j.id])
  assert.deepEqual((await store.marks()).m2, { done: true, job: j.id })
  await jobs.cmd(j.id, { op: 'noteAdd', step: T.atOf(demoCtx(), j)!, k: 'q', t: 'still needs you' }, j.v)
  assert.deepEqual(seen, [j.id])
})
