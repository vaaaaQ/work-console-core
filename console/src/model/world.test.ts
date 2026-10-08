import '../testkit.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CHATS, JOBS, LOG, PB, S, applyLocal, atOf, byId, chatOf, createJob, initFlow, isClosed, jobAtAct, jobForAct, keySrc, nextJobId, pbs, putJob, restore, setJobs, snap, timesheetJob } from './world.ts'

JOBS.forEach(initFlow)

test('a local command replaces the job, bumps its version and logs the new journal entry', () => {
  const j = JOBS.find((j) => !isClosed(j) && j.st !== 'recurring' && j.st !== 'draft' && atOf(j))!
  const at = atOf(j)!, x = snap(), before = j.flow[at].s, v0 = j.v || 0, log0 = LOG[j.ws].length
  const r = applyLocal(j.id, { op: 'stepDone', step: at })
  assert.equal(byId(j.id), r.job)
  assert.equal(r.job.flow[at].s, 'done')
  assert.equal(r.job.v, v0 + 1)
  assert.equal(LOG[j.ws].length, log0 + 1)
  assert.equal(LOG[j.ws][0].job, j.id)
  restore(x)
  assert.equal(byId(j.id)!.flow[at].s, before, 'undo brings the step back')
  assert.equal(LOG[j.ws].length, log0)
})

test('putJob ignores a copy no newer than the one it holds (reply and event for one write)', () => {
  const j = JOBS.find((j) => !isClosed(j) && atOf(j))!, x = snap()
  const r = applyLocal(j.id, { op: 'noteAdd', step: atOf(j)!, k: 'q', t: 'why?' })
  const log0 = LOG[j.ws].length
  assert.equal(putJob(structuredClone(r.job)), false)
  assert.equal(LOG[j.ws].length, log0)
  restore(x)
})

test('setJobs rebuilds the log from the journals, newest first', () => {
  const x = snap(), list = structuredClone(JOBS)
  setJobs(list)
  for (const ws of Object.keys(LOG) as (keyof typeof LOG)[]) {
    const n = list.filter((j) => j.ws === ws).reduce((a, j) => a + j.jr.length, 0)
    assert.equal(LOG[ws].length, Math.min(200, n))
  }
  restore(x)
})

test('a job from a removed workspace lands in the default one and does not break the log', () => {
  const x = snap(), old = structuredClone(JOBS[0]) as { ws: string; id: string }, id = old.id
  old.ws = 'removed'
  setJobs([old as never])
  assert.equal(byId(id)!.ws, 'acme')
  const again = structuredClone(byId(id)!) as { ws: string; v?: number }
  again.ws = 'removed'; again.v = (again.v || 0) + 1
  const n = LOG.acme.length
  assert.doesNotThrow(() => putJob(again as never))
  assert.equal(byId(id)!.ws, 'acme')
  assert.ok(LOG.acme.length >= n)
  restore(x)
})

test('every job knows where its key lives', () => {
  for (const j of JOBS) assert.ok(keySrc(j).n, j.id)
})

test('jobAtAct finds the open job whose current step carries the act', () => {
  const x = snap()
  assert.equal(jobAtAct('time'), undefined, 'no demo job is at a step with an act')
  const j = createJob({ t: 'Month end timesheet', key: 'NEW', pb: 'acme-timesheet', prj: '', ws: 'acme' })
  assert.equal(jobAtAct('time')?.id, j.id)
  assert.equal(jobAtAct('bogus'), undefined)
  applyLocal(j.id, { op: 'stepDone', step: 'ts1' })
  assert.equal(jobAtAct('time'), undefined, 'the act is behind the job once its step is done')
  applyLocal(j.id, { op: 'stepReopen', step: 'ts1' })
  assert.equal(jobAtAct('time')?.id, j.id)
  applyLocal(j.id, { op: 'close', st: 'cancelled' })
  assert.equal(jobAtAct('time'), undefined, 'a closed job is not offered')
  restore(x)
})

test("an act's view links to the job at its step, else an open one in the shown workspace whose playbook has it", () => {
  const x = snap()
  assert.equal(jobForAct('time'), undefined, 'no demo job has a time step; the recurring one without it is not offered')
  // at a later step that is not the time one: the title says nothing about time, the playbook does
  const j = createJob({ t: 'Month end', key: 'NEW', pb: 'acme-timesheet', prj: '', ws: 'acme' })
  applyLocal(j.id, { op: 'stepDone', step: 'ts1' })
  assert.equal(atOf(byId(j.id)!), 'ts2')
  assert.equal(jobAtAct('time'), undefined)
  assert.equal(jobForAct('time')?.id, j.id, 'open and not recurring')
  applyLocal(j.id, { op: 'schedule', due: '2026-10-03T21:00:00Z', every: 'month' })
  assert.equal(byId(j.id)!.st, 'recurring')
  assert.equal(jobForAct('time')?.id, j.id, 'recurring too')
  const ws = S.ws
  S.ws = 'elsewhere'
  try { assert.equal(jobForAct('time'), undefined, 'only the shown workspace') } finally { S.ws = ws }
  // the job at the step comes before one that only has it in its playbook
  const k = createJob({ t: 'Next month', key: 'NEW', pb: 'acme-timesheet', prj: '', ws: 'acme' })
  assert.equal(jobForAct('time')?.id, k.id, 'at the step wins')
  applyLocal(k.id, { op: 'close', st: 'cancelled' })
  applyLocal(j.id, { op: 'schedule', due: null })
  applyLocal(j.id, { op: 'close', st: 'done' })
  assert.equal(jobForAct('time'), undefined, 'closed jobs are not offered')
  restore(x)
})

