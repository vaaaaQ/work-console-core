import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import * as T from '../../src/model/transitions.ts'
import type { Cmd, Flow, Job, Start } from '../../src/model/types.ts'
import { Bus } from '../events.ts'
import { Blockers } from '../jobs/blockers.ts'
import { Jobs } from '../jobs/jobs.ts'
import { fileStore } from '../store/file.ts'
import { demoCtx, demoSeed, fakeSdk } from '../testkit.ts'
import { autoAsk, holdOf, madeCurrent, startOf } from './autoAsk.ts'
import { Runner } from './runner.ts'
import { tempDir } from '../testdirs.ts'

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
  const dir = tempDir('auto')
  const store = fileStore(join(dir, 's.json'), demoSeed)
  const bus = new Bus(), jobs = new Jobs({ store, bus, ctx: demoCtx, gate: () => true })
  const { sdk, sessions } = fakeSdk()
  const runner = new Runner({ store, jobs, bus, sdk, cwd: dir, gate: () => true, artifactsDir: join(dir, 'arts'), ctx: demoCtx })
  const off = autoAsk({ jobs, runner, ctx: demoCtx, on: true, delay })
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

test('madeCurrent counts a blockerClosed that turned the step current', () => {
  const at = (s: string) => ({ flow: { tr: { s } } }) as unknown as Job
  const c: Cmd = { op: 'blockerClosed', step: 'tr', j: 'J-2', st: 'done' }
  assert.deepEqual(madeCurrent(c, at('wait'), at('cur')), ['tr'])
  assert.deepEqual(madeCurrent(c, at('wait'), at('wait')), [])
  assert.deepEqual(madeCurrent(c, at('cur'), at('cur')), [])
})

test('a woken llm step is asked; a woken you step is not', async () => {
  const store = fileStore(join(tempDir('aab'), 's.json'), demoSeed)
  const jobs = new Jobs({ store, bus: new Bus(), ctx: demoCtx, gate: () => true }), asked: string[] = []
  const off = autoAsk({ jobs, runner: { ask: async (_id: string, sid: string) => { asked.push(sid) } } as unknown as Runner, ctx: demoCtx, on: true, delay: 0 })
  const mk = async (t: string) => { const j = await jobs.create({ t, key: 'NEW', pb: 'action', prj: 'p', ws: 'acme' }); return (await jobs.cmd(j.id, { op: 'start' }, j.v)).job }
  const a = await mk('waits on tr'), c = await mk('waits on sn'), b = await mk('blocker')
  await jobs.cmd(a.id, { op: 'waitAdd', step: 'tr', j: b.id })
  await jobs.cmd(c.id, { op: 'waitAdd', step: 'sn', j: b.id })
  await jobs.cmd(c.id, { op: 'stepDone', step: 'tr' }); await jobs.cmd(c.id, { op: 'stepDone', step: 'dr' })
  asked.length = 0
  await jobs.cmd(a.id, { op: 'blockerClosed', step: 'tr', j: b.id, st: 'done' }, undefined, 'console')
  await jobs.cmd(c.id, { op: 'blockerClosed', step: 'sn', j: b.id, st: 'done' }, undefined, 'console')
  await new Promise((r) => setTimeout(r, 30))
  off()
  assert.deepEqual(asked, ['tr'])
})

