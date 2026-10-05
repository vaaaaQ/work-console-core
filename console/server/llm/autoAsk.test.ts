import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as T from '../../src/model/transitions.ts'
import type { Cmd } from '../../src/model/types.ts'
import { Bus } from '../events.ts'
import { Jobs } from '../jobs/jobs.ts'
import { fileStore } from '../store/file.ts'
import { demoCtx, demoSeed, fakeSdk } from '../testkit.ts'
import { autoAsk, madeCurrent } from './autoAsk.ts'
import { Runner } from './runner.ts'

const X = demoCtx()
/** the steps the last of these commands made current, on a fresh action job: tr and dr are llm, sn is yours */
function made(...cmds: Cmd[]) {
  let job = T.freshJob(X, 'A-1', { t: 'Reply to the mail', key: 'K-1', pb: 'action', prj: 'p', ws: 'acme' }), prev = job
  for (const c of cmds) { prev = job; job = T.apply(X, job, c).job }
  return madeCurrent(cmds.at(-1)!, prev, job)
}
const start: Cmd = { op: 'start' }
const draft: Cmd[] = [{ op: 'runStart', step: 'tr', q: 'q', id: 'r1' }, { op: 'runDraft', step: 'tr', t: 'the draft' }]

test('the changes that move a job onto a step make it current: Start, Mark done, Skip, accepting a draft, Return to', () => {
  assert.deepEqual(made(start), ['tr'])
  assert.deepEqual(made(start, { op: 'stepDone', step: 'tr' }), ['dr'])
  assert.deepEqual(made(start, { op: 'stepSkip', step: 'tr' }), ['dr'])
  assert.deepEqual(made(start, ...draft, { op: 'acceptDraft', step: 'tr' }), ['dr'])
  assert.deepEqual(made(start, { op: 'stepDone', step: 'tr' }, { op: 'returnTo', step: 'tr', why: 'the request changed' }), ['tr'])
})

test('a step that stays or comes back current is not made current: Reject, run end, Reopen step, Resume, job reopen, a new period', () => {
  assert.deepEqual(made(start, ...draft, { op: 'rejectDraft', step: 'tr' }), [])
  assert.deepEqual(made(start, { op: 'runStart', step: 'tr', q: 'q', id: 'r1' }, { op: 'runEnd', step: 'tr', why: 'cancelled' }), [])
  assert.deepEqual(made(start, { op: 'stepDone', step: 'tr' }, { op: 'stepReopen', step: 'tr' }), [])
  assert.deepEqual(made(start, { op: 'stepWait', step: 'tr', m: 'asked' }, { op: 'stepResume', step: 'tr' }), [])
  assert.deepEqual(made(start, { op: 'stepSkip', step: 'tr' }, { op: 'close', st: 'cancelled' }, { op: 'reopen' }), [])
  const monthly: Cmd = { op: 'schedule', due: '2026-11-02T12:00:00.000Z', every: 'month' }
  assert.deepEqual(made(monthly), [], 'a repeat that makes the job recurring')
  const wrap = [start, monthly, { op: 'stepDone', step: 'tr' }, { op: 'stepDone', step: 'dr' }, { op: 'stepDone', step: 'sn' }] as Cmd[]
  assert.deepEqual(made(...wrap), [], 'the new period starts tr again from done')
})

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))
async function until(f: () => boolean | Promise<boolean>) { const t0 = Date.now(); while (!(await f())) { if (Date.now() - t0 > 2000) throw new Error('timed out'); await tick() } }

function setup(delay = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'wc-auto-'))
  const store = fileStore(join(dir, 's.json'), demoSeed)
  const bus = new Bus(), jobs = new Jobs({ store, bus, ctx: demoCtx, gate: () => true })
  const { sdk, sessions } = fakeSdk()
  const runner = new Runner({ store, jobs, bus, sdk, cwd: dir, gate: () => true, artifactsDir: join(dir, 'arts'), ctx: demoCtx })
  const off = autoAsk({ jobs, runner, ctx: demoCtx, delay })
  const job = () => jobs.create({ t: 'Reply to the mail', key: 'K-1', pb: 'action', prj: 'p', ws: 'acme' })
  const on = async (id: string, step: string) => (await runner.all()).filter((r) => r.job === id && r.step === step)
  return { jobs, runner, sessions, off, job, on }
}

