import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FailedUpdate } from '../../scripts/update.mjs'
import type { AgentRec, Grants } from '../../src/model/agent.ts'
import { Bus } from '../events.ts'
import type { Ev } from '../events.ts'
import { Jobs } from '../jobs/jobs.ts'
import { notesStore } from '../knowledge/notes.ts'
import type { AskTool, Sdk, SdkEvent } from '../llm/sdk.ts'
import { Restarter } from '../restart.ts'
import type { Applied } from './ops.ts'
import type { JobDeps } from './jobTools.ts'
import { agentRecords } from './records.ts'
import { AgentSession } from './session.ts'
import type { Reintegration, SessionOps, UpdateEnd } from './session.ts'
import type { Limits } from './limits.ts'
import { fileStore } from '../store/file.ts'
import { demoCtx } from '../testkit.ts'
import { tempDir } from '../testdirs.ts'

type Turn = { prompt: string; resume?: string; system: string; tools: AskTool[]; limits: Limits; abort: AbortController }
type Script = (t: Turn) => AsyncIterable<SdkEvent>

const ok = (sha: string, summary: string, files = ['workspaces/w1/page.ts']): Applied => ({ ok: true, sha, summary, files })

const CORE = 'e'.repeat(40), FROM = 'f'.repeat(40)
/** a failed update whose worktree is a folder beside the console's */
const failedAt = (root: string, o: Partial<FailedUpdate> = {}): FailedUpdate => {
  const worktree = join(root, 'updates', 'eeeeeee'), dir = join(worktree, 'console')
  mkdirSync(join(dir, 'workspaces', 'w1'), { recursive: true })
  return { core: CORE, from: FROM, repo: root, branch: 'update/eeeeeee', worktree, dir, pre: 'p', head: 'h', step: 'typecheck',
    output: "workspaces/w1/page.ts(3,7): error TS2353: 'needDb' does not exist in type 'LocalOpts'", at: new Date().toISOString(), ...o }
}

function setup(o: { grants?: Partial<Grants>; script?: Script[]; recs?: AgentRec[]; update?: Partial<FailedUpdate>; ends?: ((f: FailedUpdate) => FailedUpdate | null)[]; managed?: boolean; max?: number; noAgent?: boolean; job?: JobDeps } = {}) {
  const root = tempDir('session')
  mkdirSync(join(root, 'workspaces', 'w1'), { recursive: true })
  if (o.grants) writeFileSync(join(root, 'workspaces', 'w1', 'grants.json'), JSON.stringify(o.grants))
  const file = join(root, 'home', 'agent', 'w1.json')
  if (o.recs) { mkdirSync(join(root, 'home', 'agent'), { recursive: true }); writeFileSync(file, JSON.stringify(o.recs)) }
  let restarts = 0
  const restarter = new Restarter(() => { restarts++ })
  const calls: unknown[][] = [], turns: Turn[] = [], script = [...(o.script ?? [])]
  const ops: SessionOps = {
    check: async () => ({ ok: true, failures: [] }),
    apply: async (ws, s) => { calls.push(['apply', ws, s]); restarter.want(); return ok('a'.repeat(40), s) },
    undo: async (ws, sha) => { calls.push(['undo', ws, sha]); restarter.want(); return ok('b'.repeat(40), 'undo — x') },
    createWorkspace: async () => ({ ok: false, error: 'no' }),
    remove: async (_ws, p) => ({ ok: true, path: p }),
    acceptGrants: async (ws, g, reason) => { calls.push(['grants', ws, g, reason]); restarter.want(); return ok('c'.repeat(40), `grants — ${reason}`, ['workspaces/w1/grants.json']) },
  }
  const sdk: Sdk = {
    start: () => { throw new Error('not here') },
    ...(o.noAgent ? {} : { agent: (t: Turn) => { turns.push(t); const f = script.shift(); if (!f) throw new Error('no turn scripted'); return f(t) } }),
  }
  const bus = new Bus(), events: Ev[] = []
  bus.on((e) => events.push(e))
  const records = agentRecords({} as never, file)
  // the update: its record, ops that note where they ran, and runs of update.mjs that end as ends says (default: applied)
  const u = { failed: o.update ? failedAt(root, o.update) : null as FailedUpdate | null, updating: false, runs: [] as [string, boolean][] }
  const ends = [...(o.ends ?? [])]
  const reintegration: Reintegration = {
    failed: () => u.failed,
    diff: async () => 'diff --git a/server/browser/local.ts b/server/browser/local.ts\n-  needDb?: boolean\n+  db?: boolean',
    opsAt: (dir) => ({ ...ops,
      check: async () => { calls.push(['check', dir]); return { ok: true, failures: [] } },
      apply: async (ws, s) => { calls.push(['apply', ws, s, dir]); return ok('d'.repeat(40), s) } }),
    updating: () => u.updating,
    run: async (kind, report) => {
      u.runs.push([kind, restarter.holding])
      const was = u.failed!, next = kind === 'give-up' ? null : (ends.shift() ?? (() => null))(was)
      u.failed = next
      const r: UpdateEnd = { code: next ? 3 : 0, output: next ? next.output : 'updated', updated: kind === 'apply' && !next, failed: next }
      await report(r)
      return r
    },
  }
  const s = new AgentSession({ ws: 'w1', title: 'One', root, records, sdk, ops, bus, hold: () => restarter.hold(), taken: () => ({ ids: ['w1'], prefixes: ['W'] }), reintegration, managed: o.managed ?? true, max: o.max, job: o.job })
  return { s, root, file, calls, turns, events, records, u, restarts: () => restarts }
}

