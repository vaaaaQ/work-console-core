import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as T from '../../src/model/transitions.ts'
import type { Playbook } from '../../src/model/types.ts'
import { install } from '../../src/workspace.ts'
import type { WorkspacePage } from '../../src/workspace.ts'
import { startItem } from '../board/start.ts'
import { GatewayError } from '../bridge/wire.ts'
import type { ActReq } from '../bridge/wire.ts'
import { Bus } from '../events.ts'
import { Jobs } from '../jobs/jobs.ts'
import { notesStore } from '../knowledge/notes.ts'
import { Runner } from '../llm/runner.ts'
import { Spaces } from '../spaces.ts'
import type { Space } from '../spaces.ts'
import { fileStore } from '../store/file.ts'
import { acme, demoCtx, demoSeed, fakeSdk } from '../testkit.ts'
import { jobTools, mcpHandler } from './mcp.ts'
import { tempDir } from '../testdirs.ts'

const TOKEN = 'a'.repeat(64)

/** Acme under another id, with its own projects and its own start playbook */
const beta: WorkspacePage = {
  ...acme, id: 'beta', playbooks: {}, pack: { ...acme.pack, prj: ['labs'] },
  board: { start: 'action', key: (id) => `beta/${id}`, itemId: (k) => (k.startsWith('beta/') ? k.slice(5) : null) },
}

/** a workspace's space reduced to what the tools read: its jobs on a file store, its start, its page.
    Acme's prefix is J, the one the demo seed's jobs carry. */
function stubSpace(page: WorkspacePage, prefix: string, open: { v: boolean }, seed?: typeof demoSeed) {
  const store = fileStore(join(tempDir('mcp'), 's.json'), seed, prefix)
  const bus = new Bus(), { sdk, sessions } = fakeSdk()
  const jobs = new Jobs({ store, bus, ctx: demoCtx, gate: () => open.v })
  const runner = new Runner({ store, jobs, bus, sdk, cwd: tmpdir(), gate: () => open.v, artifactsDir: tempDir('mcp-arts'), ctx: demoCtx })
  const acts: ActReq[] = []
  const bridge = { available: () => true, read: async () => ({}), act: async (a: ActReq) => { acts.push(a); return { status: 'ok' as const, result: { title: `Item ${a.args.id}` } } } }
  const notes = notesStore(join(tempDir('kn'), 'kn'))
  const space = { id: page.id, prefix, page, jobs, runner, ctx: demoCtx, notes, start: startItem({ jobs, ctx: demoCtx, bridge, page }) } as unknown as Space
  return { space, jobs, acts, notes, sessions, runner }
}

