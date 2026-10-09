import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import * as T from '../../src/model/transitions.ts'
import type { Job } from '../../src/model/types.ts'
import { Bus } from '../events.ts'
import { Jobs } from '../jobs/jobs.ts'
import { fileStore } from '../store/file.ts'
import { demoCtx } from '../testkit.ts'
import { tempDir } from '../testdirs.ts'
import { PP_MAX, Proposer } from './proposer.ts'

function setup() {
  const jobs = new Jobs({ store: fileStore(join(tempDir('pp'), 's.json')), bus: new Bus(), ctx: demoCtx, gate: () => true })
  const pushes: string[][] = [], ny: string[] = []
  const pp = new Proposer({ jobs, ctx: demoCtx, push: async (t, b, u) => { pushes.push([t, b, u]) } })
  jobs.onNeedsYou((j) => { if (!pp.handling(j.id)) ny.push(j.id) })
  const mk = async (t = 'Local stand') => { const j = await jobs.create({ t, key: 'K-1', pb: 'action', prj: 'p', ws: 'acme' }); return (await jobs.cmd(j.id, { op: 'start' }, j.v)).job }
  return { jobs, pp, pushes, ny, mk }
}

test('a valid proposal is set by the console, pushed once, and the needs-you push stays quiet', async () => {
  const { jobs, pp, pushes, ny, mk } = setup(), j = await mk(), k = await mk('Other')
  assert.equal(T.needsYou(demoCtx(), j), false, 'the job did not need the person before')
  ny.length = 0
  const say = 'After the daily: ask Imre before the draft. ' + 'x'.repeat(300)
  assert.equal(await pp.propose(j.id, say, [{ op: 'stepAdd', after: 'tr', step: { t: 'Ask Imre', m: 'you' } }], 'conv-1'), '')
  const p = (await jobs.get(j.id))!.pp!
  assert.deepEqual([p.by, p.say, p.cmds.map((c) => c.op)], ['conv-1', say, ['stepAdd']])
  assert.equal(pushes.length, 1)
  assert.deepEqual([pushes[0][0], pushes[0][1].length, pushes[0][2]], [`${j.id}: proposal`, 200, `/?job=${j.id}`])
  assert.deepEqual(ny, [], 'the generic needs-you push stays quiet')
  assert.equal(pp.handling(j.id), false)
  await jobs.cmd(k.id, { op: 'ppSet', say: 'not through the proposer', cmds: [{ op: 'noteAdd', step: 'tr', k: 'q', t: 'who?' }], by: 'c' }, undefined, 'console')
  assert.deepEqual(ny, [k.id], 'a proposal it does not handle still pushes')
})

test('a refused cmd answers its index and sets nothing', async () => {
  const { jobs, pp, pushes, mk } = setup(), j = await mk()
  assert.match(await pp.propose(j.id, 'x', [{ op: 'noteAdd', step: 'tr', k: 'q', t: 'who?' }, { op: 'stepDel', step: 'nope' }], 'c'), /^Not proposed: 2\. stepDel: /)
  assert.match(await pp.propose(j.id, 'x', [{ op: 'close', st: 'done' }], 'c'), /^Not proposed: 1\. close cannot be proposed/)
  assert.match(await pp.propose(j.id, 'x', [], 'c'), /^Not proposed: a proposal holds 1–30 commands/)
  assert.match(await pp.propose(j.id, ' ', [{ op: 'noteAdd', step: 'tr', k: 'q', t: 'who?' }], 'c'), /^Not proposed: say what/)
  assert.equal((await jobs.get(j.id))!.pp, undefined)
  assert.deepEqual(pushes, [])
})

test('a proposal that would pass PP_MAX is refused', async () => {
  const { mk } = setup(), base = await mk()
  // a job 1,000 characters under the cap
  const j: Job = { ...base, d: 'x'.repeat(PP_MAX - JSON.stringify({ ...base, d: '' }).length - 1000) }
  let sets = 0
  const pp = new Proposer({ jobs: { get: async () => j, all: async () => [j], cmd: async () => { sets++; return {} as never } }, ctx: demoCtx, push: async () => {} })
  assert.equal(await pp.propose(j.id, 'x', [{ op: 'noteAdd', step: 'tr', k: 'q', t: 'who?' }], 'c'), '')
  assert.equal(await pp.propose(j.id, 'x', [{ op: 'noteAdd', step: 'tr', k: 'q', t: 'y'.repeat(2000) }], 'c'), 'Not proposed: the job would grow past 250 KB; propose fewer or shorter changes.')
  assert.equal(sets, 1, 'only the small one is set')
})

test('a job of another workspace or a closed job is refused', async () => {
  const { jobs, pp, pushes, mk } = setup(), j = await mk()
  assert.equal(await pp.propose('B-0001', 'x', [{ op: 'noteAdd', step: 'tr', k: 'q', t: 'who?' }], 'c'), 'Not proposed: there is no job B-0001 in this workspace.')
  const c = (await jobs.cmd(j.id, { op: 'close', st: 'done' }, j.v)).job
  assert.match(await pp.propose(c.id, 'x', [{ op: 'noteAdd', step: 'tr', k: 'q', t: 'who?' }], 'c'), /^Not proposed: .* is done; a closed job takes no proposal/)
  assert.deepEqual(pushes, [])
})
