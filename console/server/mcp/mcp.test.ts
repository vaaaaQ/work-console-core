import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as T from '../../src/model/transitions.ts'
import { startItem } from '../board/start.ts'
import type { ActReq } from '../bridge/wire.ts'
import { Bus } from '../events.ts'
import { Jobs } from '../jobs/jobs.ts'
import { fileStore } from '../store/file.ts'
import { demoCtx, demoSeed } from '../testkit.ts'
import { jobTools, mcpHandler } from './mcp.ts'

const TOKEN = 'a'.repeat(64)

async function setup(t: { after(f: () => unknown): void }, open = { v: true }) {
  const store = fileStore(join(mkdtempSync(join(tmpdir(), 'wc-mcp-')), 's.json'), demoSeed)
  const jobs = new Jobs({ store, bus: new Bus(), ctx: demoCtx, gate: () => open.v })
  const acts: ActReq[] = []
  const bridge = { available: () => true, read: async () => ({}), act: async (a: ActReq) => { acts.push(a); return { status: 'ok' as const, result: { title: `Item ${a.args.id}` } } } }
  const srv = createServer(mcpHandler({ tools: jobTools({ jobs, ctx: demoCtx, start: startItem({ jobs, ctx: demoCtx, bridge }) }), token: () => TOKEN }))
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
  const init = await post({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } })
  sid = init.sid!
  return { jobs, acts, open, post, rpc, call, init, setSid: (s: string) => { sid = s } }
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
  assert.ok(s.init.sid)
  assert.equal((await s.post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202)
  const names = (await s.rpc('tools/list')).result.tools.map((x: { name: string }) => x.name)
  assert.deepEqual(names, ['list_jobs', 'get_job', 'job_command', 'return_to', 'create_job', 'start_item', 'undo', 'list_playbooks'])
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