/** client = the clientInfo name initialize sends; null = none */
async function setup(t: { after(f: () => unknown): void }, o: { open?: { v: boolean }; both?: boolean; client?: string | null } = {}) {
  const open = o.open ?? { v: true }
  install(o.both ? [{ page: acme }, { page: beta }] : [{ page: acme }])
  const a = stubSpace(acme, 'J', open, demoSeed), b = o.both ? stubSpace(beta, 'B', open) : undefined
  const spaces = new Spaces(b ? [a.space, b.space] : [a.space])
  const srv = createServer(mcpHandler({ tools: jobTools({ spaces }), token: () => TOKEN }))
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  t.after(() => new Promise((r) => srv.close(r)))
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/mcp`
  let sid = '', n = 0
  const post = async (body: unknown, token = TOKEN) => {
    const res = await fetch(url, {
      method: 'POST', body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, ...(sid ? { 'mcp-session-id': sid } : {}) },
    })
    return { status: res.status, sid: res.headers.get('mcp-session-id'), body: res.status === 202 ? null : await res.json() }
  }
  const rpc = async (method: string, params?: unknown) => (await post({ jsonrpc: '2.0', id: ++n, method, params })).body
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await rpc('tools/call', { name, arguments: args })).result
    return { err: !!r.isError, text: r.content[0].text as string, json: () => JSON.parse(r.content[0].text) }
  }
  const init = await post({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, ...(o.client === null ? {} : { clientInfo: { name: o.client ?? 'Claude Code', version: '1' } }) } })
  sid = init.sid!
  return { jobs: a.jobs, acts: a.acts, notes: a.notes, sessions: a.sessions, runner: a.runner, beta: b, spaces, open, post, rpc, call, init, setSid: (s: string) => { sid = s } }
}
const openJob = async (jobs: Jobs) => {
  const x = demoCtx()
  return (await jobs.all()).find((j) => !T.isClosed(j) && j.st !== 'recurring' && j.st !== 'draft' && !!T.atOf(x, j))!
}

test('initialize answers the asked protocol, a session id and the tools; a wrong token is 401', async (t) => {
  const s = await setup(t)
  assert.equal(s.init.status, 200)
  assert.equal(s.init.body.result.protocolVersion, '2025-03-26')
  assert.equal(s.init.body.result.serverInfo.name, 'work-console')
  assert.match(s.init.body.result.instructions, /create_job, start_item and the knowledge tools take ws/)
  assert.ok(s.init.sid)
  assert.equal((await s.post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202)
  const names = (await s.rpc('tools/list')).result.tools.map((x: { name: string }) => x.name)
  assert.deepEqual(names, ['list_jobs', 'get_job', 'job_command', 'draft_reply', 'step_context', 'submit_draft', 'job_context', 'return_to', 'create_job', 'start_item', 'undo', 'knowledge_search', 'knowledge_read', 'knowledge_propose', 'list_playbooks'])
  assert.equal((await s.post({ jsonrpc: '2.0', id: 9, method: 'tools/list' }, 'b'.repeat(64))).status, 401)
  assert.equal((await s.rpc('nope')).error.code, -32601)
  assert.equal((await s.post(null)).body.error.code, -32600)
})

test('a command applies at once, is signed Claude Code, and the session undoes it', async (t) => {
  const s = await setup(t), j = await openJob(s.jobs), x = demoCtx(), at = T.atOf(x, j)!
  const r = await s.call('job_command', { id: j.id, op: 'noteAdd', step: T.stepOf(x, j, at)!.t, k: 'q', t: 'which sort order?' })
  assert.equal(r.err, false, r.text)
  const after = (await s.jobs.get(j.id))!
  assert.equal(after.flow[at].b.at(-1)!.t, 'which sort order?', 'a step named by its title resolves to its id')
  assert.equal(after.jr[0].a, 'Claude Code')
  assert.equal((await s.call('undo')).err, false)
  assert.equal((await s.jobs.get(j.id))!.flow[at].b.length, j.flow[at].b.length)
  const none = await s.call('undo')
  assert.equal(none.err, true)
  assert.match(none.text, /nothing to undo/)
})

test('undo belongs to the session that made the change', async (t) => {
  const s = await setup(t), j = await openJob(s.jobs), at = T.atOf(demoCtx(), j)!
  await s.call('job_command', { id: j.id, op: 'noteAdd', step: at, k: 'q', t: 'mine' })
  const other = await s.post({ jsonrpc: '2.0', id: 50, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
  s.setSid(other.sid!)
  assert.equal((await s.call('undo')).err, true)
})

test('return_to keeps the round; refusals come back as tool errors, not protocol errors', async (t) => {
  const s = await setup(t), j = await openJob(s.jobs), x = demoCtx(), at = T.atOf(x, j)!
  const all = T.steps(x, j.pb), i = all.findIndex((st) => st.id === at)
  assert.equal((await s.call('return_to', { id: j.id, step: all[Math.min(i + 1, all.length - 1)].id, why: 'x' })).err, true)
  if (i > 0) {
    const ok = await s.call('return_to', { id: j.id, step: all[0].id, why: 'QA found a regression' })
    assert.equal(ok.err, false, ok.text)
    const back = (await s.jobs.get(j.id))!
    assert.equal(back.rounds!.length, 1)
    assert.equal(back.rounds![0].by, 'Claude Code')
    assert.equal(ok.json().job.round, 2)
  }
  assert.match((await s.call('job_command', { id: j.id, op: 'runDraft', step: at, t: 'x' })).text, /^bad_args/, 'runner ops stay with the runner')
  s.open.v = false
  assert.match((await s.call('job_command', { id: j.id, op: 'noteAdd', step: at, k: 'q', t: 'x' })).text, /^bridge_unavailable/)
})

test('create_job makes a ready job; undo cancels it', async (t) => {
  const s = await setup(t), pb = Object.keys(demoCtx().PB)[0]
  const r = await s.call('create_job', { title: 'From a session', playbook: pb, key: 'ACME-1' })
  assert.equal(r.err, false, r.text)
  const id = r.json().id
  assert.equal((await s.jobs.get(id))!.jr[0].a, 'Claude Code')
  await s.call('undo')
  assert.equal((await s.jobs.get(id))!.st, 'cancelled')
})

test('create_job takes a description; get_job shows it; job_command describe changes it', async (t) => {
  const s = await setup(t), pb = Object.keys(demoCtx().PB)[0]
  const r = await s.call('create_job', { title: 'Described', playbook: pb, key: 'ACME-1', description: 'Check the **quota**.' })
  assert.equal(r.err, false, r.text)
  const id = r.json().id
  assert.equal((await s.call('get_job', { id })).json().description, 'Check the **quota**.')
  const c = await s.call('job_command', { id, op: 'describe', d: 'Now the limit.' })
  assert.equal(c.err, false, c.text)
  assert.equal((await s.jobs.get(id))!.d, 'Now the limit.')
  assert.equal((await s.jobs.get(id))!.jr[0].o, 'Changed the description.')
})

test('start_item starts the tracker item and its job; an open job is reused; undo cancels only a created one', async (t) => {
  const s = await setup(t)
  const r = await s.call('start_item', { key: 'ACME-603' })
  assert.equal(r.err, false, r.text)
  const b = r.json()
  assert.equal(b.created, true); assert.equal(b.key, 'ACME-603'); assert.equal(b.title, 'Item ACME-603'); assert.equal(b.playbook, 'dev-item'); assert.equal(b.status, 'active')
  assert.deepEqual(s.acts.map((a) => [a.action, a.args]), [['work.start', { id: 'ACME-603' }]])
  assert.equal((await s.jobs.get(b.id))!.jr[0].a, 'Claude Code')
  const again = (await s.call('start_item', { key: 'ACME-603' })).json()
  assert.equal(again.created, false); assert.equal(again.id, b.id)
  assert.equal((await s.call('start_item', { key: 'ACME-512', playbook: 'nope' })).err, true)
  await s.call('undo')
  assert.equal((await s.jobs.get(b.id))!.st, 'cancelled')
  assert.equal((await s.call('undo')).err, true, 'the reused job left nothing to undo')
})

test('get_job and list_jobs read without changing anything', async (t) => {
  const s = await setup(t), j = await openJob(s.jobs)
  const d = (await s.call('get_job', { id: j.id })).json()
  assert.equal(d.id, j.id)
  assert.equal(d.v, j.v)
  assert.ok(d.phases.length > 0)
  assert.equal((await s.call('list_jobs', { filter: 'all' })).json().length, (await s.jobs.all()).length)
  assert.equal((await s.jobs.get(j.id))!.v, j.v)
})

test("job_context edits the runs' context by key or id; get_job lists it; undo takes back the last change", async (t) => {
  const s = await setup(t), j = await openJob(s.jobs), base = (await s.call('get_job', { id: j.id })).json().context.length
  const r = await s.call('job_context', { id: j.id, op: 'add', kind: 'work', item: 'ACME-999', count: 3 })
  assert.equal(r.err, false, r.text)
  assert.deepEqual((await s.call('get_job', { id: j.id })).json().context.at(-1), { kind: 'work', item: 'ACME-999', count: 3 }, 'JSON drops the missing name')
  assert.equal((await s.call('job_context', { id: j.id, op: 'set', kind: 'work', item: 'ACME-999', count: 7 })).err, false)
  assert.equal((await s.jobs.get(j.id))!.ctx!.at(-1)!.n, 7)
  assert.match((await s.call('job_context', { id: j.id, op: 'set', kind: 'work', item: 'ACME-999', count: 99 })).text, /^bad_args/)
  assert.equal((await s.call('undo')).err, false)
  assert.equal((await s.call('get_job', { id: j.id })).json().context.at(-1).count, 3)
  assert.equal((await s.call('job_context', { id: j.id, op: 'del', kind: 'work', item: 'ACME-999' })).err, false)
  assert.equal((await s.call('get_job', { id: j.id })).json().context.length, base)
})

test('job_context adds a note by its id under its title, refuses an unknown one, and takes no count for a mail', async (t) => {
  const s = await setup(t), j = await openJob(s.jobs)
  await s.notes.save(null, { title: 'Tracker REST', tags: [], playbooks: [], text: 'Use a token header.' }, null)
  const r = await s.call('job_context', { id: j.id, op: 'add', kind: 'note', item: 'tracker-rest' })
  assert.equal(r.err, false, r.text)
  assert.deepEqual((await s.call('get_job', { id: j.id })).json().context.at(-1), { kind: 'note', item: 'tracker-rest', count: 1, name: 'Tracker REST' })
  const gone = await s.call('job_context', { id: j.id, op: 'add', kind: 'note', item: 'nope' })
  assert.equal(gone.err, true); assert.match(gone.text, /does not exist/)
  assert.match((await s.call('job_context', { id: j.id, op: 'add', kind: 'mail', item: 'm-17', count: 3 })).text, /^bad_args.*no count/)
  assert.equal((await s.call('job_context', { id: j.id, op: 'add', kind: 'mail', item: 'm-17', name: 'Quota' })).err, false)
})

test('with two workspaces create_job needs a ws; ws picks the space, its prefix and its default project', async (t) => {
  const s = await setup(t, { both: true }), pb = 'action'
  const none = await s.call('create_job', { title: 'Which one?', playbook: pb })
  assert.equal(none.err, true)
  assert.match(none.text, /^bad_args: say which workspace: acme, beta$/)
  assert.match((await s.call('create_job', { title: 'Nowhere', playbook: pb, ws: 'zzz' })).text, /^no_workspace: no workspace zzz$/)
  assert.equal((await s.call('create_job', { title: 'Array', playbook: pb, ws: ['acme'] })).err, true, 'only a string names a workspace')

  const r = await s.call('create_job', { title: 'In beta', playbook: pb, ws: 'beta' })
  assert.equal(r.err, false, r.text)
  const b = r.json()
  assert.equal(b.id, 'B-0001')
  assert.deepEqual([b.ws, b.project], ['beta', 'labs'], "the default project is the first of beta's pack")
  assert.equal((await s.beta!.jobs.get('B-0001'))!.ws, 'beta')
  assert.equal(await s.jobs.get('B-0001'), undefined, "acme's store has no B-0001")

  const a = (await s.call('create_job', { title: 'In acme', playbook: pb, ws: 'acme', project: 'web' })).json()
  assert.deepEqual([a.ws, a.project], ['acme', 'web'], 'a named project is kept')
  assert.equal((await s.call('create_job', { title: 'Default', playbook: pb, ws: 'acme' })).json().project, acme.pack.prj[0])
})

test('with one workspace create_job works without a ws', async (t) => {
  const s = await setup(t)
  const r = await s.call('create_job', { title: 'The only one', playbook: 'action' })
  assert.equal(r.err, false, r.text)
  assert.match(r.json().id, /^J-\d{4}$/)
  assert.equal(r.json().ws, 'acme')
})

test('get_job, job_command, return_to and undo find a job through its prefix, in one session', async (t) => {
  const s = await setup(t, { both: true })
  const id = (await s.call('create_job', { title: 'Beta work', playbook: 'action', ws: 'beta' })).json().id
  assert.equal(id, 'B-0001')
  const d = await s.call('get_job', { id })
  assert.equal(d.err, false, d.text)
  assert.deepEqual([d.json().id, d.json().ws, d.json().status], ['B-0001', 'beta', 'ready'])

  assert.equal((await s.call('job_command', { id, op: 'start' })).json().job.ws, 'beta')
  const j = (await s.beta!.jobs.get(id))!
  assert.equal(j.st, 'active')
  assert.equal(j.jr[0].a, 'Claude Code')

  // acme's job in the same session: one undo stack holds both, newest first
  const x = demoCtx(), mine = await openJob(s.jobs)
  assert.equal((await s.call('job_command', { id: mine.id, op: 'noteAdd', step: T.atOf(x, mine)!, k: 'q', t: 'in acme' })).json().job.ws, 'acme')
  assert.equal((await s.call('undo')).json().undone, `last change to ${mine.id}`)
  const back = (await s.call('undo')).json()
  assert.deepEqual([back.undone, back.job.ws, back.job.status], [`last change to ${id}`, 'beta', 'ready'], 'the start is taken back in beta')
  assert.equal((await s.call('undo')).json().undone, `created ${id}`, 'a created job is cancelled in its own space')
  assert.equal((await s.beta!.jobs.get(id))!.st, 'cancelled')
})

test('return_to resolves the job in its own workspace', async (t) => {
  const s = await setup(t, { both: true })
  const id = (await s.call('create_job', { title: 'Beta work', playbook: 'action', ws: 'beta' })).json().id
  await s.call('job_command', { id, op: 'start' })
  const first = T.steps(demoCtx(), 'action')[0].id
  assert.equal((await s.call('job_command', { id, op: 'stepDone', step: first })).err, false)
  const r = await s.call('return_to', { id, step: first, why: 'again' })
  assert.equal(r.err, false, r.text)
  assert.deepEqual([r.json().job.id, r.json().job.ws, r.json().job.round], [id, 'beta', 2])
  assert.equal((await s.beta!.jobs.get(id))!.rounds!.length, 1)
})

test("job_context edits a beta job's context by its board's key or id, in beta's space", async (t) => {
  const s = await setup(t, { both: true })
  const id = (await s.call('create_job', { title: 'Beta context', playbook: 'action', ws: 'beta' })).json().id
  const base = (await s.call('get_job', { id })).json().context.length
  const r = await s.call('job_context', { id, op: 'add', kind: 'work', item: 'beta/ACME-999', count: 3 })
  assert.equal(r.err, false, r.text)
  assert.deepEqual((await s.call('get_job', { id })).json().context.at(-1), { kind: 'work', item: 'ACME-999', count: 3 }, "beta's board rule turned the key into the item id")
  assert.equal((await s.beta!.jobs.get(id))!.ctx!.at(-1)!.id, 'ACME-999')
  assert.equal((await s.call('job_context', { id, op: 'set', kind: 'work', item: 'ACME-999', count: 5 })).err, false, 'the bare id reaches the same item')
  assert.equal((await s.beta!.jobs.get(id))!.ctx!.at(-1)!.n, 5)
  assert.equal((await s.call('undo')).err, false)
  assert.equal((await s.call('job_context', { id, op: 'del', kind: 'work', item: 'ACME-999' })).err, false)
  assert.equal((await s.call('get_job', { id })).json().context.length, base)
})

test('a job id no workspace owns is a not_found tool error naming it', async (t) => {
  const s = await setup(t, { both: true })
  for (const tool of ['get_job', 'job_command', 'draft_reply', 'job_context', 'return_to']) {
    const r = await s.call(tool, { id: 'X-0001', op: 'start', step: 's', why: 'w', kind: 'work', item: 'ACME-1', text: 't', intent: 'revise' })
    assert.equal(r.err, true, tool)
    assert.equal(r.text, 'not_found: no job X-0001', tool)
  }
  assert.equal((await s.call('get_job', { id: 'B-0099' })).text, 'not_found: no job B-0099', 'a known prefix, no such job')
  assert.equal((await s.call('get_job', { id: '' })).err, true)
})

test('list_jobs covers every workspace and each brief carries its ws', async (t) => {
  const s = await setup(t, { both: true })
  await s.call('create_job', { title: 'Beta one', playbook: 'action', ws: 'beta' })
  const all = (await s.call('list_jobs', { filter: 'all' })).json() as { id: string; ws: string }[]
  assert.equal(all.length, (await s.jobs.all()).length + 1)
  assert.deepEqual(all.filter((b) => b.ws === 'beta').map((b) => b.id), ['B-0001'])
  assert.ok(all.filter((b) => b.ws === 'acme').every((b) => b.id.startsWith('J-')))
})

test('list_jobs with one workspace down names it instead of passing it off as empty; all down is the tool error', async (t) => {
  t.mock.method(console, 'error', () => undefined)
  const s = await setup(t, { both: true })
  await s.call('create_job', { title: 'Beta one', playbook: 'action', ws: 'beta' })
  const down = async () => { throw new GatewayError(503, 'bridge_unavailable', 'the bridge is not reachable: refused') }
  const acmeJobs = s.spaces.get('acme').jobs, touched: string[] = []
  // acme's Jobs answers only all(); any other call is recorded and fails, so a lookup that tries acme first shows
  s.spaces.get('acme').jobs = new Proxy({ all: down }, { get: (o, k) => (k === 'all' ? o.all : () => { touched.push(String(k)); throw new Error(`acme's ${String(k)} was called`) }) }) as never
  const got = (await s.call('list_jobs', { filter: 'all' })).json() as { id?: string; ws: string; unavailable?: string }[]
  assert.deepEqual(got.filter((b) => b.id).map((b) => b.id), ['B-0001'], "beta's jobs still come")
  assert.deepEqual(got.filter((b) => b.unavailable).map((b) => [b.ws, b.unavailable]), [['acme', 'the bridge is not reachable: refused']])
  // a beta job id is routed by its prefix alone: acme being away changes nothing for it, and acme is never asked
  const one = await s.call('get_job', { id: 'B-0001' })
  assert.equal(one.err, false, one.text)
  assert.deepEqual([one.json().id, one.json().ws], ['B-0001', 'beta'])
  const started = await s.call('job_command', { id: 'B-0001', op: 'start' })
  assert.equal(started.err, false, started.text)
  assert.equal(started.json().job.status, 'active')
  assert.deepEqual(touched, [], "acme's Jobs was not asked for a beta job")
  s.spaces.get('beta').jobs = { all: down } as never
  const none = await s.call('list_jobs')
  assert.equal(none.err, true)
  assert.match(none.text, /the bridge is not reachable/)
  s.spaces.get('acme').jobs = acmeJobs
})

