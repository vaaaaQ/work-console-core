import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Job, Tpl } from '../../src/model/types.ts'
import { fileStore } from './file.ts'
import { Conflict } from './port.ts'

const dir = () => mkdtempSync(join(tmpdir(), 'wc-store-'))
const job = (id: string): Job => ({ id, ws: 'acme', key: 'K-1', pb: 'action', prj: 'p', t: 'T', st: 'active', at: null, upd: 0, slug: 's', flow: {}, ts: 0, jr: [] })

test('seeds on first open and keeps writes across a reopen', async () => {
  const p = join(dir(), 's.json')
  const a = fileStore(p, () => ({ jobs: [job('J-0001')], playbooks: { x: { n: 'X', ph: [] } } }))
  assert.equal((await a.job('J-0001'))!.v, 1)
  await a.putJob({ ...(await a.job('J-0001'))!, t: 'changed' }, 1)
  const b = fileStore(p, () => ({ jobs: [] }))
  assert.equal((await b.job('J-0001'))!.t, 'changed')
  assert.equal((await b.job('J-0001'))!.v, 2)
  assert.deepEqual(Object.keys(await b.playbooks()), ['x'])
})

test('a stale version is a Conflict carrying the current job', async () => {
  const s = fileStore(join(dir(), 's.json'), () => ({ jobs: [job('J-0001')] }))
  await s.putJob(job('J-0001'), 1)
  await assert.rejects(s.putJob(job('J-0001'), 1), (e: unknown) => e instanceof Conflict && e.current!.v === 2)
  await assert.rejects(s.putJob(job('J-0002'), 3), Conflict)
  assert.equal((await s.putJob(job('J-0002'), null)).v, 1)
})

test('two writes naming the same version: the second conflicts', async () => {
  const s = fileStore(join(dir(), 's.json'), () => ({ jobs: [job('J-0001')] }))
  const r = await Promise.allSettled([s.putJob({ ...job('J-0001'), t: 'a' }, 1), s.putJob({ ...job('J-0001'), t: 'b' }, 1)])
  assert.equal(r[0].status, 'fulfilled')
  assert.equal(r[1].status, 'rejected')
  assert.equal((await s.job('J-0001'))!.t, 'a')
})

test('the file is replaced whole; no tmp file is left behind', async () => {
  const d = dir(), p = join(d, 's.json'), s = fileStore(p)
  await s.putJob(job('J-0001'), null)
  assert.ok(existsSync(p))
  assert.deepEqual(readdirSync(d), ['s.json'])
})

test('returned jobs are copies; job ids keep counting up', async () => {
  const s = fileStore(join(dir(), 's.json'), () => ({ jobs: [job('J-0007')] }))
  const j = (await s.job('J-0007'))!
  j.t = 'mutated'
  assert.equal((await s.job('J-0007'))!.t, 'T')
  assert.equal(await s.nextJobId(), 'J-0008')
  assert.equal(await s.nextJobId(), 'J-0009')
})

test('runs and marks round-trip', async () => {
  const s = fileStore(join(dir(), 's.json'))
  await s.putRun({ id: 'r1', job: 'J-1', step: 'a', q: 'q', state: 'queued', at: 'x' })
  await s.putRun({ id: 'r1', job: 'J-1', step: 'a', q: 'q', state: 'running', at: 'x' })
  assert.deepEqual((await s.runs()).map((r) => r.state), ['running'])
  await s.putMark('m1', { done: true }); await s.putMark('m1', { job: 'J-1' })
  assert.deepEqual((await s.marks()).m1, { done: true, job: 'J-1' })
  await s.putMark('m1', null)
  assert.equal((await s.marks()).m1, undefined)
})

test('job ids carry the prefix the store was opened with, and count within it', async () => {
  const p = join(dir(), 's.json')
  assert.equal(await fileStore(p, () => ({}), 'T').nextJobId(), 'T-0001')
  assert.equal(await fileStore(join(dir(), 'j.json'), () => ({ jobs: [job('J-0007')] }), 'T').nextJobId(), 'T-0001', 'another prefix does not move the count')
  assert.equal(await fileStore(join(dir(), 'd.json'), () => ({ jobs: [job('A1-0003')] }), 'A1').nextJobId(), 'A1-0004', 'digits in a prefix are not part of the number')
})

test("a playbook's planned messages are kept with it, read back after a restart, and go with it", async () => {
  const p = join(dir(), 's.json'), tpl: Record<string, Tpl[]> = { 'x/tell': [['chat', 'team', 'hi']] }
  const a = fileStore(p, () => ({ jobs: [] }))
  assert.deepEqual(await a.templates(), {})
  await a.putPlaybook('x', { n: 'X', ph: [] }, tpl)
  assert.deepEqual(await fileStore(p).templates(), tpl)
  await a.putPlaybook('x', null)
  assert.deepEqual(await fileStore(p).templates(), {})
})
