import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import net from 'node:net'
import pg from 'pg'
import type { Job, Playbook } from '../../src/model/types.ts'
import { Bus } from '../events.ts'
import type { Ev } from '../events.ts'
import { pgSource } from './pg.ts'
import type { PgSource } from './pg.ts'
import { Conflict } from './port.ts'

/* Against a real PostgreSQL named by WC_TEST_PG_URL; skipped without one. Each test owns a throwaway schema. */

const URL = process.env.WC_TEST_PG_URL
const skip = URL ? false : 'WC_TEST_PG_URL is not set'
const PB: Record<string, Playbook> = { built: { n: 'Built', d: '', ph: [{ c: 'B', n: 'B', s: [{ id: 'b1', t: 'Do', m: 'you', x: 'done' }] }] } }
const job = (id: string, t = 'a job') => ({ id, t, ws: 'w', pb: 'built', key: 'NEW', prj: 'main', st: 'ready', flow: {}, jr: [], ts: 1 }) as unknown as Job

async function until(f: () => boolean, ms = 5000) {
  const t0 = Date.now()
  while (!f()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)) }
}

/** n sources on one fresh schema, started and up; dropped and stopped after f */
async function withSchema(n: number, f: (xs: { src: PgSource; bus: Bus; evs: Ev[] }[], schema: string) => Promise<void>, ws = 'w') {
  const schema = `wc_test_${randomBytes(4).toString('hex')}`
  const xs = Array.from({ length: n }, () => {
    const bus = new Bus(), evs: Ev[] = []
    bus.on((e) => evs.push(e))
    return { src: pgSource({ url: URL!, schema, ws, bus, checkMs: 200 }), bus, evs }
  })
  try {
    for (const x of xs) x.src.start()
    await until(() => xs.every((x) => x.src.available()))
    await f(xs, schema)
  } finally {
    for (const x of xs) x.src.stop()
    const c = new pg.Client({ connectionString: URL })
    await c.connect(); await c.query(`drop schema if exists "${schema}" cascade`); await c.end()
  }
}

test('a new job gets v 1; a stale v is a Conflict carrying the current copy; of two saves of one v exactly one wins', { skip }, async () => {
  await withSchema(1, async ([x]) => {
    const s = x.src.store({ prefix: 'AD', playbooks: PB })
    const j = await s.putJob(job('AD-0001'), null)
    assert.equal(j.v, 1)
    await assert.rejects(s.putJob(job('AD-0001'), null), (e) => e instanceof Conflict && e.current?.v === 1)
    const j2 = await s.putJob({ ...j, t: 'renamed' }, 1)
    assert.equal(j2.v, 2)
    assert.equal((await s.job('AD-0001'))?.t, 'renamed')
    await assert.rejects(s.putJob({ ...j, t: 'stale' }, 1), (e) => e instanceof Conflict && e.current?.t === 'renamed')
    const r = await Promise.allSettled([s.putJob({ ...j2, t: 'one' }, 2), s.putJob({ ...j2, t: 'two' }, 2)])
    assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1)
    assert.ok(r.some((x) => x.status === 'rejected' && x.reason instanceof Conflict))
    assert.deepEqual((await s.jobs()).map((y) => y.v), [3])
  })
})

test('job ids count per workspace, padded to four digits', { skip }, async () => {
  await withSchema(1, async ([x], schema) => {
    const s = x.src.store({ prefix: 'AD', playbooks: PB })
    assert.equal(await s.nextJobId(), 'AD-0001')
    assert.equal(await s.nextJobId(), 'AD-0002')
    const bus = new Bus(), other = pgSource({ url: URL!, schema, ws: 'other', bus })
    try { assert.equal(await other.store({ prefix: 'OT', playbooks: {} }).nextJobId(), 'OT-0001') } finally { other.stop() }
  })
})

test('playbooks: a tombstone hides a built-in, an added one shows, removing it hides it; marks merge, a false clears, null deletes', { skip }, async () => {
  await withSchema(1, async ([x]) => {
    const s = x.src.store({ prefix: 'AD', playbooks: PB })
    assert.deepEqual(Object.keys(await s.playbooks()), ['built'])
    await s.putPlaybook('added', PB.built)
    await s.putPlaybook('built', null)
    assert.deepEqual(Object.keys(await s.playbooks()), ['added'])
    await s.putPlaybook('added', null)
    assert.deepEqual(Object.keys(await s.playbooks()), [])
    await s.putMark('m1', { done: true })
    await s.putMark('m1', { job: 'AD-0001', hidden: true })
    assert.deepEqual((await s.marks()).m1, { done: true, job: 'AD-0001', hidden: true })
    await s.putMark('m1', { hidden: false })
    assert.deepEqual((await s.marks()).m1, { done: true, job: 'AD-0001' })
    await s.putMark('m1', null)
    assert.deepEqual(await s.marks(), {})
  })
})