test("start_item takes a ws; the playbook defaults to that workspace's board.start and the job lands in its space", async (t) => {
  const s = await setup(t, { both: true })
  assert.match((await s.call('start_item', { key: 'beta/ACME-603' })).text, /^bad_args: say which workspace: acme, beta$/)
  const r = await s.call('start_item', { key: 'beta/ACME-603', ws: 'beta' })
  assert.equal(r.err, false, r.text)
  const b = r.json()
  assert.deepEqual([b.id, b.ws, b.playbook, b.project, b.created], ['B-0001', 'beta', 'action', 'labs', true])
  assert.deepEqual(s.beta!.acts.map((a) => [a.action, a.args]), [['work.start', { id: 'ACME-603' }]])
  assert.deepEqual(s.acts, [], "acme's gateway is not asked")
  assert.match((await s.call('start_item', { key: 'beta/ACME-603', ws: 'acme' })).text, /^bad_args: beta\/ACME-603 is not a board item key$/, "acme's rule does not read beta's key")
  const a = (await s.call('start_item', { key: 'ACME-604', ws: 'acme' })).json()
  assert.deepEqual([a.ws, a.playbook, a.project], ['acme', 'dev-item', acme.pack.prj[0]])
  assert.equal((await s.call('undo')).json().undone, `created ${a.id}`)
  assert.equal((await s.call('undo')).json().undone, 'created B-0001')
})

