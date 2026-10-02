import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as T from '../src/model/transitions.ts'
import type { Playbook } from '../src/model/types.ts'
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
  t.mock.method(console, 'error', () => undefined)
  install([{ page: acme }, { page: beta2.page }])
  const dir = mkdtempSync(join(tmpdir(), 'wc-spaces-'))
  const cfg: WsConfig = { gatewayUrl: 'http://127.0.0.1:9', consoleTokenPath: join(dir, 'none'), llmTokenPath: join(dir, 'none'), workDir: dir, runTools: [], teamTz: null, maxSessions: 3 }
  const make = async (w: WorkspaceServer) => {
    const f = fakeSdk()
    return { space: await makeSpace(w, { cfg, home: dir, artifactsDir: join(dir, 'arts'), sdk: f.sdk, fake: true, push: async () => {} }), sessions: f.sessions }
  }
  const a = await make(acmeServer), b = await make(beta2)
  try {
    assert.notEqual(a.space.fake!.url, b.space.fake!.url, 'a fake gateway each')
    for (const x of [a, b]) x.space.source.start()
    await until(() => a.space.source.available() && b.space.source.available())
    const ask = async (s: Space) => {
      const j = await s.jobs.create({ t: 'Two spaces', key: 'ACME-77', pb: 'action', prj: acme.pack.prj[0], ws: s.id })
      const started = (await s.jobs.cmd(j.id, { op: 'start' })).job
      const step = T.steps(s.ctx(), j.pb).find((x) => T.isLive(started.flow[x.id]))!.id
      return { job: j, run: await s.runner.ask(j.id, step, 'look') }
    }
    const ra = await ask(a.space), rb = await ask(b.space)
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
    await a.space.close(); await b.space.close()
  }
})