test('a drafted waiter whose blocker closes: one goes-on push, the note clears, and its session revises the draft with the outcome', async () => {
  const dir = tempDir('wake')
  const store = fileStore(join(dir, 's.json'), demoSeed), bus = new Bus()
  const jobs = new Jobs({ store, bus, ctx: demoCtx, gate: () => true })
  const { sdk, sessions } = fakeSdk()
  const runner = new Runner({ store, jobs, bus, sdk, cwd: dir, gate: () => true, artifactsDir: join(dir, 'arts'), ctx: demoCtx })
  const off = autoAsk({ jobs, runner, ctx: demoCtx, on: true, delay: 0 })
  const pushes: string[] = [], generic: string[] = []
  const blockers = new Blockers({ jobs, ctx: demoCtx, push: async (t) => { pushes.push(t) } })
  jobs.onNeedsYou((j) => { if (!blockers.handling(j.id)) generic.push(j.id) })
  const get = async (id: string) => (await jobs.get(id))!

  // the waiter's first step gets a draft, then a reply asks for a blocker
  const a0 = await jobs.create({ t: 'Local stand', key: 'K-1', pb: 'action', prj: 'p', ws: 'acme' })
  await jobs.cmd(a0.id, { op: 'start' }, a0.v)
  await until(() => sessions.length === 1)
  sessions[0].push({ k: 'session', id: 'S1' })
  await sessions[0].tools.submitDraft('v1'); sessions[0].end()
  await until(async () => (await runner.all()).every((r) => r.ended))
  const b = await jobs.create({ t: 'Ask Imre', key: 'NEW', pb: 'action', prj: 'p', ws: 'acme' })
  const rr = await runner.reply(a0.id, 'tr', 'wait for Imre to confirm the secret', 'revise')
  await until(() => sessions.length === 2)
  await sessions[1].tools.openBlocker!('wait for Imre to confirm the secret'); sessions[1].end()
  await until(async () => (await runner.get(rr.id))?.ended != null)
  await jobs.cmd(a0.id, { op: 'waitAdd', step: 'tr', j: b.id, plan: 'if he confirms, keep kv-1' })

  let a = await get(a0.id)
  assert.equal(a.flow.tr.s, 'wait'); assert.equal(a.flow.tr.dr!.t, 'v1'); assert.equal(a.flow.tr.m, `waits for ${b.id}`)
  assert.equal(a.st, 'waiting-external'); assert.equal(T.needsYou(X, a), false)

  generic.length = 0
  await jobs.cmd(b.id, { op: 'close', st: 'done', note: 'Imre confirmed kv-1' })
  await until(() => sessions.length === 3)
  a = await get(a0.id)
  const line = a.jr.find((e) => e.o === `Blocker ${b.id} of “Understand the request” is done.`)!
  assert.equal(line.a, 'console'); assert.equal(line.c, 'outcome: Imre confirmed kv-1')
  assert.deepEqual(pushes, [`${a0.id} goes on`])
  assert.doesNotMatch(a.flow.tr.m, /waits for/)
  assert.deepEqual(generic, [])
  const rev = (await runner.all()).find((r) => r.parent && r.via === 'console')!
  assert.equal(rev.intent, 'revise'); assert.match(rev.q, /Outcome: Imre confirmed kv-1/); assert.match(rev.q, /Plan: if he confirms, keep kv-1/)
  assert.equal(sessions[2].resume, 'S1'); assert.match(sessions[2].prompt, /Imre confirmed kv-1/)
  assert.equal(a.jr[0].a, 'console'); assert.match(a.jr[0].o, /^Replied to the LLM draft/)

  await sessions[2].tools.submitDraft('v2'); sessions[2].end()
  await until(async () => (await get(a0.id)).flow.tr.dr?.t === 'v2')
  assert.equal((await get(a0.id)).st, 'waiting-user')
  assert.deepEqual(pushes, [`${a0.id} goes on`])
  off(); blockers.stop()
})

/* ===== start modes ===== */
function modes(on: boolean, delay = 0) {
  const dir = tempDir('start')
  const store = fileStore(join(dir, 's.json'), demoSeed)
  const bus = new Bus(), jobs = new Jobs({ store, bus, ctx: demoCtx, gate: () => true })
  const { sdk, sessions } = fakeSdk()
  const runner = new Runner({ store, jobs, bus, sdk, cwd: dir, gate: () => true, artifactsDir: join(dir, 'arts'), ctx: demoCtx })
  const off = autoAsk({ jobs, runner, ctx: demoCtx, on, delay })
  /** step changes come as a proposal the person accepts */
  const change = async (id: string, cmds: Cmd[]) => {
    await jobs.cmd(id, { op: 'ppSet', say: 'from the daily', cmds, by: 'c1' }, undefined, 'console')
    return (await jobs.cmd(id, { op: 'ppAccept' })).job
  }
  /** a fresh action job whose tr starts as given; tr and dr are llm, sn is yours */
  const job = async (start?: Start) => {
    const j = await jobs.create({ t: 'Reply to the mail', key: 'K-1', pb: 'action', prj: 'p', ws: 'acme' })
    return start ? change(j.id, [{ op: 'stepEdit', step: 'tr', start }]) : j
  }
  return { jobs, runner, sessions, off, job, change, get: async (id: string) => (await jobs.get(id))! }
}

test('startOf: a step of its own start keeps it; one without follows the workspace; a you step has none', () => {
  const s = (m: 'you' | 'llm', start?: Start) => ({ id: 'a', t: 'a', m, x: 'a', ...(start ? { start } : {}) })
  assert.equal(startOf(s('llm'), true), 'self')
  assert.equal(startOf(s('llm'), false), 'hand')
  assert.equal(startOf(s('llm', 'hand'), true), 'hand')
  assert.equal(startOf(s('llm', 'auto'), false), 'auto')
  assert.equal(startOf(s('you'), true), null)
  assert.equal(startOf(undefined, true), null)
})