test("list_playbooks carries each playbook's own ws; core playbooks have none", async (t) => {
  const s = await setup(t, { both: true })
  const pbs = (await s.call('list_playbooks')).json() as { id: string; ws?: string }[]
  assert.equal(pbs.find((p) => p.id === 'dev-item')!.ws, 'acme')
  assert.equal('ws' in pbs.find((p) => p.id === 'action')!, false, "a core playbook is nobody's: no ws is invented")
})

test('list_playbooks leaves out a once playbook and says what context a playbook needs', async () => {
  const PB: Record<string, Playbook> = { ...demoCtx().PB, mine: { n: 'Mine', needs: 'the work item and its chat', ph: [] }, 'once-1': { n: 'For one job', once: 1, ph: [] } }
  const space = { id: 'acme', prefix: 'J', page: acme, ctx: () => ({ PB, TPL: {} }) } as unknown as Space
  const tool = jobTools({ spaces: new Spaces([space]) }).find((x) => x.name === 'list_playbooks')!
  const pbs = (await tool.run({}, {} as never)) as { id: string; needs?: string }[]
  assert.equal(pbs.find((p) => p.id === 'mine')!.needs, 'the work item and its chat')
  assert.equal(pbs.some((p) => p.id === 'once-1'), false, 'a once playbook is not one to follow')
  assert.equal('needs' in pbs.find((p) => p.id === 'action')!, false)
})