test("another writer's job and run changes reach this bus; its own writes do not come back", { skip }, async () => {
  await withSchema(2, async ([a, b]) => {
    const sa = a.src.store({ prefix: 'AD', playbooks: PB }), sb = b.src.store({ prefix: 'AD', playbooks: PB })
    await sb.putJob(job('AD-0001', 'from b'), null)
    await sb.putRun({ id: 'r-1', job: 'AD-0001', step: 'b1', q: 'go', state: 'queued', at: 'now' })
    await until(() => a.evs.some((e) => e.kind === 'job') && a.evs.some((e) => e.kind === 'run'))
    const je = a.evs.find((e) => e.kind === 'job') as Extract<Ev, { kind: 'job' }>
    assert.equal(je.job.t, 'from b')
    assert.equal(je.job.v, 1)
    await sa.putJob(job('AD-0002', 'from a'), null)
    await until(() => b.evs.some((e) => e.kind === 'job'))
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(a.evs.filter((e) => e.kind === 'job').length, 1, "a's own write is not echoed to a")
  })
})

test('the source says ok once the database answers, unavailable when it cannot; a store call then answers 503', { skip }, async () => {
  const bus = new Bus(), evs: Ev[] = []
  bus.on((e) => evs.push(e))
  const dead = pgSource({ url: 'postgres://nobody@127.0.0.1:9/none', ws: 'w', bus, checkMs: 200 })
  try {
    dead.start()
    await new Promise((r) => setTimeout(r, 600))
    assert.equal(dead.available(), false)
    assert.equal(evs.filter((e) => e.kind === 'bridge').length, 0, 'never up, so nothing flipped')
    await assert.rejects(dead.store({ prefix: 'AD', playbooks: {} }).jobs(), (e) => (e as { status?: number }).status === 503)
    assert.equal((await dead.read(['chat'])).chat.status, 'unsupported')
  } finally { dead.stop() }
  await withSchema(1, async ([x]) => {
    assert.deepEqual(x.evs.filter((e) => e.kind === 'bridge').map((e) => (e as { state: string }).state), ['ok'])
  })
})

test('a database that goes away while up flips the source to unavailable, and back to ok when it returns', { skip }, async () => {
  const u = new globalThis.URL(URL!), socks = new Set<net.Socket>()
  const listen = (port = 0) => new Promise<net.Server>((res) => {
    const s = net.createServer((c) => {
      const up = net.connect(Number(u.port), u.hostname)
      socks.add(c); socks.add(up)
      c.pipe(up).pipe(c)
      const drop = () => { c.destroy(); up.destroy() }
      c.on('error', drop); up.on('error', drop); c.on('close', drop); up.on('close', drop)
    })
    s.listen(port, '127.0.0.1', () => res(s))
  })
  let proxy = await listen()
  const port = (proxy.address() as net.AddressInfo).port
  const via = new globalThis.URL(URL!); via.port = String(port)
  const schema = `wc_test_${randomBytes(4).toString('hex')}`, bus = new Bus(), states: string[] = []
  bus.on((e) => { if (e.kind === 'bridge') states.push(e.state) })
  const src = pgSource({ url: via.toString(), schema, ws: 'w', bus, checkMs: 100 })
  try {
    src.start()
    await until(() => src.available())
    await new Promise<void>((r) => { proxy.close(() => r()); for (const s of socks) s.destroy() })
    await until(() => !src.available())
    await assert.rejects(src.store({ prefix: 'AD', playbooks: {} }).jobs(), (e) => (e as { status?: number }).status === 503)
    proxy = await listen(port)
    await until(() => src.available(), 10000)
    assert.deepEqual(states, ['ok', 'unavailable', 'ok'])
  } finally {
    src.stop()
    for (const s of socks) s.destroy()
    proxy.close()
    const c = new pg.Client({ connectionString: URL })
    await c.connect(); await c.query(`drop schema if exists "${schema}" cascade`); await c.end()
  }
})
