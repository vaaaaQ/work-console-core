import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as T from '../../src/model/transitions.ts'
import type { Cmd, DraftReport, Flow, Job, Playbook, Start } from '../../src/model/types.ts'
import { Bus } from '../events.ts'
import { Blockers } from '../jobs/blockers.ts'
import { Jobs } from '../jobs/jobs.ts'
import { fileStore } from '../store/file.ts'
import { demoCtx, demoSeed, fakeSdk } from '../testkit.ts'
import { answeredText, autoAsk, freedDraft, holdOf, madeCurrent, startOf } from './autoAsk.ts'
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
  assert.deepEqual(made(start, { op: 'stepDone', step: 'tr' }, { op: 'stepReopen', step: 'tr' }), ['tr'], 'reopening a passed step with a later one reached is a return')
})

test('a review moves the job: Accept onto the next step like Mark done, Send back onto the step it returns to', () => {
  const rv: Cmd[] = [start, { op: 'stepEdit', step: 'dr', fx: ['review'] }, { op: 'stepDone', step: 'tr' }]
  assert.deepEqual(made(...rv, { op: 'review', step: 'dr', verdict: 'accepted' }), ['sn'])
  assert.deepEqual(made(...rv, { op: 'review', step: 'dr', verdict: 'sent_back', note: 'redo it', to: 'tr' }), ['tr'])
})