test('a hand step asks nothing, a self step asks, whatever the workspace says', async () => {
  const a = modes(true), h = await a.job('hand')
  await a.jobs.cmd(h.id, { op: 'start' }, h.v)
  await tick(60)
  assert.equal(a.sessions.length, 0)
  a.off()
  const b = modes(false), s = await b.job('self')
  await b.jobs.cmd(s.id, { op: 'start' }, s.v)
  await until(() => b.sessions.length === 1)
  b.off()
})

test('without autoAsk a playbook llm step asks nothing; an added step with start self asks', async () => {
  const s = modes(false), j = await s.job()
  await s.jobs.cmd(j.id, { op: 'start' }, j.v)
  await tick(60)
  assert.equal(s.sessions.length, 0)
  await s.change(j.id, [{ op: 'stepAdd', before: 'tr', step: { t: 'Look at the logs', m: 'llm', start: 'self' } }])
  await until(() => s.sessions.length === 1)
  assert.equal((await s.runner.all())[0].step, 'n1')
  s.off()
})

test('a step added in front of the current one, alone or in an accepted proposal, is made current', () => {
  let j = T.apply(X, T.freshJob(X, 'A-1', { t: 'Reply', key: 'K-1', pb: 'action', prj: 'p', ws: 'acme' }), start).job
  const add: Cmd = { op: 'stepAdd', before: 'tr', step: { t: 'Look', m: 'llm' } }
  assert.deepEqual(madeCurrent(add, j, T.apply(X, j, add).job), ['n1'])
  const cx = { ...X, by: 'console' }
  j = T.apply(cx, j, { op: 'ppSet', say: 'look first', cmds: [add], by: 'c1' }).job
  const acc: Cmd = { op: 'ppAccept' }
  assert.deepEqual(madeCurrent(acc, j, T.apply(X, j, acc).job), ['n1'])
})

test('an auto step\'s clean draft is accepted by the console, journaled automatically', async () => {
  const s = modes(true), j = await s.job('auto')
  await s.jobs.cmd(j.id, { op: 'start' }, (await s.get(j.id)).v)
  await until(() => s.sessions.length === 1)
  await s.sessions[0].tools.submitDraft('clear'); s.sessions[0].end()
  await until(async () => (await s.get(j.id)).flow.tr.s === 'done')
  const line = (await s.get(j.id)).jr.find((e) => e.o.startsWith('Accepted the LLM draft'))!
  assert.equal(line.o, 'Accepted the LLM draft for “Understand the request” automatically.')
  assert.equal(line.a, 'console')
  await until(() => s.sessions.length === 2)
  s.off()
})

test('an auto step\'s draft with an open question is held back and journaled', async () => {
  const s = modes(false), j = await s.job('auto')
  await s.jobs.cmd(j.id, { op: 'start' }, (await s.get(j.id)).v)
  await until(() => s.sessions.length === 1)
  await s.jobs.cmd(j.id, { op: 'noteAdd', step: 'tr', k: 'q', t: 'which mailbox?' })
  await s.sessions[0].tools.submitDraft('maybe'); s.sessions[0].end()
  await until(async () => (await s.get(j.id)).jr[0].o.startsWith('Held back'))
  const a = await s.get(j.id)
  assert.equal(a.jr[0].o, 'Held back the automatic accept of “Understand the request”: an open question.')
  assert.equal(a.jr[0].a, 'console')
  assert.equal(a.flow.tr.s, 'wait'); assert.ok(a.flow.tr.dr)
  s.off()
})

test('holdOf names what keeps a draft from being accepted by itself', () => {
  const f = (o: Partial<Flow>) => ({ s: 'wait', m: '', arts: [], b: [], rv: null, dr: { t: 'd', at: '' }, out: null, run: null, sent: {}, ...o }) as Flow
  assert.equal(holdOf(f({})), null)
  assert.equal(holdOf(f({ b: [{ k: 'q', t: 'x', r: 'y', o: 0 }] })), null)
  assert.equal(holdOf(f({ b: [{ k: 'p', t: 'x', r: '', o: 1 }] })), 'a problem note')
  assert.equal(holdOf(f({ bb: { say: 'wait for Imre', at: '' } })), 'a blocker asked for')
  assert.equal(holdOf(f({ w: [{ j: 'J-2', st: 'open', at: '' }] as Flow['w'] })), 'open blockers')
})

test('a failed auto run accepts nothing', async () => {
  const s = modes(true), j = await s.job('auto')
  await s.jobs.cmd(j.id, { op: 'start' }, (await s.get(j.id)).v)
  await until(() => s.sessions.length === 1)
  s.sessions[0].end()
  await until(async () => (await s.runner.all()).every((r) => r.ended))
  await tick(60)
  const a = await s.get(j.id)
  assert.equal(a.flow.tr.s, 'cur')
  assert.ok(!a.jr.some((e) => e.o.startsWith('Accepted the LLM draft') || e.o.startsWith('Held back')))
  s.off()
})