const tool = (t: Turn, name: string) => t.tools.find((x) => x.name === name)!
async function* reply(text: string, session = 's1'): AsyncIterable<SdkEvent> {
  yield { k: 'session', id: session }
  yield { k: 'text', t: text }
  yield { k: 'result', ok: true, t: text }
}
/** a scripted turn that answers text once go is called */
function held(text: string) {
  let go!: () => void
  const gate = new Promise<void>((ok) => { go = ok })
  const f: Script = async function* () { yield { k: 'session', id: `s-${text}` }; await gate; yield { k: 'result', ok: true, t: text } }
  return { f, go }
}
const tick = (ms = 20) => new Promise((ok) => setTimeout(ok, ms))
async function until(f: () => boolean | Promise<boolean>, ms = 3000) {
  for (const t0 = Date.now(); !(await f());) { if (Date.now() - t0 > ms) throw new Error('timed out'); await tick(5) }
}
const CODE_TOOLS = ['check', 'apply', 'undo', 'propose_grants', 'create_workspace']
const codeTools = (t: Turn) => t.tools.map((y) => y.name).filter((n) => CODE_TOOLS.includes(n))

test("a turn is recorded: the person's text, the agent's answer and tools, the session to resume by", async () => {
  const x = setup({ grants: { packs: ['p'] }, script: [
    async function* (t) { yield { k: 'session', id: 's1' }; yield { k: 'tool', name: 'check', input: '{}' }; yield { k: 'text', t: await tool(t, 'check').run({}) }; yield { k: 'result', ok: true, t: 'The check passed.' } },
    () => reply('again', 's1'),
  ] })
  const { rec, done } = await x.s.send('  check it  ')
  assert.equal(rec.status, 'running')
  await done
  const r = (await x.s.current())!
  assert.equal(r.status, 'idle')
  assert.equal(r.session, 's1')
  assert.deepEqual(r.turns.map((t) => [t.who, t.t]), [['you', 'check it'], ['tool', 'check {}'], ['agent', 'The check passed.']])
  assert.equal(x.turns[0].prompt, 'check it')
  assert.equal(x.turns[0].resume, undefined)
  assert.ok(x.events.some((e) => e.kind === 'agent' && e.agent.status === 'idle'))
  const ups = x.events.flatMap((e) => (e.kind === 'agent' ? [e.agent.updated] : []))
  assert.ok(ups.every((u, i) => i === 0 || u > ups[i - 1]), 'each frame is later than the one before')
  await (await x.s.send('more')).done
  assert.equal(x.turns[1].resume, 's1', 'the next turn resumes the session')
  const stored = await x.records.all()
  assert.equal(stored.length, 1)
  assert.equal(stored[0].turns.length, 5)
})

