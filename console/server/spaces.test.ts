import { test } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as T from '../src/model/transitions.ts'
import type { Playbook, RunRec } from '../src/model/types.ts'
import { install } from '../src/workspace.ts'
import { Bus, HttpError } from './events.ts'
import type { Ev } from './events.ts'
import { hub, makeSpace, Spaces } from './spaces.ts'
import type { Space } from './spaces.ts'
import { acme, acmeServer, fakeSdk } from './testkit.ts'
import type { WorkspaceServer, WsConfig } from './workspace.ts'

/** Acme under another id and prefix; its playbooks stay Acme's, so it brings none of its own */
const beta2: WorkspaceServer = { ...acmeServer, page: { ...acme, id: 'beta2', playbooks: {}, me: 'Alex' }, jobPrefix: 'B' }
const stub = (id: string, prefix: string, PB: Record<string, Playbook> = {}) => ({ id, prefix, bus: new Bus(), ctx: () => ({ PB, TPL: { [id]: [] } }) }) as unknown as Space
const httpError = (status: number, code: string, msg: string) => (e: unknown) => e instanceof HttpError && e.status === status && e.code === code && e.message === msg
const wsCfg = (dir: string): WsConfig => ({ gatewayUrl: 'http://127.0.0.1:9', consoleTokenPath: join(dir, 'none'), llmTokenPath: join(dir, 'none'), workDir: dir, runTools: [], teamTz: null, maxSessions: 3 })
const servers = () => process.getActiveResourcesInfo().filter((r) => r === 'TCPServerWrap').length

/** swallows only the console.error lines a test expects; anything else still prints */
function expectErrors(t: TestContext, ...pats: RegExp[]) {
  const print = console.error
  t.mock.method(console, 'error', (...a: unknown[]) => { if (!pats.some((p) => p.test(a.map(String).join(' ')))) print(...a) })
}

async function twoSpaces(a: WorkspaceServer, b: WorkspaceServer) {
  install([{ page: a.page }, { page: b.page }])
  const dir = mkdtempSync(join(tmpdir(), 'wc-spaces-'))
  const make = async (w: WorkspaceServer) => {
    const f = fakeSdk(), space = await makeSpace(w, { cfg: wsCfg(dir), home: dir, artifactsDir: join(dir, 'arts'), sdk: f.sdk, fake: true, push: async () => {} })
    const settled = new Set<string>()
    space.runner.onSettled((r: RunRec) => settled.add(r.id))
    return { space, sessions: f.sessions, settled }
  }
  const x = await make(a), y = await make(b)
  for (const s of [x, y]) s.space.source.start()
  await until(() => x.space.source.available() && y.space.source.available())
  return [x, y] as const
}

async function until(f: () => boolean, ms = 5000) {
  const t0 = Date.now()
  while (!f()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)) }
}

test('a job id finds its space by the prefix before the first dash; an unknown one is a 404 naming it', () => {
  const s = new Spaces([stub('acme', 'A'), stub('beta2', 'B2')])
  assert.equal(s.byJob('A-0001').id, 'acme')
  assert.equal(s.byJob('B2-0012').id, 'beta2')
  assert.throws(() => s.byJob('X-0001'), httpError(404, 'not_found', 'no job X-0001'))
  assert.throws(() => s.byJob('nodash'), httpError(404, 'not_found', 'no job nodash'))
  assert.throws(() => s.get('zzz'), httpError(404, 'no_workspace', 'no workspace zzz'))
})

test('pick: a named workspace, the only one, or a 400 that names them all', () => {
  const two = new Spaces([stub('acme', 'A'), stub('beta2', 'B')])
  assert.equal(two.pick('beta2').id, 'beta2')
  assert.throws(() => two.pick(undefined), httpError(400, 'bad_args', 'say which workspace: acme, beta2'))
  assert.throws(() => two.pick('zzz'), httpError(404, 'no_workspace', 'no workspace zzz'))
  assert.equal(new Spaces([stub('acme', 'A')]).pick(undefined).id, 'acme')
  assert.equal(new Spaces([stub('acme', 'A')]).pick(null).id, 'acme')
  // only a string names a workspace: an array would stringify to a valid id
  assert.throws(() => two.pick(['acme']), httpError(404, 'no_workspace', 'no workspace ["acme"]'))
  assert.throws(() => new Spaces([stub('acme', 'A')]).pick(5), httpError(404, 'no_workspace', 'no workspace 5'))
})

test("ctx merges every space's playbooks and templates", () => {
  const pb = (n: string) => ({ n }) as unknown as Playbook
  const x = new Spaces([stub('acme', 'A', { one: pb('One') }), stub('beta2', 'B', { two: pb('Two') })]).ctx()
  assert.deepEqual(Object.keys(x.PB).sort(), ['one', 'two'])
  assert.deepEqual(Object.keys(x.TPL).sort(), ['acme', 'beta2'])
})