test("knowledge: a session searches and reads a workspace's notes; a proposal is signed session and writes nothing", async (t) => {
  const s = await setup(t, { both: true })
  await s.notes.save(null, { title: 'Tracker REST', tags: ['tracker'], playbooks: ['dev-item'], text: 'Use a token header.' }, null)
  const hits = (await s.call('knowledge_search', { q: 'token', ws: 'acme' })).json() as { id: string }[]
  assert.deepEqual(hits.map((h) => h.id), ['tracker-rest'])
  assert.deepEqual((await s.call('knowledge_search', { q: 'token', ws: 'beta' })).json(), [], "beta's notes are its own")
  assert.equal((await s.call('knowledge_read', { id: 'tracker-rest', ws: 'acme' })).json().text, 'Use a token header.')
  const gone = await s.call('knowledge_read', { id: 'nope', ws: 'acme' })
  assert.equal(gone.err, true); assert.match(gone.text, /does not exist/)
  const r = await s.call('knowledge_propose', { note: 'tracker-rest', title: 'Tracker REST', text: 'Use a token header; it expires hourly.', reason: 'expired token', ws: 'acme' })
  assert.equal(r.err, false, r.text)
  const [p] = await s.notes.proposals()
  assert.deepEqual(r.json(), { proposal: p.id, title: 'Tracker REST', waits: 'in Approvals, for the user' })
  assert.deepEqual([p.by, p.note, p.playbooks], ['session', 'tracker-rest', ['dev-item']], 'a change keeps the playbooks it left out')
  assert.equal((await s.notes.read('tracker-rest')).v, 1)
  assert.equal((await s.call('knowledge_propose', { title: 'x', text: 'y', ws: 'acme' })).err, true, 'a proposal needs a reason')
})