test('apply during a turn restarts the console only after the turn ends', async () => {
  let go!: () => void
  const gate = new Promise<void>((ok) => { go = ok })
  const x = setup({ grants: { packs: ['p'] }, script: [async function* (t) {
    yield { k: 'session', id: 's1' }
    yield { k: 'text', t: await tool(t, 'apply').run({ summary: 'show the counter' }) }
    await gate
    yield { k: 'result', ok: true }
  }] })
  const { done } = await x.s.send('add a counter')
  while (!x.calls.length) await new Promise((ok) => setTimeout(ok, 5))
  await new Promise((ok) => setTimeout(ok, 20))
  assert.equal(x.restarts(), 0, 'not while the turn runs')
  go(); await done
  assert.equal(x.restarts(), 1)
  const r = (await x.s.current())!
  assert.deepEqual(r.commits.map((c) => [c.kind, c.summary]), [['apply', 'show the counter']])
  assert.match(r.turns.at(-1)!.t, /^Applied aaaaaaaa/)
})

test('a new workspace opens with an interview; its propose_grants puts a change in Approvals with its diff lines', async () => {
  const x = setup({ grants: {}, script: [async function* (t) {
    yield { k: 'session', id: 's1' }
    yield { k: 'text', t: await tool(t, 'propose_grants').run({ change: { hosts: ['api.example.com'] }, reason: 'read the tracker' }) }
    yield { k: 'result', ok: true }
  }, () => reply('fine')] })
  await (await x.s.send('hello')).done
  assert.match(x.turns[0].system, /interview the person, one question at a time/)
  const r = (await x.s.current())!
  assert.equal(r.interview, true)
  assert.equal(r.pending?.reason, 'read the tracker')
  assert.deepEqual(r.pending?.change.hosts, ['api.example.com'])
  assert.deepEqual(r.pending?.diff, ['+ host api.example.com'])
  const n = await x.s.fresh()
  assert.equal(n.interview, undefined, 'a later conversation is no interview')
  assert.equal(n.pending?.reason, 'read the tracker', 'the waiting change moves with it')
  await (await x.s.send('next')).done
  assert.doesNotMatch(x.turns[1].system, /interview/i)
})

test('a rejection sends its reason back into the session: at once when idle, after the turn when not', async () => {
  let go!: () => void
  const gate = new Promise<void>((ok) => { go = ok })
  const propose = async function* (t: Turn): AsyncIterable<SdkEvent> {
    yield { k: 'session', id: 's1' }
    await tool(t, 'propose_grants').run({ change: { hosts: ['x.example.com'] }, reason: 'reach x' })
    yield { k: 'result', ok: true, t: 'asked' }
  }
  const x = setup({ grants: { packs: ['p'] }, script: [propose, () => reply('understood'), async function* (t) {
    yield* propose(t); await gate
  }, () => reply('ok, without it')] })
  await (await x.s.send('reach x')).done
  const r = await x.s.decide(false, '  too   wide ')
  assert.equal(r.status, 'running')
  assert.equal(r.pending, undefined)
  assert.ok(r.turns.some((t) => t.who === 'note' && t.t === 'Grants change rejected: too wide'))
  assert.match(x.turns[1].prompt, /rejected your grants change "reach x"\. Their reason: too wide/)
  while ((await x.s.current())!.status === 'running') await new Promise((ok) => setTimeout(ok, 5))

  const { done } = await x.s.send('try again')
  while (!(await x.s.current())!.pending) await new Promise((ok) => setTimeout(ok, 5))
  const mid = await x.s.decide(false, 'still no')
  assert.equal(mid.inbox?.length, 1, 'heard after the turn')
  go(); await done
  while (x.turns.length < 4 || (await x.s.current())!.status === 'running') await new Promise((ok) => setTimeout(ok, 5))
  assert.match(x.turns[3].prompt, /Their reason: still no/)
  assert.equal((await x.s.current())!.inbox, undefined)
  await assert.rejects(x.s.decide(false, 'x'), /no grants change waits/)
})

