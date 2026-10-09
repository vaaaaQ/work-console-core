import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import * as T from '../../src/model/transitions.ts'
import type { Cmd, Job } from '../../src/model/types.ts'
import { Bus } from '../events.ts'
import { Jobs } from '../jobs/jobs.ts'
import { fileStore } from '../store/file.ts'
import type { Store } from '../store/port.ts'
import { demoCtx, demoSeed } from '../testkit.ts'
import { tempDir } from '../testdirs.ts'
import { agentReactor } from './reactor.ts'
import type { Target } from './session.ts'

/** jobs over a store whose writes fail with 413 while big.v, and a hear that records */
function setup() {
  const st = fileStore(join(tempDir('re'), 's.json'), demoSeed), big = { v: false }
  const store: Store = { ...st, putJob: (j, v) => (big.v ? Promise.reject(Object.assign(new Error('a document is capped at 256 KB'), { status: 413 })) : st.putJob(j, v)) }
  const jobs = new Jobs({ store, bus: new Bus(), ctx: demoCtx, gate: () => true })
  const heard: [Target, string, boolean][] = []
  const off = agentReactor({ jobs, agent: { hear: async (t, l, turn) => { heard.push([t, l, turn]) } }, ctx: demoCtx })
  return { jobs, heard, big, off }
}
async function openJob(jobs: Jobs): Promise<Job> {
  const x = demoCtx()
  return (await jobs.all()).find((j) => !T.isClosed(j) && j.st !== 'recurring' && j.st !== 'draft' && !!T.atOf(x, j))!
}
/** a job with an ask step n1 whose message went out, so it waits for a reply */
async function asking(jobs: Jobs) {
  const j = await openJob(jobs), at = T.atOf(demoCtx(), j)!
  const add: Cmd = { op: 'stepAdd', before: at, step: { t: 'Ask Ana', m: 'you', ask: 1 }, tpl: [['chat', 'team', 'ok?']] }
  await jobs.cmd(j.id, { op: 'ppSet', say: 'ask the PO', cmds: [add], by: 'c1' }, undefined, 'console')
  await jobs.cmd(j.id, { op: 'ppAccept' })
  await jobs.cmd(j.id, { op: 'sent', step: 'n1', i: 0, t: 'ok?', to: 'team', ch: 'c-1' })
  return j
}
const reply: Cmd = { op: 'replyIn', step: 'n1', id: 'm1', at: '2026-10-09T12:05:00Z', from: 'Ana', t: 'yes,\ngo' }

test("a recorded reply makes the job's conversation take a turn with the reply", async () => {
  const { jobs, heard } = setup(), j = await asking(jobs)
  heard.length = 0
  await jobs.cmd(j.id, reply, undefined, 'console')
  assert.deepEqual(heard, [[{ job: j.id }, 'A reply came in on step n1 “Ask Ana” from Ana at 2026-10-09T12:05:00Z:\nyes,\ngo', true]])
})

test('a duplicate reply (same id) starts nothing', async () => {
  const { jobs, heard } = setup(), j = await asking(jobs)
  await jobs.cmd(j.id, reply, undefined, 'console')
  heard.length = 0
  await jobs.cmd(j.id, { ...reply, t: 'again' } as Cmd, undefined, 'console')
  assert.deepEqual(heard, [])
})

test('a refused accept tells the proposing conversation and starts its turn', async () => {
  const { jobs, heard } = setup()
  const c = await jobs.create({ t: 'Local stand', key: 'K-1', pb: 'action', prj: 'p', ws: 'acme' })
  const j = (await jobs.cmd(c.id, { op: 'start' }, c.v)).job
  await jobs.cmd(j.id, { op: 'ppSet', say: 'skip the draft', cmds: [{ op: 'noteAdd', step: 'tr', k: 'q', t: 'who?' }, { op: 'stepDel', step: 'dr' }], by: 'conv-7' }, undefined, 'console')
  // the job moves on before the person accepts: the draft step is current now and cannot be deleted
  await jobs.cmd(j.id, { op: 'stepDone', step: 'tr' })
  heard.length = 0
  const r = await jobs.cmd(j.id, { op: 'ppAccept' })
  assert.match(r.job.pp?.err ?? '', /^2\. stepDel: /)
  assert.deepEqual(heard, [[{ conv: 'conv-7' }, `Your proposal for ${j.id} was not applied: ${r.job.pp!.err}. Read the job and propose again.`, true]])
})

test('an accept and a reject are heard without a turn, the reject with its reason', async () => {
  const { jobs, heard } = setup(), j = await openJob(jobs), at = T.atOf(demoCtx(), j)!
  const set = (say: string) => jobs.cmd(j.id, { op: 'ppSet', say, cmds: [{ op: 'noteAdd', step: at, k: 'q', t: 'who?' }], by: 'conv-7' }, undefined, 'console')
  await set('ask who signs')
  heard.length = 0
  await jobs.cmd(j.id, { op: 'ppAccept' })
  await set('ask   again\nlater')
  await jobs.cmd(j.id, { op: 'ppReject', why: 'already asked' })
  await set('third')
  await jobs.cmd(j.id, { op: 'ppReject' })
  assert.deepEqual(heard, [
    [{ conv: 'conv-7' }, `The person accepted your proposal for ${j.id}: ask who signs.`, false],
    [{ conv: 'conv-7' }, `The person rejected your proposal for ${j.id}: ask again later. Their reason: already asked.`, false],
    [{ conv: 'conv-7' }, `The person rejected your proposal for ${j.id}: third. Their reason: none given.`, false],
  ])
})

test('a 413 on accept tells the agent and starts its turn', async (t) => {
  t.mock.method(console, 'error', () => {})
  const { jobs, heard, big, off } = setup(), j = await openJob(jobs), at = T.atOf(demoCtx(), j)!
  await jobs.cmd(j.id, { op: 'ppSet', say: 'a lot', cmds: [{ op: 'noteAdd', step: at, k: 'q', t: 'who?' }], by: 'conv-7' }, undefined, 'console')
  heard.length = 0
  big.v = true
  await assert.rejects(jobs.cmd(j.id, { op: 'ppAccept' }), (e: unknown) => (e as { status?: number }).status === 413)
  await assert.rejects(jobs.cmd(j.id, { op: 'noteAdd', step: at, k: 'q', t: 'x' }), (e: unknown) => (e as { status?: number }).status === 413)
  assert.deepEqual(heard, [[{ conv: 'conv-7' }, `Your proposal for ${j.id} was not applied: the job would pass 256 KB. Propose fewer or shorter changes.`, true]])
  big.v = false
  off()
  await jobs.cmd(j.id, { op: 'ppAccept' })
  assert.equal(heard.length, 1, 'nothing is heard once it is off')
})