test('a step that stays or comes back current is not made current: Reject, run end, Reopen step, Resume, job reopen, a new period', () => {
  assert.deepEqual(made(start, ...draft, { op: 'rejectDraft', step: 'tr' }), [])
  assert.deepEqual(made(start, { op: 'runStart', step: 'tr', q: 'q', id: 'r1' }, { op: 'runEnd', step: 'tr', why: 'cancelled' }), [])
  const allDone = [start, { op: 'stepDone', step: 'tr' }, { op: 'stepDone', step: 'dr' }, { op: 'stepDone', step: 'sn' }] as Cmd[]
  assert.deepEqual(made(...allDone, { op: 'stepReopen', step: 'sn' }), [], 'the last step reopened alone')
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

test('an auto step\'s draft with a question its own run asked is held back', async () => {
  const s = modes(false), j = await s.job('auto')
  await s.jobs.cmd(j.id, { op: 'start' }, (await s.get(j.id)).v)
  await until(() => s.sessions.length === 1)
  await s.sessions[0].tools.askQuestion!('Which mailbox?')
  await s.sessions[0].tools.submitDraft('as far as it goes'); s.sessions[0].end()
  await until(async () => (await s.get(j.id)).jr[0].o.startsWith('Held back'))
  assert.equal((await s.get(j.id)).jr[0].o, 'Held back the automatic accept of “Understand the request”: an open question.')
  s.off()
})

/** a started action job whose tr has a draft, no run, and these notes */
function asked(...notes: Cmd[]) {
  let j = T.apply(X, T.freshJob(X, 'A-1', { t: 'Reply', key: 'K-1', pb: 'action', prj: 'p', ws: 'acme' }), start).job
  for (const c of [{ op: 'runStart', step: 'tr', q: 'q', id: 'r1' } as Cmd, ...notes, { op: 'runDraft', step: 'tr', t: 'v1' } as Cmd]) j = T.apply(X, j, c).job
  return j
}
const after = (j: Job, c: Cmd) => freedDraft(c, j, T.apply({ ...X, jobOf: () => undefined }, j, c).job)
const q = (t: string): Cmd => ({ op: 'noteAdd', step: 'tr', k: 'q', t })

test('freedDraft: answering the last open question frees the draft; an earlier one, another kind of note, or an open blocker does not', () => {
  const two = asked(q('which mailbox?'), q('who signs?'), { op: 'noteAdd', step: 'tr', k: 'p', t: 'the gateway was down' })
  assert.equal(two.flow.tr.s, 'wait')
  assert.equal(after(two, { op: 'noteAnswer', step: 'tr', i: 0, r: 'the shared one' }), null, 'one question still open')
  const one = T.apply(X, two, { op: 'noteAnswer', step: 'tr', i: 0, r: 'the shared one' }).job
  assert.equal(after(one, { op: 'noteAnswer', step: 'tr', i: 1, r: 'Imre' }), 'tr')
  const none = T.apply(X, one, { op: 'noteAnswer', step: 'tr', i: 1, r: 'Imre' }).job
  assert.equal(after(none, { op: 'noteAnswer', step: 'tr', i: 2, r: 'it is back' }), null, 'a problem resolved is no answer the draft waited for')
  assert.equal(after(none, { op: 'noteAnswer', step: 'tr', i: 1, r: 'Imre, again' }), null, 'answering an answered question again')
  const blocked = { ...one, flow: { ...one.flow, tr: { ...one.flow.tr, w: [{ j: 'A-9', st: 'open' as const }] } } }
  assert.equal(after(blocked, { op: 'noteAnswer', step: 'tr', i: 1, r: 'Imre' }), null, 'a blocker still open')
})

test('freedDraft: a blocker that closes while a question is open frees nothing', () => {
  const j = asked(q('which mailbox?'))
  const w = { ...j, flow: { ...j.flow, tr: { ...j.flow.tr, w: [{ j: 'A-9', st: 'open' as const }] } } }
  assert.equal(after(w, { op: 'blockerClosed', step: 'tr', j: 'A-9', st: 'done' }), null)
  const answered = T.apply(X, w, { op: 'noteAnswer', step: 'tr', i: 0, r: 'the shared one' }).job
  assert.equal(after(answered, { op: 'blockerClosed', step: 'tr', j: 'A-9', st: 'done' }), 'tr')
})

test('answeredText lists each question with its answer', () => {
  const j = T.apply(X, asked(q('which mailbox?'), q('who signs?')), { op: 'noteAnswer', step: 'tr', i: 0, r: 'the shared one' }).job
  const k = T.apply(X, j, { op: 'noteAnswer', step: 'tr', i: 1, r: 'Imre' }).job
  assert.equal(answeredText(k.flow.tr), 'Every question this step asked has an answer:\n\n- which mailbox? → the shared one\n- who signs? → Imre\n\nGo on with the step from your draft, as the answers say.')
})

test('answering the last question a self step\'s run asked revises its draft in the same session; a hand step stays for the person', async () => {
  for (const start of ['self', 'hand'] as const) {
    const s = modes(true), j = await s.job(start)
    await s.jobs.cmd(j.id, { op: 'start' }, (await s.get(j.id)).v)
    // a hand step's run is asked by the person
    if (start === 'hand') await s.runner.ask(j.id, 'tr', 'go')
    await until(() => s.sessions.length === 1)
    s.sessions[0].push({ k: 'session', id: 'S1' })
    await s.sessions[0].tools.askQuestion!('Which mailbox?')
    await s.sessions[0].tools.askQuestion!('Who signs?')
    await s.sessions[0].tools.submitDraft('v1, as far as it goes'); s.sessions[0].end()
    await until(async () => (await s.runner.all()).every((r) => r.ended))
    const qs = (await s.get(j.id)).flow.tr.b.flatMap((b, i) => (b.k === 'q' ? [i] : []))
    await s.jobs.cmd(j.id, { op: 'noteAnswer', step: 'tr', i: qs[0], r: 'the shared one' })
    await tick(60)
    assert.equal(s.sessions.length, 1, `${start}: one question still open`)
    await s.jobs.cmd(j.id, { op: 'noteAnswer', step: 'tr', i: qs[1], r: 'Imre' })
    if (start === 'hand') { await tick(60); assert.equal(s.sessions.length, 1, 'a hand step is not woken'); s.off(); continue }
    await until(() => s.sessions.length === 2)
    const rev = (await s.runner.all()).find((r) => r.parent && r.via === 'console')!
    assert.equal(rev.intent, 'revise'); assert.match(rev.q, /Which mailbox\? → the shared one/); assert.match(rev.q, /Who signs\? → Imre/)
    assert.equal(s.sessions[1].resume, 'S1')
    s.sessions[1].end()
    s.off()
  }
})

test('holdOf names what keeps a draft from being accepted by itself', () => {
  const f = (o: Partial<Flow>) => ({ s: 'wait', m: '', arts: [], b: [], rv: null, dr: { t: 'd', at: '' }, out: null, run: null, sent: {}, ...o }) as Flow
  assert.equal(holdOf(f({})), null)
  assert.equal(holdOf(f({ b: [{ k: 'q', t: 'x', r: 'y', o: 0 }] })), null)
  assert.equal(holdOf(f({ b: [{ k: 'p', t: 'x', r: '', o: 1 }] })), 'a problem note')
  assert.equal(holdOf(f({ bb: { say: 'wait for Imre', at: '' } })), 'a blocker asked for')
  assert.equal(holdOf(f({ w: [{ j: 'J-2', st: 'open', at: '' }] as Flow['w'] })), 'open blockers')
  // commands wait for the person's approval, and what approved commands printed is the person's to read
  assert.equal(holdOf(f({ dr: { t: 'd', at: '', cm: ['git push', 'npm run deploy'] } })), 'the draft waits for approval of 2 commands')
  assert.equal(holdOf(f({ dr: { t: 'd', at: '', ap: 1 } })), 'the draft reports approved commands')
  assert.equal(holdOf(f({ dr: { t: 'd', at: '', ua: 1 } })), 'a question was answered while the run worked, so the draft has not seen the answer')
})

test('an auto step whose question is answered while its run still works: the draft is held back for the person, not accepted', async () => {
  const s = modes(false), j = await s.job('auto')
  await s.jobs.cmd(j.id, { op: 'start' }, (await s.get(j.id)).v)
  await until(() => s.sessions.length === 1)
  await s.sessions[0].tools.askQuestion!('Which mailbox?')
  const i = (await s.get(j.id)).flow.tr.b.findIndex((b) => b.k === 'q')
  await s.jobs.cmd(j.id, { op: 'noteAnswer', step: 'tr', i, r: 'the shared one' })
  await s.sessions[0].tools.submitDraft('written before the answer'); s.sessions[0].end()
  await until(async () => (await s.get(j.id)).jr[0].o.startsWith('Held back'))
  const a = await s.get(j.id)
  assert.equal(a.jr[0].o, 'Held back the automatic accept of “Understand the request”: a question was answered while the run worked, so the draft has not seen the answer.')
  assert.equal(a.flow.tr.s, 'wait')
  await tick(60)
  assert.equal(s.sessions.length, 1, 'no wake either: the person accepts or replies')
  s.off()
})

test('answeredText and the wake keep the latest 20 questions, each clipped', () => {
  const qs = Array.from({ length: 25 }, (_, i) => ({ k: 'q' as const, t: `q${i} ${'x'.repeat(600)}`, r: `a${i} ${'y'.repeat(600)}`, o: 0 as const }))
  const t = answeredText({ b: qs } as unknown as Flow)
  assert.doesNotMatch(t, /- q4 /); assert.match(t, /- q5 /); assert.match(t, /- q24 /)
  assert.match(t, /the latest 20 of 25/)
  for (const l of t.split('\n').filter((l) => l.startsWith('- '))) assert.ok(l.length < 1100, l.length.toString())
})

test('an auto step\'s draft that reports failed or not done is held back for the person, never closed by itself', async () => {
  const s = modes(false), j = await s.job('auto')
  await s.jobs.cmd(j.id, { op: 'start' }, (await s.get(j.id)).v)
  await until(() => s.sessions.length === 1)
  await s.sessions[0].tools.submitDraft('The smoke test failed.', { o: 'failed' }); s.sessions[0].end()
  await until(async () => (await s.get(j.id)).jr[0].o.startsWith('Held back'))
  const a = await s.get(j.id)
  assert.equal(a.jr[0].o, 'Held back the automatic accept of “Understand the request”: the draft reports failed.')
  assert.equal(a.flow.tr.s, 'wait'); assert.equal(a.flow.tr.dr!.o, 'failed')
  assert.equal(holdOf({ ...a.flow.tr, dr: { ...a.flow.tr.dr!, o: 'not_done' } }), 'the draft reports not done')
  s.off()
})

test('an auto step\'s draft that waits for commands is held back for the person', async () => {
  const s = modes(false), j = await s.job('auto')
  await s.jobs.cmd(j.id, { op: 'start' }, (await s.get(j.id)).v)
  await until(() => s.sessions.length === 1)
  await s.sessions[0].tools.submitDraft('Push it.', { cm: ['git push'] }); s.sessions[0].end()
  await until(async () => (await s.get(j.id)).jr[0].o.startsWith('Held back'))
  const a = await s.get(j.id)
  assert.equal(a.jr[0].o, 'Held back the automatic accept of “Understand the request”: the draft waits for approval of 1 command.')
  assert.equal(a.flow.tr.s, 'wait'); assert.deepEqual(a.flow.tr.dr!.cm, ['git push'])
  s.off()
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

/* ===== AD-0017: the one-time approval and fix rounds ===== */
const SHIP: Playbook = {
  n: 'Ship', ok: { at: 'a1', cmds: ['git status', 'git push origin {branch}'] },
  ph: [
    { c: 'AN', n: 'Analysis', s: [{ id: 'a1', t: 'Analysis', m: 'llm', x: 'spec agreed' }] },
    { c: 'BD', n: 'Build', s: [{ id: 'a2', t: 'Build', m: 'llm', x: 'tests green', start: 'auto' }] },
    { c: 'SH', n: 'Ship', s: [
      { id: 'a3', t: 'Live check', m: 'llm', x: 'the check passes', start: 'auto', retry: { to: 'a2' } },
      { id: 'a4', t: 'Look at it live', m: 'you', x: 'it works' }] }],
}
const shipCtx = (): T.Ctx => { const d = demoCtx(); return { ...d, PB: { ...d.PB, ship: SHIP } } }
const SX = shipCtx()

function ship(delay = 0) {
  const dir = tempDir('ship')
  const store = fileStore(join(dir, 's.json'), demoSeed)
  const bus = new Bus(), jobs = new Jobs({ store, bus, ctx: shipCtx, gate: () => true })
  const { sdk, sessions } = fakeSdk()
  const workDir = { dir: async () => dir, branch: () => 'job/s-1', base: () => 'main' }
  const runner = new Runner({ store, jobs, bus, sdk, cwd: dir, gate: () => true, artifactsDir: join(dir, 'arts'), ctx: shipCtx, workDir })
  const off = autoAsk({ jobs, runner, ctx: shipCtx, on: false, delay })
  const get = async (id: string) => (await jobs.get(id))!
  /** the newest session names its session, hands in a draft and ends */
  const hand = async (t: string, rep?: DraftReport) => {
    const s = sessions.at(-1)!, sid = `S${sessions.length}`
    s.push({ k: 'session', id: sid })
    // a real session names itself before any tool call; the fake's event is read asynchronously, so wait for it
    await until(async () => (await runner.all()).some((r) => r.session === sid))
    await s.tools.submitDraft(t, rep); s.end()
  }
  /** a started ship job whose Analysis the person accepted on the page */
  const granted = async () => {
    const j0 = await jobs.create({ t: 'Ship it', key: 'K-1', pb: 'ship', prj: 'core', ws: 'acme' })
    await jobs.cmd(j0.id, { op: 'start' }, j0.v)
    await runner.ask(j0.id, 'a1', 'go')
    await until(() => sessions.length === 1)
    await hand('the spec')
    await until(async () => !!(await get(j0.id)).flow.a1.dr && (await runner.all()).every((r) => r.ended))
    await jobs.cmd(j0.id, { op: 'acceptDraft', step: 'a1' }, (await get(j0.id)).v)
    return j0.id
  }
  return { dir, jobs, runner, sessions, off, get, hand, granted }
}

test('a session whose MCP client calls itself "you" accepting the ok step grants nothing; the page\'s Accept does', async () => {
  const s = ship()
  const j0 = await s.jobs.create({ t: 'Ship it', key: 'K-1', pb: 'ship', prj: 'core', ws: 'acme' })
  await s.jobs.cmd(j0.id, { op: 'start' }, j0.v)
  await s.runner.ask(j0.id, 'a1', 'go')
  await until(() => s.sessions.length === 1)
  await s.hand('the spec')
  await until(async () => !!(await s.get(j0.id)).flow.a1.dr && (await s.runner.all()).every((r) => r.ended))
  const r = await s.jobs.cmd(j0.id, { op: 'acceptDraft', step: 'a1' }, undefined, 'session', undefined, 'you')
  assert.equal(r.job.flow.a1.s, 'done')
  assert.equal(r.job.jr.find((e) => e.o.startsWith('Accepted'))!.a, 'you', 'the name is only a signature')
  assert.equal(r.job.ok, undefined)
  assert.ok(!r.job.jr.some((e) => e.o.startsWith('Approved')))
  s.off()
})

test('accepting a failed draft that names a step to go back to makes that step current: it is asked, not left stalled', () => {
  let j = T.apply(SX, T.freshJob(SX, 'S-1', { t: 'Ship', key: 'K-1', pb: 'ship', prj: 'core', ws: 'acme' }), start).job
  for (const s of ['a1', 'a2']) j = T.apply(SX, j, { op: 'stepDone', step: s }).job
  j = T.apply(SX, T.apply(SX, j, { op: 'runStart', step: 'a3', q: 'q', id: 'r' }).job, { op: 'runDraft', step: 'a3', t: 'red', o: 'failed', rt: 'a1' }).job
  const acc: Cmd = { op: 'acceptDraft', step: 'a3' }
  assert.deepEqual(madeCurrent(acc, j, T.apply(SX, j, acc).job), ['a1'])
  assert.deepEqual(madeCurrent({ ...acc, stay: true }, j, T.apply(SX, j, { ...acc, stay: true }).job), [], 'kept open: nothing new is current')
})

test('holdOf with the step and the job: a fix round within the limit goes, at the limit, elsewhere or with a question it holds; ap ok goes', () => {
  const step = SHIP.ph[2].s[0], dr = { t: 'red', at: '', o: 'failed' as const, rt: 'a2' }
  const f = (o: Partial<Flow>) => ({ s: 'wait', m: '', arts: [], b: [], rv: null, dr, out: null, run: null, sent: {}, ...o }) as Flow
  const job = (fx: number) => ({ rounds: Array.from({ length: fx }, (_, i) => ({ n: i + 1, fx: { n: i + 1, max: 3, step: 'a3' } })) }) as unknown as Job
  assert.equal(holdOf(f({}), step, job(0)), null)
  assert.equal(holdOf(f({}), step, job(2)), null)
  assert.equal(holdOf(f({}), step, job(3)), 'the job has had its 3 fix rounds')
  assert.equal(holdOf(f({ dr: { ...dr, rt: 'a1' } }), step, job(0)), 'the draft reports failed')
  assert.equal(holdOf(f({ dr: { ...dr, o: 'not_done', rt: undefined } }), step, job(0)), 'the draft reports not done')
  assert.equal(holdOf(f({ b: [{ k: 'q', t: 'which host?', r: '', o: 1 }] }), step, job(0)), 'an open question')
  assert.equal(holdOf(f({ b: [{ k: 'p', t: 'x', r: '', o: 1 }] }), step, job(0)), 'a problem note')
  assert.equal(holdOf(f({ dr: { ...dr, cm: ['git push'] } }), step, job(0)), 'the draft waits for approval of 1 command')
  assert.equal(holdOf(f({}), { ...step, start: 'self' }, job(0)), 'the draft reports failed', 'only an auto step goes back by itself')
  assert.equal(holdOf(f({ dr: { t: 'ran', at: '', ap: 'ok' } }), step, job(0)), null)
  assert.equal(holdOf(f({ dr: { t: 'ran', at: '', ap: 1 } }), step, job(0)), 'the draft reports approved commands')
})

test('the person accepts Analysis: the approval is granted; Build goes on by itself; a command on the list is approved by the console, runs, and its draft is accepted', async () => {
  const s = ship(), id = await s.granted()
  let j = await s.get(id)
  assert.deepEqual(j.ok, { at: 'a1', by: 'you', cmds: ['git status', 'git push origin job/s-1'] })
  assert.deepEqual(j.wd, { branch: 'job/s-1', base: 'main' })
  await until(() => s.sessions.length === 2)
  await s.hand('built')
  await until(() => s.sessions.length === 3)
  await s.hand('please run them', { cm: ['git status', 'git push origin job/s-1'] })
  await until(() => s.sessions.length === 4)
  assert.equal(s.sessions[3].resume, 'S3')
  assert.match(s.sessions[3].prompt, /git push origin job\/s-1/)
  const ap = (await s.runner.all()).find((r) => r.intent === 'approve')!
  assert.equal(ap.via, 'console')
  j = await s.get(id)
  const line = j.jr.find((e) => e.o.startsWith('Approved 2 commands'))!
  assert.equal(line.o, 'Approved 2 commands under this job\'s one-time approval: git status; git push origin job/s-1')
  assert.equal(line.a, 'console')
  await s.hand('clean; pushed')
  await until(async () => (await s.get(id)).flow.a3.s === 'done')
  j = await s.get(id)
  assert.equal(j.flow.a4.s, 'cur')
  assert.equal(j.flow.a3.out, 'clean; pushed')
  s.off()
})

test('a command off the list waits for the person; a draft after the person\'s approval that asks for more waits too', async () => {
  const s = ship(), id = await s.granted()
  await until(() => s.sessions.length === 2)
  await s.hand('built', { cm: ['git status', 'git push --force'] })
  await until(async () => (await s.get(id)).jr[0].o.startsWith('Held back'))
  assert.equal((await s.get(id)).jr[0].o, 'Held back the automatic accept of “Build”: the draft waits for approval of 2 commands.')
  await tick(60)
  assert.equal(s.sessions.length, 2)
  assert.ok(!(await s.runner.all()).some((r) => r.intent === 'approve'))
  await s.runner.reply(id, 'a2', '', 'approve', { at: (await s.get(id)).flow.a2.dr!.at })
  await until(() => s.sessions.length === 3)
  await s.hand('ran; now this', { cm: ['git status'] })
  await until(async () => (await s.get(id)).jr[0].o.startsWith('Held back'))
  await tick(60)
  assert.equal(s.sessions.length, 3)
  s.off()
})

test('a console-approved run that asks for its commands again is held, not approved a second time', async () => {
  const s = ship(), id = await s.granted()
  await until(() => s.sessions.length === 2)
  await s.hand('built', { cm: ['git status'] })
  await until(() => s.sessions.length === 3)
  await s.hand('ran; once more', { cm: ['git status'] })
  await until(async () => (await s.get(id)).jr[0].o.startsWith('Held back'))
  await tick(60)
  assert.equal(s.sessions.length, 3)
  assert.equal((await s.runner.all()).filter((r) => r.intent === 'approve').length, 1)
  s.off()
})

test('a failed Live check goes back to Build by itself 3 times, each journaled with its artifact and prompt; the 4th is held; the person\'s Return to starts the count again', async () => {
  const s = ship(), id = await s.granted()
  await until(() => s.sessions.length === 2)
  await s.hand('built')
  let n = 3
  for (let k = 1; k <= 3; k++) {
    await until(() => s.sessions.length === n)
    await s.hand(`the health check answers 500 (${k})`, { o: 'failed', why: `health 500 (${k})` })
    await until(() => s.sessions.length === n + 1)
    const j = await s.get(id)
    assert.equal(T.fixRounds(j), k)
    assert.ok(j.jr.some((e) => e.o === `Fix round ${k} of 3: “Live check” failed, back to “Build”: health 500 (${k})` && e.a === 'console'))
    assert.match(s.sessions[n].prompt, new RegExp(`## Fix round ${k} of 3`))
    assert.match(s.sessions[n].prompt, new RegExp(`the health check answers 500 \\(${k}\\)`))
    await until(async () => !!(await s.get(id)).flow.a3.arts.find((a) => a.n === `fix-round-${k}.md`)?.link)
    assert.match(await readFile(join(s.dir, 'arts', id, `fix-round-${k}.md`), 'utf8'), new RegExp(`^## Fix round ${k} of 3`))
    await s.hand('fixed')
    n += 2
  }
  await until(() => s.sessions.length === n)
  await s.hand('still 500', { o: 'failed', why: 'health 500 (4)' })
  await until(async () => (await s.get(id)).jr[0].o.startsWith('Held back'))
  let j = await s.get(id)
  assert.equal(j.jr[0].o, 'Held back the automatic accept of “Live check”: the job has had its 3 fix rounds.')
  assert.equal(j.flow.a3.s, 'wait')
  await tick(60)
  assert.equal(s.sessions.length, n)
  // the person sends it back: that round is theirs, so the next failure goes back by itself again as round 1
  await s.jobs.cmd(id, { op: 'stepReopen', step: 'a2', why: 'look at the config' }, j.v)
  assert.equal(T.fixRounds(await s.get(id)), 0)
  await until(() => s.sessions.length === n + 1)
  await s.hand('fixed the config')
  await until(() => s.sessions.length === n + 2)
  await s.hand('500 again', { o: 'failed', why: 'health 500 (5)' })
  await until(() => s.sessions.length === n + 3)
  j = await s.get(id)
  assert.ok(j.jr.some((e) => e.o === 'Fix round 1 of 3: “Live check” failed, back to “Build”: health 500 (5)'))
  await until(async () => (await s.get(id)).flow.a3.arts.some((a) => a.n === 'fix-round-4.md'))
  s.off()
})

test('holdOf holds a draft on a step that declares review: only a person accepts a review', () => {
  const f = { s: 'wait', m: '', arts: [], b: [], rv: null, dr: { t: 'd', at: '' }, out: null, run: null, sent: {} } as Flow
  const j = { rounds: [] } as unknown as Job
  assert.equal(holdOf(f, { id: 'r', t: 'Review', m: 'llm', x: 'reviewed', start: 'auto', fx: ['review'] }, j), 'the step is a review, which only a person accepts')
  assert.equal(holdOf(f, { id: 'b', t: 'Build', m: 'llm', x: 'green', start: 'auto', fx: ['branch'] }, j), null)
})