test('accepting commits the grants and restarts; the agent hears it with the next message', async () => {
  const x = setup({ grants: { packs: ['p'] }, script: [async function* (t) {
    yield { k: 'session', id: 's1' }
    await tool(t, 'propose_grants').run({ change: { packs: ['p'], hosts: ['api.example.com'] }, reason: 'read the tracker' })
    yield { k: 'result', ok: true, t: 'asked' }
  }, () => reply('thanks')] })
  await (await x.s.send('go')).done
  assert.equal(x.restarts(), 0)
  const r = await x.s.decide(true, '')
  assert.deepEqual(x.calls.at(-1), ['grants', 'w1', { packs: ['p'], hosts: ['api.example.com'], acts: [], runTools: [], mcp: {} }, 'read the tracker'])
  assert.equal(x.restarts(), 1)
  assert.equal(r.pending, undefined)
  assert.deepEqual(r.commits.map((c) => c.kind), ['grants'])
  await (await x.s.send('carry on')).done
  assert.match(x.turns[1].prompt, /^The person accepted your grants change "read the tracker" \(cccccccc\).*\n\ncarry on$/s)
})

test('one turn at a time; Stop ends it idle; the page can undo an apply and the agent hears of it', async () => {
  const x = setup({ grants: { packs: ['p'] }, script: [async function* (t) {
    yield { k: 'session', id: 's1' }
    await tool(t, 'apply').run({ summary: 'a board' })
    await new Promise((_ok, no) => t.abort.signal.addEventListener('abort', () => no(new Error('aborted'))))
  }, () => reply('seen')] })
  const { done } = await x.s.send('make a board')
  await assert.rejects(x.s.send('again'), /still answering/)
  while (!x.calls.length) await new Promise((ok) => setTimeout(ok, 5))
  await assert.rejects(x.s.undo('a'.repeat(40)), /still answering/, 'no undo under a running turn')
  x.s.stop(); await done
  let r = (await x.s.current())!
  assert.equal(r.status, 'idle')
  assert.equal(r.turns.at(-1)!.t, 'Stopped.')
  assert.equal(x.restarts(), 1, 'the apply restarts once the stopped turn ends')
  assert.throws(() => x.s.stop(), /not answering/)
  r = await x.s.undo('a'.repeat(40))
  assert.deepEqual(x.calls.at(-1), ['undo', 'w1', 'a'.repeat(40)])
  assert.equal(r.commits[0].undoneBy, 'b'.repeat(40))
  await assert.rejects(x.s.undo('a'.repeat(40)), /already undone/)
  await (await x.s.send('ok')).done
  assert.match(x.turns[1].prompt, /^The person undid your commit aaaaaaaa "a board"/)
})

test('a turn the console stopped in is failed when the records are read again', async () => {
  const at = new Date().toISOString()
  const x = setup({ grants: { packs: ['p'] }, recs: [{ id: 'r1', ws: 'w1', provider: 'claude', session: 's0', turns: [], commits: [], status: 'running', created: at, updated: at }] })
  const r = (await x.s.current())!
  assert.equal(r.status, 'failed')
  assert.match(r.error!, /stopped during the turn/)
})

test("a reintegration works in the update's worktree: the failing output and the core diff, its tools, and update.mjs once the turn ends", async () => {
  const fix = (summary: string) => async function* (t: Turn): AsyncIterable<SdkEvent> {
    yield { k: 'session', id: 's9' }
    yield { k: 'text', t: await tool(t, 'apply').run({ summary }) }
    yield { k: 'result', ok: true }
  }
  const x = setup({ grants: { packs: ['p'] }, update: {}, script: [fix('db, not needDb'), fix('the board test too')],
    ends: [(f) => ({ ...f, step: 'tests', output: 'not ok 3 - the board keys' })] })
  const dir = x.u.failed!.dir
  const { rec, done } = await x.s.reintegrate()
  assert.equal(rec.status, 'running')
  assert.deepEqual(rec.reintegrate, { core: CORE, from: FROM, branch: 'update/eeeeeee', step: 'typecheck' })
  await done
  const t = x.turns[0]
  assert.match(t.prompt, /from core fffffff to eeeeeee failed at typecheck/)
  assert.match(t.prompt, /TS2353: 'needDb'/)
  assert.match(t.prompt, /\+  db\?: boolean/)
  assert.equal(t.limits.cwd, dir, 'the turn writes in the worktree')
  assert.deepEqual(t.limits.write, ['workspaces/w1/**', 'tools/**'])
  assert.deepEqual(t.tools.map((y) => y.name), ['check', 'apply', 'give_up'])
  assert.match(t.system, /update\/eeeeeee/)
  assert.deepEqual(x.calls, [['apply', 'w1', 'db, not needDb', dir]], 'committed in the worktree, nothing in the folder')
  assert.deepEqual(x.u.runs, [['apply', false]], 'update.mjs runs after the turn let go of the console')
  let r = (await x.s.current())!
  assert.equal(r.reintegrate?.end, 'apply')
  assert.match(r.turns.at(-1)!.t, /failed again at tests/)
  assert.deepEqual(r.commits.map((c) => [c.kind, c.summary]), [['reintegrate', 'db, not needDb']])
  await assert.rejects(x.s.undo('d'.repeat(40)), /cannot be undone here/)

  await (await x.s.send('go on')).done
  assert.match(x.turns[1].prompt, /failed again at tests[\s\S]*not ok 3 - the board keys[\s\S]*go on$/)
  assert.equal(x.turns[1].resume, 's9')
  assert.deepEqual(x.u.runs.map((y) => y[0]), ['apply', 'apply'])
  r = (await x.s.current())!
  assert.match(r.turns.at(-1)!.t, /The update applied/)
  assert.equal(x.restarts(), 0, 'the restart is the update run, not the session')
  await assert.rejects(x.s.send('anything else?'), /is over/)
  const n = await x.s.fresh()
  assert.equal(n.reintegrate, undefined)
})

