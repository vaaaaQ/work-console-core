import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Job } from '../../src/model/types.ts'
import { Bus } from '../events.ts'
import { fileStore } from '../store/file.ts'
import { demoCtx, demoSeed } from '../testkit.ts'
import { Blockers, outcomeOf } from './blockers.ts'
import { Jobs } from './jobs.ts'

function setup(react = true) {
  const store = fileStore(join(mkdtempSync(join(tmpdir(), 'wc-blk-')), 's.json'), demoSeed)
  const jobs = new Jobs({ store, bus: new Bus(), ctx: demoCtx, gate: () => true })
  const pushes: { title: string; body: string; url: string }[] = [], generic: string[] = []
  const mkB = () => new Blockers({ jobs, ctx: demoCtx, push: async (title, body, url) => { pushes.push({ title, body, url }) } })
  let b = react ? mkB() : null
  jobs.onNeedsYou((j) => { if (!b?.handling(j.id)) generic.push(j.id) })
  const mk = async (t: string) => { const j = await jobs.create({ t, key: 'NEW', pb: 'action', prj: 'p', ws: 'acme' }); return (await jobs.cmd(j.id, { op: 'start' }, j.v)).job }
  return { store, jobs, pushes, generic, mk, get: (id: string) => jobs.get(id) as Promise<Job>, attach: () => { b = mkB(); return b }, b: () => b! }
}
async function until(f: () => boolean | Promise<boolean>, ms = 2000) {
  const t0 = Date.now()
  while (!(await f())) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 5)) }
}

test('outcomeOf: the last step output, else the close note, else empty', async () => {
  const s = setup(false), j = await s.mk('B')
  assert.equal(outcomeOf(demoCtx(), j), '')
  const c = (await s.jobs.cmd(j.id, { op: 'close', st: 'done', note: 'Imre said yes' })).job
  assert.equal(outcomeOf(demoCtx(), c), 'Imre said yes')
  c.flow.tr.out = 'first'; c.flow.dr.out = 'second'
  assert.equal(outcomeOf(demoCtx(), c), 'second')
})

test('a blocker closed as done wakes every waiter with its outcome and pushes once each', async () => {
  const s = setup(), a = await s.mk('Local stand'), c = await s.mk('Deploy'), b = await s.mk('Ask Imre')
  await s.jobs.cmd(a.id, { op: 'waitAdd', step: 'tr', j: b.id })
  await s.jobs.cmd(c.id, { op: 'waitAdd', step: 'tr', j: b.id })
  await s.jobs.cmd(b.id, { op: 'close', st: 'done', note: 'confirmed\nsee chat' })
  await until(() => s.pushes.length === 2)
  for (const w of [a, c]) {
    const j = await s.get(w.id)
    assert.equal(j.flow.tr.s, 'cur'); assert.equal(j.flow.tr.w![0].out, 'confirmed\nsee chat')
  }
  assert.deepEqual(s.pushes.map((p) => p.title).sort(), [`${a.id} goes on`, `${c.id} goes on`].sort())
  assert.equal(s.pushes[0].body, `${b.id} done: confirmed`)
})

test('a cancelled blocker makes the step bad and pushes its own message', async () => {
  const s = setup(), a = await s.mk('Local stand'), b = await s.mk('Ask Imre')
  await s.jobs.cmd(a.id, { op: 'waitAdd', step: 'tr', j: b.id })
  await s.jobs.cmd(b.id, { op: 'close', st: 'cancelled' })
  await until(() => s.pushes.length === 1)
  assert.equal((await s.get(a.id)).flow.tr.s, 'bad')
  assert.equal(s.pushes[0].title, `${a.id} Local stand: blocker ${b.id} cancelled`)
})

test('reconcile catches a close made while no reactor listened', async () => {
  const s = setup(false), a = await s.mk('Local stand'), b = await s.mk('Ask Imre')
  await s.jobs.cmd(a.id, { op: 'waitAdd', step: 'tr', j: b.id })
  await s.jobs.cmd(b.id, { op: 'close', st: 'done', note: 'yes' })
  assert.equal((await s.get(a.id)).flow.tr.s, 'wait')
  await s.attach().reconcile()
  assert.equal((await s.get(a.id)).flow.tr.s, 'cur')
})

test('a missing blocker becomes cancelled with "blocker not found"', async () => {
  const s = setup(false), a = await s.mk('Local stand')
  const j = await s.get(a.id)
  j.flow.tr.w = [{ j: 'J-9999', st: 'open' }]; j.flow.tr.s = 'wait'
  await s.store.putJob(j, j.v ?? null)
  await s.attach().reconcile()
  const w = (await s.get(a.id)).flow.tr.w![0]
  assert.equal(w.st, 'cancelled'); assert.equal(w.out, 'blocker not found')
})