test("the hub re-emits each space's events with its id, until it is unsubscribed", () => {
  const a = stub('acme', 'A'), b = stub('beta2', 'B'), to = new Bus(), got: Ev[] = []
  to.on((e) => got.push(e))
  const off = hub([a, b], to)
  a.bus.emit({ kind: 'bridge', state: 'ok', concepts: {} })
  b.bus.emit({ kind: 'feed', run: 'r-1', t: 'hi' })
  off()
  a.bus.emit({ kind: 'feed', run: 'r-2', t: 'gone' })
  assert.deepEqual(got, [{ kind: 'bridge', state: 'ok', concepts: {}, ws: 'acme' }, { kind: 'feed', run: 'r-1', t: 'hi', ws: 'beta2' }])
})

test("each space mints its own prefix, names its own user, and interrupts only its own runs when its gateway goes", async (t) => {
  expectErrors(t, /run\(s\) not marked interrupted/)
  const [a, b] = await twoSpaces(acmeServer, beta2)
  const runs: string[] = []
  try {
    assert.notEqual(a.space.fake!.url, b.space.fake!.url, 'a fake gateway each')
    const ask = async (s: Space) => {
      const j = await s.jobs.create({ t: 'Two spaces', key: 'ACME-77', pb: 'action', prj: acme.pack.prj[0], ws: s.id })
      const started = (await s.jobs.cmd(j.id, { op: 'start' })).job
      const step = T.steps(s.ctx(), j.pb).find((x) => T.isLive(started.flow[x.id]))!.id
      return { job: j, run: await s.runner.ask(j.id, step, 'look') }
    }
    const ra = await ask(a.space); runs.push(ra.run.id)
    const rb = await ask(b.space)
    assert.match(ra.job.id, /^A-\d{4}$/); assert.match(rb.job.id, /^B-\d{4}$/)
    await until(() => a.sessions.length === 1 && b.sessions.length === 1)
    assert.match(a.sessions[0].prompt, /in the user's Work Console/)
    assert.match(b.sessions[0].prompt, /in Alex's Work Console/)

    b.space.fake!.setDown(true)
    await until(() => b.sessions[0].abort.signal.aborted)
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(a.sessions[0].abort.signal.aborted, false, "acme's run carries on")
    assert.equal((await a.space.runner.get(ra.run.id))?.state, 'running')
    assert.ok(a.space.source.available(), "acme's gateway is still up")
  } finally {
    for (const s of [...a.sessions, ...b.sessions]) s.end()
    // acme's run settles before its space closes; beta's was interrupted while its gateway was down, so it is left for recover()
    await until(() => runs.every((id) => a.settled.has(id)))
    await a.space.close(); await b.space.close()
  }
})

test("each space's Start reads the board by its own workspace's rule and makes the job there", async () => {
  /** beta2 under its own board rule, start playbook and projects */
  const beta: WorkspaceServer = { ...beta2, page: { ...beta2.page, pack: { ...acme.pack, prj: ['labs'] }, board: { start: 'action', key: (id) => `beta/${id}`, itemId: (k) => (k.startsWith('beta/') ? k.slice(5) : null) } } }
  const [a, b] = await twoSpaces(acmeServer, beta)
  try {
    await assert.rejects(a.space.start('beta/ACME-603'), httpError(400, 'bad_args', 'beta/ACME-603 is not a board item key'), "acme's rule does not read beta's key")
    const { job, created } = await b.space.start('beta/ACME-603')
    assert.equal(created, true)
    assert.match(job.id, /^B-\d{4}$/)
    assert.deepEqual([job.key, job.pb, job.prj, job.ws], ['beta/ACME-603', 'action', 'labs', 'beta2'])
    assert.deepEqual(b.space.fake!.acts.map((x) => [x.action, x.args]), [['work.start', { id: 'ACME-603' }]])
    assert.deepEqual(a.space.fake!.acts, [], "acme's gateway is not asked")
  } finally { await a.space.close(); await b.space.close() }
})

test('a workspace hook that throws after its fake gateway started closes the fake', async () => {
  install([{ page: acme }])
  // the servers earlier tests closed go a turn of the loop after their close callbacks
  await until(() => servers() === 0)
  const dir = mkdtempSync(join(tmpdir(), 'wc-spaces-'))
  const broken: WorkspaceServer = { ...acmeServer, plugins: () => { throw new Error('plugin broke') } }
  await assert.rejects(makeSpace(broken, { cfg: wsCfg(dir), home: dir, artifactsDir: join(dir, 'arts'), sdk: fakeSdk().sdk, fake: true, push: async () => {} }), /plugin broke/)
  await until(() => servers() === 0)
})