test('a reintegration is refused with no update, for a sync failure and during a turn; give_up drops it; no turn starts while the console updates', async () => {
  const x = setup({ grants: { packs: ['p'] }, script: [async function* (t) {
    yield { k: 'session', id: 's1' }
    yield { k: 'text', t: await tool(t, 'give_up').run({ reason: 'the fix is in a core file' }) }
    yield { k: 'result', ok: true }
  }] })
  await assert.rejects(x.s.reintegrate(), /no core update waits/)
  x.u.failed = failedAt(x.root, { step: 'sync' })
  await assert.rejects(x.s.reintegrate(), /failed at sync/)
  x.u.failed = failedAt(x.root)
  const { done } = await x.s.reintegrate()
  await assert.rejects(x.s.reintegrate(), /still answering/)
  await done
  assert.deepEqual(x.u.runs, [['give-up', false]])
  assert.equal(x.u.failed, null)
  const r = (await x.s.current())!
  assert.equal(r.reintegrate?.end, 'give-up')
  assert.ok(r.turns.some((y) => y.who === 'agent' && /dropped/.test(y.t)))
  assert.match(r.turns.at(-1)!.t, /given up/)
  await assert.rejects(x.s.send('and now?'), /is over/)
  await x.s.fresh()
  x.u.updating = true
  await assert.rejects(x.s.send('hello'), /the console is updating/)
})

test('a reintegrate turn stopped after its apply runs no update; the banner is left to do it', async () => {
  const x = setup({ grants: { packs: ['p'] }, update: {}, script: [async function* (t) {
    yield { k: 'session', id: 's1' }
    await tool(t, 'apply').run({ summary: 'a fix' })
    // stopped as soon as the apply is seen, maybe before this line
    await new Promise((_ok, no) => t.abort.signal.aborted ? no(new Error('aborted')) : t.abort.signal.addEventListener('abort', () => no(new Error('aborted'))))
  }] })
  const { done } = await x.s.reintegrate()
  while (!x.calls.length) await new Promise((ok) => setTimeout(ok, 5))
  x.s.stop(); await done
  assert.deepEqual(x.u.runs, [])
  const r = (await x.s.current())!
  assert.equal(r.reintegrate?.end, undefined)
  assert.ok(r.turns.some((y) => y.who === 'note' && /Apply on the banner runs it/.test(y.t)))
})

/* ===== a conversation per job ===== */
test("a job's conversation is its own: two jobs' turns run side by side", async () => {
  const one = held('one'), two = held('two')
  const x = setup({ grants: { packs: ['p'] }, script: [one.f, two.f, () => reply('three', 's-one')] })
  const a = await x.s.send('look at J-1', { job: 'J-1' }), b = await x.s.send('look at J-2', { job: 'J-2' })
  assert.notEqual(a.rec.id, b.rec.id)
  assert.deepEqual([a.rec.job, b.rec.job], ['J-1', 'J-2'])
  await until(() => x.turns.length === 2)
  two.go(); await b.done
  one.go(); await a.done
  assert.equal((await x.s.get({ job: 'J-1' }))!.turns.at(-1)!.t, 'one')
  assert.equal((await x.s.get({ conv: b.rec.id }))!.turns.at(-1)!.t, 'two')
  assert.equal(await x.s.current(), null, 'no general conversation was made')
  await (await x.s.send('and then?', { job: 'J-1' })).done
  assert.equal(x.turns[2].resume, 's-one', "the job's next message goes on in its conversation")
  const cs = await x.s.convs()
  assert.deepEqual(cs.map((c) => [c.job, c.title, c.status]), [['J-1', 'look at J-1', 'idle'], ['J-2', 'look at J-2', 'idle']])
})

