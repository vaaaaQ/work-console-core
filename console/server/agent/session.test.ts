import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentRec, Grants } from '../../src/model/agent.ts'
import { Bus } from '../events.ts'
import type { Ev } from '../events.ts'
import type { AskTool, Sdk, SdkEvent } from '../llm/sdk.ts'
import { Restarter } from '../restart.ts'
import type { Applied } from './ops.ts'
import { agentRecords } from './records.ts'
import { AgentSession } from './session.ts'
import type { SessionOps } from './session.ts'

type Turn = { prompt: string; resume?: string; system: string; tools: AskTool[]; abort: AbortController }
type Script = (t: Turn) => AsyncIterable<SdkEvent>

const ok = (sha: string, summary: string, files = ['workspaces/w1/page.ts']): Applied => ({ ok: true, sha, summary, files })

function setup(o: { grants?: Partial<Grants>; script?: Script[]; recs?: AgentRec[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wc-session-'))
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
    acceptGrants: async (ws, g, reason) => { calls.push(['grants', ws, g, reason]); restarter.want(); return ok('c'.repeat(40), `grants — ${reason}`, ['workspaces/w1/grants.json']) },
  }
  const sdk: Sdk = {
    start: () => { throw new Error('not here') },
    agent: (t) => { turns.push(t); const f = script.shift(); if (!f) throw new Error('no turn scripted'); return f(t) },
  }
  const bus = new Bus(), events: Ev[] = []
  bus.on((e) => events.push(e))
  const records = agentRecords({} as never, file)
  const s = new AgentSession({ ws: 'w1', title: 'One', root, records, sdk, ops, bus, hold: () => restarter.hold(), taken: () => ({ ids: ['w1'], prefixes: ['W'] }) })
  return { s, root, file, calls, turns, events, records, restarts: () => restarts }
}

const tool = (t: Turn, name: string) => t.tools.find((x) => x.name === name)!
async function* reply(text: string, session = 's1'): AsyncIterable<SdkEvent> {
  yield { k: 'session', id: session }
  yield { k: 'text', t: text }
  yield { k: 'result', ok: true, t: text }
}

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