test('Start asks the first step in its own words, signed console; accepting its draft asks the next; a step of yours asks nothing', async () => {
  const s = setup(), j = await s.job()
  await s.jobs.cmd(j.id, { op: 'start' }, j.v)
  await until(() => s.sessions.length === 1)
  const [r] = await s.on(j.id, 'tr')
  assert.equal(r.q, T.askText(T.stepOf(X, j, 'tr')!))
  const line = (await s.jobs.get(j.id))!.jr[0]
  assert.deepEqual([line.a, line.o, line.c], ['console', 'Asked the LLM for “Understand the request”.', 'LLM run started by itself.'])
  await s.sessions[0].tools.submitDraft('clear'); s.sessions[0].end()
  await until(async () => !!(await s.jobs.get(j.id))!.flow.tr.dr)
  await s.jobs.cmd(j.id, { op: 'acceptDraft', step: 'tr' }, (await s.jobs.get(j.id))!.v)
  await until(() => s.sessions.length === 2)
  assert.equal((await s.on(j.id, 'dr')).length, 1)
  await s.sessions[1].tools.submitDraft('the answer'); s.sessions[1].end()
  await until(async () => !!(await s.jobs.get(j.id))!.flow.dr.dr)
  await s.jobs.cmd(j.id, { op: 'acceptDraft', step: 'dr' }, (await s.jobs.get(j.id))!.v)
  await tick(60)
  assert.equal((await s.jobs.get(j.id))!.flow.sn.s, 'cur')
  assert.equal(s.sessions.length, 2)
  s.off()
})

test('Mark done asks the next step; a cancelled run is not asked again; Return to from a session asks the step it returns to', async () => {
  const s = setup(), j = await s.job()
  await s.jobs.cmd(j.id, { op: 'start' }, j.v)
  await until(() => s.sessions.length === 1)
  await s.runner.cancel((await s.on(j.id, 'tr'))[0].id)
  await tick(60)
  assert.equal(s.sessions.length, 1)
  await s.jobs.cmd(j.id, { op: 'stepDone', step: 'tr' }, (await s.jobs.get(j.id))!.v)
  await until(() => s.sessions.length === 2)
  await s.runner.cancel((await s.on(j.id, 'dr'))[0].id)
  await s.jobs.cmd(j.id, { op: 'returnTo', step: 'tr', why: 'the request changed' }, undefined, 'session')
  await until(() => s.sessions.length === 3)
  assert.equal((await s.on(j.id, 'tr')).length, 2)
  s.off()
})

test('a change an LLM run makes asks nothing: a job it creates and starts gets no run', async () => {
  const s = setup(), j = await s.jobs.create({ t: 'Found along the way', key: '', pb: 'action', prj: 'p', ws: 'acme', src: 'J-0001' }, 'run')
  await s.jobs.cmd(j.id, { op: 'start' }, undefined, 'run')
  await tick(60)
  assert.equal((await s.jobs.get(j.id))!.flow.tr.s, 'cur')
  assert.deepEqual(await s.runner.all(), [])
  s.off()
})

test('Undo inside the wait leaves no run, and off() drops an ask still waiting', async () => {
  const s = setup(100), j = await s.job()
  const r = await s.jobs.cmd(j.id, { op: 'start' }, j.v)
  await s.jobs.undo(j.id, r.job.v!, r.prev)
  await tick(200)
  assert.equal((await s.jobs.get(j.id))!.st, 'ready')
  assert.deepEqual(await s.runner.all(), [])
  await s.jobs.cmd(j.id, { op: 'start' }, (await s.jobs.get(j.id))!.v)
  s.off()
  await tick(200)
  assert.deepEqual(await s.runner.all(), [])
})

test('an ask by hand during the wait, or closing the job, means no run of its own', async () => {
  const s = setup(100), a = await s.job(), b = await s.job()
  await s.jobs.cmd(a.id, { op: 'start' }, a.v)
  await s.runner.ask(a.id, 'tr', 'mine')
  const sb = await s.jobs.cmd(b.id, { op: 'start' }, b.v)
  await s.jobs.cmd(b.id, { op: 'close', st: 'cancelled' }, sb.job.v)
  await tick(250)
  assert.deepEqual((await s.runner.all()).map((r) => [r.job, r.q]), [[a.id, 'mine']])
  s.off()
})