test('a second send to the same conversation while it answers is busy; another job\'s is not', async () => {
  const one = held('one'), two = held('two')
  const x = setup({ grants: { packs: ['p'] }, script: [one.f, two.f] })
  const a = await x.s.send('one', { job: 'J-1' })
  await assert.rejects(x.s.send('again', { job: 'J-1' }), /still answering/)
  await assert.rejects(x.s.send('again', { conv: a.rec.id }), /still answering/)
  const b = await x.s.send('other', { job: 'J-2' })
  await assert.rejects(x.s.send('x', { conv: 'nope' }), /no conversation nope/)
  assert.throws(() => x.s.stop('nope'), /not answering/)
  one.go(); two.go(); await a.done; await b.done
})

test('past max turns, the next waits for a slot and then runs', async () => {
  const one = held('one'), two = held('two'), three = held('three')
  const x = setup({ grants: { packs: ['p'] }, max: 2, script: [one.f, two.f, three.f] })
  const a = await x.s.send('a', { job: 'J-1' }), b = await x.s.send('b', { job: 'J-2' })
  const c = await x.s.send('c', { job: 'J-3' }), d = await x.s.send('d', { job: 'J-4' })
  assert.equal(c.rec.status, 'running', 'marked running while it waits')
  await until(() => x.turns.length === 2)
  await tick(30)
  assert.equal(x.turns.length, 2, 'the third and fourth wait')
  x.s.stop(d.rec.id); await d.done
  const r = (await x.s.get({ job: 'J-4' }))!
  assert.deepEqual([r.status, r.turns.at(-1)!.t], ['idle', 'Stopped.'])
  one.go(); await a.done
  await until(() => x.turns.length === 3)
  assert.equal(x.turns[2].prompt, 'c')
  two.go(); three.go(); await b.done; await c.done
  assert.equal(x.turns.length, 3, 'the stopped one never ran')
})

test('an unmanaged workspace has an agent without code tools and with no write area; no interview', async () => {
  const x = setup({ managed: false, script: [() => reply('hi')] })
  await (await x.s.send('hello')).done
  const t = x.turns[0]
  assert.deepEqual(codeTools(t), [])
  assert.deepEqual([t.limits.cwd, t.limits.write], [x.root, []])
  assert.doesNotMatch(t.system, /interview|propose_grants|apply \{summary\}/)
  assert.equal((await x.s.current())!.interview, undefined)
})

test('a job conversation gets read-only limits even in a managed workspace', async () => {
  const x = setup({ grants: {}, script: [() => reply('ok'), () => reply('hi')] })
  await (await x.s.send('look', { job: 'J-1' })).done
  assert.deepEqual(x.turns[0].limits.write, [])
  assert.deepEqual(codeTools(x.turns[0]), [])
  assert.equal((await x.s.get({ job: 'J-1' }))!.interview, undefined, 'a job conversation is no interview')
  await (await x.s.send('hello')).done
  assert.deepEqual(x.turns[1].limits.write, ['workspaces/w1/**', 'tools/**'])
  assert.deepEqual(codeTools(x.turns[1]), CODE_TOOLS)
  assert.equal((await x.s.current())!.interview, true, 'the general one of empty grants still is')
})