test('ws is an enum of the registered ids and says it may be omitted when there is one', async (t) => {
  type Prop = { type?: string; enum?: string[]; description: string }
  type Def = { description: string; inputSchema: { required?: string[]; properties: Record<string, Prop> } }
  const tools = async (both: boolean) => {
    const s = await setup(t, { both })
    return new Map<string, Def>((await s.rpc('tools/list')).result.tools.map((x: Def & { name: string }) => [x.name, x]))
  }
  const two = await tools(true), one = await tools(false)
  for (const name of ['create_job', 'start_item']) {
    const w = two.get(name)!.inputSchema.properties.ws
    assert.deepEqual([w.type, w.enum], ['string', ['acme', 'beta']], name)
    assert.match(w.description, /may be omitted when one workspace is registered/)
    assert.deepEqual(one.get(name)!.inputSchema.properties.ws.enum, ['acme'], name)
    assert.equal(two.get(name)!.inputSchema.required!.includes('ws'), false, 'ws is optional')
  }
  const prj = two.get('create_job')!.inputSchema.properties.project.description
  assert.match(prj, /labs/); assert.match(prj, /default/); assert.doesNotMatch(prj, /one of/, 'a project outside the pack is accepted, so the text does not claim a closed set')
  assert.match(two.get('list_jobs')!.description, /\{ ws, unavailable \}/, 'a down workspace is announced')
  assert.match(two.get('start_item')!.inputSchema.properties.playbook.description, /beta: action/)
  assert.equal('ws' in two.get('get_job')!.inputSchema.properties, false, 'a job id already names its workspace')
})

async function until(f: () => boolean | Promise<boolean>, ms = 2000) {
  const t0 = Date.now()
  while (!(await f())) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)) }
}
/** an open job's current step with a draft from a run whose session is S1 */
async function drafted(s: Awaited<ReturnType<typeof setup>>) {
  const j = await openJob(s.jobs), at = T.atOf(demoCtx(), j)!
  await s.runner.ask(j.id, at, 'go')
  await until(() => s.sessions.length === 1)
  s.sessions[0].push({ k: 'session', id: 'S1' }); await s.sessions[0].tools.submitDraft('v1'); s.sessions[0].end()
  await until(async () => !(await s.jobs.get(j.id))!.flow[at].run)
  return { j, at }
}
const stepOf = (g: { phases: { steps: { id: string }[] }[] }, id: string) => g.phases.flatMap((x) => x.steps).find((x) => x.id === id) as Record<string, unknown> & { conversation?: { q: string; intent?: string; state: string; a?: string }[] }

test('draft_reply without wait answers the run; with wait the answer; get_job lists the conversation', async (t) => {
  const s = await setup(t), d = await drafted(s)
  const r = await s.call('draft_reply', { id: d.j.id, step: d.at, text: 'shorter', intent: 'revise' })
  assert.equal(r.err, false, r.text); assert.equal(r.json().state, 'queued')
  await until(() => s.sessions.length === 2)
  assert.equal(s.sessions[1].resume, 'S1')
  await s.sessions[1].tools.submitDraft('v2'); s.sessions[1].end()
  await until(async () => !(await s.jobs.get(d.j.id))!.flow[d.at].run)
  const p = s.call('draft_reply', { id: d.j.id, step: d.at, text: 'why?', intent: 'ask', wait: 5 })
  await until(() => s.sessions.length === 3); s.sessions[2].end(true, undefined, 'Because.')
  const w = (await p).json()
  assert.equal(w.state, 'answered'); assert.equal(w.answer, 'Because.'); assert.equal(w.draft, 'v2')
  const st = stepOf((await s.call('get_job', { id: d.j.id })).json(), d.at)
  assert.deepEqual(st.conversation!.map((c) => [c.intent, c.state]), [[undefined, 'draft'], ['revise', 'draft'], ['ask', 'answered']])
  assert.equal(st.conversation![2].a, 'Because.')
  assert.equal((await s.jobs.get(d.j.id))!.jr.find((e) => /Replied to the LLM draft/.test(e.o))!.a, 'Claude Code')
})

test('draft_reply accept with wait says accepted; a step with only its first ask has no conversation; a reply with no draft is a tool error', async (t) => {
  const s = await setup(t), d = await drafted(s)
  assert.equal('conversation' in stepOf((await s.call('get_job', { id: d.j.id })).json(), d.at), false)
  const p = s.call('draft_reply', { id: d.j.id, step: d.at, text: 'fine', intent: 'accept', wait: 5 })
  await until(() => s.sessions.length === 2)
  await s.sessions[1].tools.submitDraft('v2'); s.sessions[1].end()
  const w = (await p).json()
  assert.equal(w.state, 'draft'); assert.equal(w.accepted, true); assert.equal(w.draft, undefined)
  const r = await s.call('draft_reply', { id: d.j.id, step: d.at, text: 'x', intent: 'revise' })
  assert.equal(r.err, true); assert.match(r.text, /no_draft/)
})

