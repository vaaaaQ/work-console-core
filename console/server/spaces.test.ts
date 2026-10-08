import { test } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as T from '../src/model/transitions.ts'
import type { Playbook, RunRec, Tpl } from '../src/model/types.ts'
import { install } from '../src/workspace.ts'
import { startFakeGateway } from './bridge/fake.ts'
import { Bus, HttpError } from './events.ts'
import type { Ev } from './events.ts'
import { hub, makeSpace, Spaces } from './spaces.ts'
import type { Space } from './spaces.ts'
import { acme, acmeServer, fakeSdk } from './testkit.ts'
import { fakeSeed } from './workspace.ts'
import type { PluginCtx, WorkspaceServer, WsConfig } from './workspace.ts'
import type { WorkDir } from './llm/worktree.ts'
import type { Store } from './store/port.ts'

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

async function until(f: () => boolean | Promise<boolean>, ms = 5000) {
  const t0 = Date.now()
  while (!(await f())) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)) }
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

test('on the default source and store, gateways that mint J-NNNN give each space its own prefix, and byJob routes each job home', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wc-spaces-')), ws = [acmeServer, beta2]
  install(ws.map((w) => ({ page: w.page })))
  // started as spaces.ts starts a fake, which mints J- ids only, as the real gateway does
  const fakes = await Promise.all(ws.map((w) => startFakeGateway({ seed: fakeSeed(w), me: w.page.me, board: w.page.board })))
  const list: Space[] = []
  try {
    for (const [i, w] of ws.entries()) {
      const tokenPath = join(dir, `${w.page.id}.token`)
      writeFileSync(tokenPath, fakes[i].token)
      const cfg = { ...wsCfg(dir), gatewayUrl: fakes[i].url, consoleTokenPath: tokenPath }
      list.push(await makeSpace(w, { cfg, home: dir, artifactsDir: join(dir, 'arts'), sdk: fakeSdk().sdk, fake: false, push: async () => {} }))
    }
    for (const s of list) s.source.start()
    await until(() => list.every((s) => s.source.available()))
    const spaces = new Spaces(list), made = []
    for (const s of list) made.push(await s.jobs.create({ t: `${s.id} job`, key: 'NEW', pb: 'action', prj: acme.pack.prj[0], ws: s.id }))
    assert.deepEqual(made.map((j) => j.id), ['A-0001', 'B-0001'])
    for (const [i, j] of made.entries()) {
      assert.equal(spaces.byJob(j.id), list[i], `${j.id} routes to ${list[i].id}`)
      assert.equal((await spaces.byJob(j.id).jobs.get(j.id))?.t, `${list[i].id} job`)
      const held = await fetch(`${fakes[i].url}/api/items/jobs/${j.id}`, { headers: { authorization: `Bearer ${fakes[i].token}` } })
      assert.equal(((await held.json()) as { status: string }).status, 'ok', `the gateway holds ${j.id} under that id`)
    }
  } finally {
    for (const s of list) await s.close()
    for (const f of fakes) await f.close()
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

test('the store hook gets the workspace id, its prefix and its built-in playbooks', async () => {
  install([{ page: acme }])
  const dir = mkdtempSync(join(tmpdir(), 'wc-spaces-'))
  let got: { ws: string; prefix: string; playbooks: Record<string, Playbook> } | undefined
  const w: WorkspaceServer = { ...acmeServer, store: (_s, _c, o) => { got = o; return {} as Store } }
  const space = await makeSpace(w, { cfg: wsCfg(dir), home: dir, artifactsDir: join(dir, 'arts'), sdk: fakeSdk().sdk, fake: false, push: async () => {} })
  try {
    assert.equal(got?.ws, 'acme')
    assert.equal(got?.prefix, acmeServer.jobPrefix)
    for (const id of Object.keys(acme.playbooks)) assert.ok(got?.playbooks[id], `built-in ${id} is passed`)
    assert.equal(space.store, got && space.store)
  } finally { await space.close() }
})

test('in fake mode the fake stands in for the store too: the store hook is not called', async () => {
  install([{ page: acme }])
  const dir = mkdtempSync(join(tmpdir(), 'wc-spaces-'))
  const w: WorkspaceServer = { ...acmeServer, store: () => { throw new Error('the store hook was called') } }
  const space = await makeSpace(w, { cfg: wsCfg(dir), home: dir, artifactsDir: join(dir, 'arts'), sdk: fakeSdk().sdk, fake: true, push: async () => {} })
  try {
    space.source.start()
    await until(() => space.source.available())
    assert.ok(Array.isArray(await space.store.jobs()))
  } finally { await space.close() }
})

test("a job's work dir: runs get it, closing the job cleans it once, a load cleans closed jobs, fake mode has none", async () => {
  install([{ page: acme }])
  const dir = mkdtempSync(join(tmpdir(), 'wc-spaces-')), calls: string[] = []
  const fakeGw = await startFakeGateway({ seed: fakeSeed(acmeServer), me: acme.me, board: acme.board })
  const tokenPath = join(dir, 'acme.token')
  writeFileSync(tokenPath, fakeGw.token)
  const workDir: WorkDir = {
    dir: async (j) => join(dir, 'jobs', j.id), branch: (j) => `job/${j.id.toLowerCase()}`,
    closed: async (j) => { calls.push(j.id); return `kept ${j.id}` },
  }
  const w: WorkspaceServer = { ...acmeServer, workDir: () => workDir }
  const f = fakeSdk()
  const space = await makeSpace(w, { cfg: { ...wsCfg(dir), gatewayUrl: fakeGw.url, consoleTokenPath: tokenPath }, home: dir, artifactsDir: join(dir, 'arts'), sdk: f.sdk, fake: false, push: async () => {} })
  try {
    space.source.start()
    await until(() => space.source.available())
    const j = await space.jobs.create({ t: 'Work dir', key: 'NEW', pb: 'action', prj: acme.pack.prj[0], ws: space.id })
    const started = (await space.jobs.cmd(j.id, { op: 'start' })).job
    const step = T.steps(space.ctx(), j.pb).find((x) => T.isLive(started.flow[x.id]))!.id
    await space.runner.ask(j.id, step, 'go')
    await until(() => f.sessions.length === 1)
    assert.equal(f.sessions[0].cwd, join(dir, 'jobs', j.id))
    assert.ok(f.sessions[0].prompt.includes(`Work dir: ${join(dir, 'jobs', j.id)} (a git worktree on branch job/${j.id.toLowerCase()}, yours alone; commit there)`), f.sessions[0].prompt)
    await f.sessions[0].tools.submitDraft('d'); f.sessions[0].end()
    await until(async () => (await space.runner.all()).every((r) => r.state !== 'running'))
    assert.deepEqual(calls, [])
    await space.jobs.cmd(j.id, { op: 'close', st: 'cancelled' })
    await until(() => space.known.get(j.id)?.jr[0]?.c === `kept ${j.id}`)
    const last = space.known.get(j.id)!.jr[0]
    assert.equal(last.a, 'console')
    await new Promise((r) => setTimeout(r, 50))
    assert.deepEqual(calls, [j.id], 'the journal line it wrote does not clean again')
    // a comeback loads the jobs again: the closed one is checked, and the same line is not written twice
    const n = space.known.get(j.id)!.jr.length
    fakeGw.setDown(true); await until(() => !space.source.available())
    fakeGw.setDown(false); await until(() => calls.length === 2)
    await new Promise((r) => setTimeout(r, 50))
    assert.equal((await space.jobs.get(j.id))!.jr.length, n)
  } finally { await space.close(); await fakeGw.close() }
  const fakeSpace = await makeSpace(w, { cfg: wsCfg(dir), home: dir, artifactsDir: join(dir, 'arts'), sdk: fakeSdk().sdk, fake: true, push: async () => {} })
  try {
    fakeSpace.source.start()
    await until(() => fakeSpace.source.available())
    const j = await fakeSpace.jobs.create({ t: 'Fake', key: 'NEW', pb: 'action', prj: acme.pack.prj[0], ws: fakeSpace.id })
    await fakeSpace.jobs.cmd(j.id, { op: 'start' }); await fakeSpace.jobs.cmd(j.id, { op: 'close', st: 'cancelled' })
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(calls.length, 2, 'fake mode never calls the work dir hook')
  } finally { await fakeSpace.close() }
})

test('with autoAsk a space asks the llm step a job moves onto and resumes a due run when its bridge is back; without it, neither', async (t) => {
  expectErrors(t, /run\(s\) not marked interrupted/, /runEnd on .* failed/, /loading the state from the bridge failed/)
  install([{ page: acme }])
  const dir = mkdtempSync(join(tmpdir(), 'wc-spaces-'))
  const make = async (autoAsk: boolean) => {
    const f = fakeSdk(), space = await makeSpace(acmeServer, { cfg: { ...wsCfg(dir), autoAsk }, home: dir, artifactsDir: join(dir, 'arts'), sdk: f.sdk, fake: true, push: async () => {}, askDelay: 0 })
    space.source.start()
    await until(() => space.source.available())
    const j = await space.jobs.create({ t: 'Auto', key: 'NEW', pb: 'action', prj: acme.pack.prj[0], ws: space.id })
    await space.jobs.cmd(j.id, { op: 'start' })
    const run = async () => (await space.runner.all()).find((r) => r.job === j.id)
    return { space, sessions: f.sessions, j, run }
  }
  const on = await make(true), off = await make(false)
  try {
    await until(() => on.sessions.length === 1)
    assert.equal((await on.run())!.step, 'tr')
    on.sessions[0].push({ k: 'session', id: 'sess-1' })
    await off.space.runner.ask(off.j.id, 'tr', 'by hand')
    await until(() => off.sessions.length === 1)
    off.sessions[0].push({ k: 'session', id: 'sess-2' })
    await until(async () => (await on.run())?.session === 'sess-1' && (await off.run())?.session === 'sess-2')
    for (const s of [on, off]) s.space.fake!.setDown(true)
    await until(() => on.sessions[0].abort.signal.aborted && off.sessions[0].abort.signal.aborted)
    for (const s of [on, off]) s.space.fake!.setDown(false)
    await until(() => on.sessions.length === 2)
    assert.equal(on.sessions[1].resume, 'sess-1')
    assert.equal((await on.run())!.ar, 'used')
    await until(async () => (await off.run())?.state === 'interrupted')
    await new Promise((r) => setTimeout(r, 50))
    assert.deepEqual([off.sessions.length, (await off.run())!.ar], [1, undefined], 'without autoAsk the run waits for the user')
  } finally {
    for (const s of [...on.sessions, ...off.sessions]) s.end()
    await until(async () => (await on.space.runner.all()).every((r) => r.state !== 'running' && r.state !== 'queued'))
    await on.space.close(); await off.space.close()
  }
})

test("a stored playbook's planned messages outlive a restart: sent works on the space made anew over the same B", async () => {
  install([{ page: acme }])
  const dir = mkdtempSync(join(tmpdir(), 'wc-spaces-'))
  const fake = await startFakeGateway({ seed: fakeSeed(acmeServer), me: acme.me, board: acme.board })
  const tokenPath = join(dir, 'acme.token')
  writeFileSync(tokenPath, fake.token)
  const cfg = { ...wsCfg(dir), gatewayUrl: fake.url, consoleTokenPath: tokenPath }
  const up = async () => {
    const s = await makeSpace(acmeServer, { cfg, home: dir, artifactsDir: join(dir, 'arts'), sdk: fakeSdk().sdk, fake: false, push: async () => {} })
    s.source.start()
    await until(() => s.source.available())
    return s
  }
  const pb: Playbook = { n: 'Tell', custom: 1, ph: [{ c: 'TL', n: 'Tell', s: [{ id: 'tell/post', fid: 'post', t: 'Post it', m: 'you', x: 'Posted', msg: 1 }] }] }
  const msg: Tpl[] = [['chat', 'team chat', 'hi all, {key} is done.']]
  let a: Space | undefined, b: Space | undefined
  try {
    a = await up()
    await a.putPlaybook('tell', pb, { 'tell/post': msg })
    assert.deepEqual(a.ctx().TPL['tell/post'], msg)
    const j = await a.jobs.create({ t: 'Tell them', key: 'ACME-77', pb: 'tell', prj: acme.pack.prj[0], ws: 'acme' })
    await a.jobs.cmd(j.id, { op: 'start' })
    await a.close(); a = undefined

    b = await up()
    await until(() => 'tell/post' in b!.ctx().TPL)
    assert.ok(b.ctx().TPL[Object.keys(acme.templates!)[0]], 'the built-in ones are there too')
    const sent = (await b.jobs.cmd(j.id, { op: 'sent', step: 'tell/post', i: 0, t: 'hi all, ACME-77 is done.', to: 'team chat' })).job
    assert.equal(sent.flow['tell/post'].sent[0]?.t, 'hi all, ACME-77 is done.')
  } finally { await a?.close(); await b?.close(); await fake.close() }
})

test("a managed workspace's runs get exactly its grants' runTools, and its plugins reach only its granted hosts", async () => {
  install([{ page: acme }])
  const dir = mkdtempSync(join(tmpdir(), 'wc-spaces-')), root = join(dir, 'console')
  mkdirSync(join(root, 'workspaces', 'acme'), { recursive: true })
  writeFileSync(join(root, 'workspaces', 'acme', 'grants.json'), JSON.stringify({ runTools: ['Grep'], hosts: ['api.example.com'] }))
  let http: PluginCtx['http'] | undefined
  const w: WorkspaceServer = { ...acmeServer, plugins: (x) => { http = x.http; return [] } }
  const o = { home: dir, artifactsDir: join(dir, 'arts'), sdk: fakeSdk().sdk, fake: true, push: async () => {} }
  const managed = await makeSpace(w, { ...o, cfg: { ...wsCfg(dir), runTools: ['Read', 'Bash'] }, root })
  try {
    assert.deepEqual(managed.cfg.runTools, ['Grep'])
    assert.deepEqual(managed.grants?.hosts, ['api.example.com'])
    await assert.rejects(http!('https://evil.example/'), /host_not_granted/)
  } finally { await managed.close() }
  const plain = await makeSpace(w, { ...o, cfg: { ...wsCfg(dir), runTools: ['Read', 'Bash'] }, root: join(dir, 'other') })
  try {
    assert.deepEqual(plain.cfg.runTools, ['Read', 'Bash'])
    assert.equal(plain.grants, null)
  } finally { await plain.close() }
})