test('a blocker reopened after its waiter went on adds a journal line and changes nothing else', async () => {
  const s = setup(), a = await s.mk('Local stand'), b = await s.mk('Ask Imre')
  await s.jobs.cmd(a.id, { op: 'waitAdd', step: 'tr', j: b.id })
  await s.jobs.cmd(b.id, { op: 'close', st: 'done' })
  await until(async () => (await s.get(a.id)).flow.tr.s === 'cur')
  await s.jobs.cmd(b.id, { op: 'reopen' })
  await until(async () => (await s.get(a.id)).jr[0].o.startsWith(`Blocker ${b.id}`) && (await s.get(a.id)).jr[0].o.includes('reopened'))
  const j = await s.get(a.id)
  assert.equal(j.flow.tr.s, 'cur'); assert.equal(j.flow.tr.w![0].st, 'done')
})

test('a waiter reopened after its blocker closed goes on', async () => {
  const s = setup(), a = await s.mk('Local stand'), b = await s.mk('Ask Imre')
  await s.jobs.cmd(a.id, { op: 'waitAdd', step: 'tr', j: b.id })
  await s.jobs.cmd(a.id, { op: 'close', st: 'cancelled' })
  await s.jobs.cmd(b.id, { op: 'close', st: 'done', note: 'yes' })
  await s.b().reconcile()
  assert.equal((await s.get(a.id)).flow.tr.w![0].st, 'open') // closed waiters are left alone
  await s.jobs.cmd(a.id, { op: 'reopen' })
  await until(async () => (await s.get(a.id)).flow.tr.s === 'cur')
  assert.equal((await s.get(a.id)).flow.tr.w![0].out, 'yes')
})

test('a wake the reactor pushes about itself sends no generic needs-you push', async () => {
  const s = setup(), a = await s.mk('Local stand'), b = await s.mk('Ask Imre')
  await s.jobs.cmd(a.id, { op: 'waitAdd', step: 'tr', j: b.id })
  s.generic.length = 0 // start made the jobs need you; the waiting step has no templates, so only the close can fire it again
  await s.jobs.cmd(b.id, { op: 'close', st: 'cancelled' })
  await until(() => s.pushes.length === 1)
  assert.equal((await s.get(a.id)).flow.tr.s, 'bad')
  assert.equal(s.pushes[0].title, `${a.id} Local stand: blocker ${b.id} cancelled`)
  assert.deepEqual(s.generic, [])
})

test('a second reconcile after a wake pushes nothing and changes nothing', async () => {
  const s = setup(), a = await s.mk('Local stand'), b = await s.mk('Ask Imre')
  await s.jobs.cmd(a.id, { op: 'waitAdd', step: 'tr', j: b.id })
  await s.jobs.cmd(b.id, { op: 'close', st: 'done', note: 'yes' })
  await until(() => s.pushes.length === 1)
  const before = await s.get(a.id)
  await s.b().reconcile()
  assert.equal(s.pushes.length, 1)
  assert.deepEqual(await s.get(a.id), before)
})

test('one cancelled blocker of two turns the step bad once while the other is still open', async () => {
  const s = setup(), a = await s.mk('Local stand'), b = await s.mk('Ask Imre'), c = await s.mk('Ask Anna')
  await s.jobs.cmd(a.id, { op: 'waitAdd', step: 'tr', j: b.id })
  await s.jobs.cmd(a.id, { op: 'waitAdd', step: 'tr', j: c.id })
  await s.jobs.cmd(b.id, { op: 'close', st: 'cancelled' })
  await until(() => s.pushes.length === 1)
  await s.b().reconcile()
  const j = await s.get(a.id)
  assert.equal(s.pushes.length, 1)
  assert.equal(j.flow.tr.s, 'bad')
  assert.deepEqual(j.flow.tr.w!.map((l) => l.st), ['cancelled', 'open'])
})

test('a cancelled blocker that is reopened gets the failure wording in the waiter journal', async () => {
  const s = setup(), a = await s.mk('Local stand'), b = await s.mk('Ask Imre')
  await s.jobs.cmd(a.id, { op: 'waitAdd', step: 'tr', j: b.id })
  await s.jobs.cmd(b.id, { op: 'close', st: 'cancelled' })
  await until(async () => (await s.get(a.id)).flow.tr.s === 'bad')
  await s.jobs.cmd(b.id, { op: 'reopen' })
  await until(async () => (await s.get(a.id)).jr[0].o.includes('reopened'))
  const e = (await s.get(a.id)).jr[0]
  assert.match(e.c, /cancelled outcome/); assert.doesNotMatch(e.c, /went on/)
})