test('job_command rejectDraft with why redoes the step, signed Claude Code; without why nothing starts', async (t) => {
  const s = await setup(t), d = await drafted(s)
  const r = await s.call('job_command', { id: d.j.id, op: 'rejectDraft', step: d.at, why: 'wrong scope' })
  assert.equal(r.err, false, r.text); assert.ok(r.json().run)
  await until(() => s.sessions.length === 2)
  assert.equal(s.sessions[1].resume, undefined); assert.match(s.sessions[1].prompt, /## Why\nwrong scope/)
  const j = (await s.jobs.get(d.j.id))!
  assert.equal(j.jr.find((e) => /Asked the LLM/.test(e.o))!.a, 'Claude Code')
  assert.match(j.jr.find((e) => /Rejected the LLM draft/.test(e.o))!.o, /: wrong scope\.$/)
  await s.sessions[1].tools.submitDraft('v2'); s.sessions[1].end()
  await until(async () => !(await s.jobs.get(d.j.id))!.flow[d.at].run)
  const plain = (await s.call('job_command', { id: d.j.id, op: 'rejectDraft', step: d.at })).json()
  assert.equal('run' in plain, false); assert.equal(s.sessions.length, 2)
})

test('job_command links a blocker; get_job shows waitsFor on the step and holds on the blocker', async (t) => {
  const s = await setup(t)
  const mk = async (title: string) => { const j = await s.jobs.create({ t: title, key: 'NEW', pb: 'action', prj: 'p', ws: 'acme' }); return (await s.jobs.cmd(j.id, { op: 'start' }, j.v)).job }
  const a = await mk('Local stand'), b = await mk('Ask Imre')
  const r = await s.call('job_command', { id: a.id, op: 'waitAdd', step: 'tr', j: b.id, plan: 'if yes, go on' })
  assert.equal(r.err, false, r.text)
  const ga = (await s.call('get_job', { id: a.id })).json() as { phases: { steps: { id: string; waitsFor?: unknown }[] }[] }
  assert.deepEqual(ga.phases.flatMap((p) => p.steps).find((x) => x.id === 'tr')!.waitsFor, [{ job: b.id, title: 'Ask Imre', state: 'open', plan: 'if yes, go on' }])
  assert.deepEqual((await s.call('get_job', { id: b.id })).json().holds, [{ job: a.id, title: 'Local stand', step: 'tr' }])
  assert.match((await s.call('job_command', { id: a.id, op: 'stepDone', step: 'tr' })).text, /^bad_state/)
  assert.equal((await s.call('job_command', { id: a.id, op: 'stepDone', step: 'tr', force: true })).err, false)
})

const mkJob = async (s: Awaited<ReturnType<typeof setup>>, title: string) => {
  const j = await s.jobs.create({ t: title, key: 'NEW', pb: 'action', prj: 'p', ws: 'acme' })
  return (await s.jobs.cmd(j.id, { op: 'start' }, j.v)).job
}

test('get_job returns the own steps and the open proposal; a session cannot send ppAccept', async (t) => {
  const s = await setup(t), a = await mkJob(s, 'Local stand')
  await s.jobs.cmd(a.id, { op: 'ppSet', say: 'after the daily', by: 'c1', cmds: [{ op: 'stepAdd', after: 'tr', step: { t: 'Ask Imre', m: 'llm', start: 'self' }, why: 'ask first' }] }, undefined, 'console')
  await s.jobs.cmd(a.id, { op: 'ppAccept' })
  await s.jobs.cmd(a.id, { op: 'ppSet', say: 'one more question', by: 'c2', cmds: [{ op: 'noteAdd', step: 'tr', k: 'q', t: 'who signs?' }] }, undefined, 'console')
  const g = (await s.call('get_job', { id: a.id })).json()
  const added = (g.phases as { steps: { title: string; start?: string; added?: { why: string } }[] }[]).flatMap((p) => p.steps).find((x) => x.title === 'Ask Imre')!
  assert.deepEqual([added.start, added.added?.why], ['self', 'ask first'])
  assert.deepEqual([g.proposal.by, g.proposal.say, g.proposal.changes], ['c2', 'one more question', [JSON.stringify({ op: 'noteAdd', step: 'tr', k: 'q', t: 'who signs?' })]])
  const r = await s.call('job_command', { id: a.id, op: 'ppAccept' })
  assert.equal(r.err, true, r.text)
  assert.ok((await s.jobs.get(a.id))!.pp, 'the proposal still waits for the person')
})

test('job_command waitDel unlinks a blocker: waitsFor is gone and the step is back in progress', async (t) => {
  const s = await setup(t), a = await mkJob(s, 'Local stand'), b = await mkJob(s, 'Ask Imre')
  assert.equal((await s.call('job_command', { id: a.id, op: 'waitAdd', step: 'tr', j: b.id })).err, false)
  assert.equal(stepOf((await s.call('get_job', { id: a.id })).json(), 'tr').state, 'wait')
  const r = await s.call('job_command', { id: a.id, op: 'waitDel', step: 'tr', j: b.id })
  assert.equal(r.err, false, r.text)
  const tr = stepOf((await s.call('get_job', { id: a.id })).json(), 'tr')
  assert.equal(tr.state, 'cur'); assert.equal('waitsFor' in tr, false)
  assert.equal('holds' in (await s.call('get_job', { id: b.id })).json(), false)
})

test('job_command blockerDrop dismisses a blocker the LLM asked for; get_job shows blockerAsked until then', async (t) => {
  const s = await setup(t), j = await openJob(s.jobs), at = T.atOf(demoCtx(), j)!
  await s.runner.ask(j.id, at, 'go')
  await until(() => s.sessions.length === 1)
  await s.jobs.cmd(j.id, { op: 'runBlocker', step: at, say: 'ask Imre first' }, undefined, 'runner')
  s.sessions[0].end()
  await until(async () => !(await s.jobs.get(j.id))!.flow[at].run)
  assert.equal(stepOf((await s.call('get_job', { id: j.id })).json(), at).blockerAsked, 'ask Imre first')
  const r = await s.call('job_command', { id: j.id, op: 'blockerDrop', step: at })
  assert.equal(r.err, false, r.text)
  assert.equal('blockerAsked' in stepOf((await s.call('get_job', { id: j.id })).json(), at), false)
})

test('job_command acceptDraft with an open blocker is refused bad_state; force accepts and drops the link', async (t) => {
  const s = await setup(t), d = await drafted(s), b = await mkJob(s, 'Ask Imre')
  assert.equal((await s.call('job_command', { id: d.j.id, op: 'waitAdd', step: d.at, j: b.id })).err, false)
  const no = await s.call('job_command', { id: d.j.id, op: 'acceptDraft', step: d.at })
  assert.equal(no.err, true); assert.match(no.text, /^bad_state/)
  const ok = await s.call('job_command', { id: d.j.id, op: 'acceptDraft', step: d.at, force: true })
  assert.equal(ok.err, false, ok.text)
  const st = stepOf((await s.call('get_job', { id: d.j.id })).json(), d.at)
  assert.equal(st.state, 'done'); assert.equal('waitsFor' in st, false)
})

test('step_context gives a run\'s prompt for the step, told how a hand-made session finishes', async (t) => {
  const s = await setup(t), j = await openJob(s.jobs), x = demoCtx(), at = T.atOf(x, j)!
  const r = (await s.rpc('tools/call', { name: 'step_context', arguments: { id: j.id, step: T.stepOf(x, j, at)!.t } })).result
  assert.equal(r.isError, undefined)
  const text = r.content.at(-1).text as string
  assert.ok(text.includes(`## Job ${j.id}: ${j.t}`), text)
  assert.match(text, /## How to work/)
  assert.ok(text.includes(`submit_draft {id: "${j.id}", step: "${at}", output}`))
  assert.match(text, /## Instruction/)
  assert.equal(text, (await s.runner.stepText(j.id, at)).text)
})

test('submit_draft hands a draft in for review, signed by the client; undo takes it back; a second one is draft_waiting', async (t) => {
  const s = await setup(t, { client: 'Cursor' }), j = await openJob(s.jobs), at = T.atOf(demoCtx(), j)!
  const r = await s.call('submit_draft', { id: j.id, step: at, output: 'the hand-made draft', artifacts: [{ name: 'notes.md', content: '# n' }] })
  assert.equal(r.err, false, r.text)
  assert.deepEqual(r.json().artifacts, ['notes.md'])
  const after = (await s.jobs.get(j.id))!
  assert.equal(after.flow[at].dr!.t, 'the hand-made draft'); assert.equal(after.flow[at].s, 'wait')
  assert.equal(after.jr.find((e) => /handed in/.test(e.o))!.a, 'Cursor')
  assert.ok(after.flow[at].arts.some((a) => a.n === 'notes.md' && a.ok))
  const again = await s.call('submit_draft', { id: j.id, step: at, output: 'v2' })
  assert.equal(again.err, true); assert.match(again.text, /^draft_waiting/)
  assert.equal((await s.call('undo')).err, false)
  const back = (await s.jobs.get(j.id))!
  assert.equal(back.flow[at].dr, null); assert.ok(!back.flow[at].arts.some((a) => a.n === 'notes.md'))
})

test('submit_draft is busy while a run of the step is queued or running; a session without clientInfo signs Claude Code', async (t) => {
  const s = await setup(t, { client: null }), j = await openJob(s.jobs), at = T.atOf(demoCtx(), j)!
  await s.runner.ask(j.id, at, 'go')
  const busy = await s.call('submit_draft', { id: j.id, step: at, output: 'x' })
  assert.equal(busy.err, true); assert.match(busy.text, /^busy/)
  await until(() => s.sessions.length === 1)
  s.sessions[0].end(false, 'no')
  await until(async () => !(await s.jobs.get(j.id))!.flow[at].run)
  const r = await s.call('submit_draft', { id: j.id, step: at, output: 'mine' })
  assert.equal(r.err, false, r.text)
  assert.equal((await s.jobs.get(j.id))!.jr.find((e) => /handed in/.test(e.o))!.a, 'Claude Code')
})

test('openIn gives the dir and the newest session run with its provider; a running step is busy', async (t) => {
  const s = await setup(t), d = await drafted(s)
  const o = await s.runner.openIn(d.j.id, d.at)
  assert.deepEqual(o.run, { provider: 'claude', session: 'S1' })
  assert.equal(o.dir, tmpdir()); assert.equal(o.job, d.j.id); assert.equal(o.step, d.at)
  await s.runner.reply(d.j.id, d.at, 'more', 'revise')
  await assert.rejects(s.runner.openIn(d.j.id, d.at), (e: unknown) => (e as { code?: string }).code === 'busy')
})