test('hear with turn starts one when idle and one more after a running turn, with every line heard', async () => {
  const one = held('first')
  const x = setup({ grants: { packs: ['p'] }, script: [one.f, () => reply('second', 's-first')] })
  await x.s.hear({ job: 'J-1' }, 'A reply came in: yes', true)
  await until(() => x.turns.length === 1)
  assert.equal(x.turns[0].prompt, 'A reply came in: yes')
  await x.s.hear({ job: 'J-1' }, 'line two', true)
  await x.s.hear({ job: 'J-1' }, 'line three', false)
  one.go()
  await until(async () => x.turns.length === 2 && (await x.s.get({ job: 'J-1' }))!.status === 'idle')
  assert.equal(x.turns[1].prompt, 'line two\n\nline three')
  const r = (await x.s.get({ job: 'J-1' }))!
  assert.equal(r.inbox, undefined)
  assert.ok(!r.turns.some((t) => t.who === 'you'), "heard lines are not the person's")
  await x.s.hear({ job: 'J-2' }, 'for later', false)
  await tick()
  assert.equal(x.turns.length, 2, 'no turn without turn')
  assert.deepEqual((await x.s.get({ job: 'J-2' }))!.inbox, ['for later'])
})

test('hear when the provider cannot be an agent notes it in the conversation', async () => {
  const x = setup({ grants: { packs: ['p'] }, noAgent: true })
  await x.s.hear({ job: 'J-1' }, 'A reply came in', true)
  const r = (await x.s.get({ job: 'J-1' }))!
  assert.match(r.turns.at(-1)!.t, /^The agent could not answer: .*cannot be a workspace agent/)
  assert.equal(r.status, 'idle')
  assert.deepEqual(r.inbox, ['A reply came in'], 'the line waits for the next turn')
})

test('retry on a failed conversation carries on; on an idle one it is refused', async () => {
  const x = setup({ grants: { packs: ['p'] }, script: [async function* () { yield { k: 'session', id: 's1' }; yield { k: 'result', ok: false, error: 'overloaded' } }, () => reply('carried on')] })
  await (await x.s.send('do it', { job: 'J-1' })).done
  let r = (await x.s.get({ job: 'J-1' }))!
  assert.deepEqual([r.status, r.error], ['failed', 'overloaded'])
  await (await x.s.retry(r.id)).done
  assert.equal(x.turns[1].prompt, 'Your last turn was cut off before it ended: carry on from where it stopped.')
  assert.equal(x.turns[1].resume, 's1')
  r = (await x.s.get({ job: 'J-1' }))!
  assert.equal(r.status, 'idle')
  assert.deepEqual(r.turns.filter((t) => t.who === 'you').map((t) => t.t), ['do it'])
  await assert.rejects(x.s.retry(r.id), /did not fail/)
  await assert.rejects(x.s.retry('nope'), /no conversation nope/)
})

test("a job conversation's turn reads the job between the heard lines and the text, with the job tools; a general one reads the open jobs", async () => {
  const jobs = new Jobs({ store: fileStore(join(tempDir('sj'), 's.json')), bus: new Bus(), ctx: demoCtx, gate: () => true })
  const c = await jobs.create({ t: 'Local stand', key: 'K-1', pb: 'action', prj: 'p', ws: 'acme' })
  const j = (await jobs.cmd(c.id, { op: 'start' }, c.v)).job
  const job: JobDeps = { jobs, runs: async () => [], ctx: demoCtx, notes: notesStore(join(tempDir('sj-kn'), 'kn')), source: null, key: (i) => i, proposer: { propose: async () => '' } }
  const x = setup({ grants: { packs: ['p'] }, job, script: [() => reply('ok'), () => reply('hi')] })
  await x.s.hear({ job: j.id }, 'A reply came in: yes', false)
  await (await x.s.send('what now?', { job: j.id })).done
  const t = x.turns[0], NL = String.fromCharCode(10)
  assert.ok(t.prompt.startsWith(`A reply came in: yes${NL}${NL}# The job now: ${j.id} “Local stand”`), t.prompt)
  assert.ok(t.prompt.endsWith(`${NL}${NL}what now?`))
  assert.match(t.system, new RegExp(`job ${j.id} “Local stand”`))
  assert.deepEqual(t.tools.map((y) => y.name), ['list_jobs', 'get_job', 'step_output', 'propose', 'knowledge_search', 'knowledge_read'])
  await (await x.s.send('hello')).done
  const g = x.turns[1]
  assert.ok(g.prompt.startsWith('# Open jobs (newest first)') && g.prompt.includes(j.id) && g.prompt.endsWith(`${NL}${NL}hello`), g.prompt)
  assert.deepEqual(g.tools.map((y) => y.name).slice(0, 4), ['list_jobs', 'get_job', 'step_output', 'propose'])
  assert.deepEqual(codeTools(g), CODE_TOOLS)
})