test('the Time view links to the job for the time act, else a recurring one named for timesheets', () => {
  const x = snap()
  assert.equal(timesheetJob(), undefined, 'the demo has neither')
  // a recurring job on a playbook without a time step, named for timesheets
  const n = createJob({ t: 'Timesheet for week 40', key: 'TS-W40', pb: 'action', prj: '', ws: 'acme' })
  assert.equal(timesheetJob(), undefined, 'not while it is a one-off')
  applyLocal(n.id, { op: 'schedule', due: '2026-10-03T21:00:00Z', every: 'month' })
  assert.equal(byId(n.id)!.st, 'recurring')
  assert.equal(jobForAct('time'), undefined, 'its playbook has no time step')
  assert.equal(timesheetJob()?.id, n.id, 'by its title')
  // a job with the time step in its playbook comes first, wherever it stands
  const j = createJob({ t: 'Month end', key: 'NEW', pb: 'acme-timesheet', prj: '', ws: 'acme' })
  applyLocal(j.id, { op: 'stepDone', step: 'ts1' })
  assert.equal(timesheetJob()?.id, j.id)
  restore(x)
  const k = createJob({ t: 'Week report', key: 'TIMESHEET-W41', pb: 'action', prj: '', ws: 'acme' })
  applyLocal(k.id, { op: 'schedule', due: '2026-10-03T21:00:00Z', every: 'month' })
  assert.equal(timesheetJob()?.id, k.id, 'by its key')
  restore(x)
})

test('a timesheet job keeps its key in the time source of its pack', () => {
  const x = snap()
  assert.equal(keySrc(createJob({ t: 'Month end timesheet', key: 'NEW', pb: 'acme-timesheet', prj: '', ws: 'acme' })).n, 'Timesheet')
  restore(x)
})

test("a demo job id takes the prefix its workspace's jobs carry, numbered past that prefix's highest", () => {
  const x = snap(), [a, b] = JOBS.filter((j) => j.ws === 'acme')
  JOBS.splice(0, JOBS.length,
    { ...structuredClone(a), id: 'ACME-0001' }, { ...structuredClone(b), id: 'ACME-0007' },
    { ...structuredClone(a), id: 'J-0420', ws: 'other' }, { ...structuredClone(b), id: 'B-0900', ws: 'third' })
  assert.equal(createJob({ t: 'Next', key: 'NEW', pb: 'action', prj: '', ws: 'acme' }).id, 'ACME-0008')
  assert.equal(nextJobId('empty'), 'J-0421', 'no jobs of its own: J, above the J max; other prefixes do not count')
  restore(x)
})

test('no playbook list offers a once playbook; PB still holds it for its job', () => {
  PB['once-x'] = { n: 'For one job', once: 1, ph: [] }
  try {
    assert.equal(pbs().includes('once-x'), false)
    assert.ok(pbs().length > 0)
  } finally { delete PB['once-x'] }
})

test('a planned chat message goes to the chat its label names, else to the job\'s own chat', () => {
  const j = JOBS.find((j) => (CHATS[j.ws] || []).length >= 2)!, [a, b] = CHATS[j.ws]
  const job = (o: Partial<typeof j>) => ({ ...j, chat: undefined, ctx: [], ...o })
  assert.deepEqual(chatOf(job({ chat: b.id }), a.name.toUpperCase()), { id: a.id, name: a.name }, 'a label naming a chat wins')
  assert.deepEqual(chatOf(job({ chat: b.id }), 'reply in the thread'), { id: b.id, name: b.name })
  assert.deepEqual(chatOf(job({ ctx: [{ k: 'chat', id: 'x1', n: 10, name: 'Sam' }] }), 'reply in the thread'), { id: 'x1', name: 'Sam' }, 'the one chat in its context')
  assert.equal(chatOf(job({ ctx: [{ k: 'chat', id: 'x1', n: 10 }, { k: 'chat', id: 'x2', n: 10 }] }), 'reply in the thread'), undefined, 'two chats: no guess')
  assert.equal(chatOf(job({}), 'reply in the thread'), undefined)
})
