import '../testkit.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JOBS, LOG, S, applyLocal, atOf, byId, createJob, initFlow, isClosed, jobAtAct, jobForAct, keySrc, putJob, restore, setJobs, snap } from './world.ts'

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

test("an act's view links to the job at its step, else a recurring one in the shown workspace whose playbook has it", () => {
  const x = snap()
  assert.equal(jobForAct('time'), undefined, 'no demo job has a time step; the recurring one without it is not offered')
  // past its time step and recurring: the title says nothing about time, the playbook does
  const j = createJob({ t: 'Month end', key: 'NEW', pb: 'acme-timesheet', prj: '', ws: 'acme' })
  applyLocal(j.id, { op: 'stepDone', step: 'ts1' })
  assert.equal(jobAtAct('time'), undefined)
  applyLocal(j.id, { op: 'schedule', due: '2026-10-03T21:00:00Z', every: 'month' })
  assert.equal(byId(j.id)!.st, 'recurring')
  assert.equal(jobForAct('time')?.id, j.id)
  const ws = S.ws
  S.ws = 'elsewhere'
  try { assert.equal(jobForAct('time'), undefined, 'only the shown workspace') } finally { S.ws = ws }
  applyLocal(j.id, { op: 'stepReopen', step: 'ts1' })
  assert.equal(jobForAct('time')?.id, j.id, 'at the step, the same job')
  restore(x)
})

test('a timesheet job keeps its key in the time source of its pack', () => {
  const x = snap()
  assert.equal(keySrc(createJob({ t: 'Month end timesheet', key: 'NEW', pb: 'acme-timesheet', prj: '', ws: 'acme' })).n, 'Timesheet')
  restore(x)
})
