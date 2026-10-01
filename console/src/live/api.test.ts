import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../../server/config.ts'
import { main } from '../../server/main.ts'
import type { Sdk } from '../../server/llm/sdk.ts'
import * as T from '../model/transitions.ts'
import type { Playbook } from '../model/types.ts'
import * as api from './api.ts'

/* The page's client against the real backend (fake gateway, scripted SDK): the shapes the page
   sends and reads are the ones the server speaks. */

const sdk: Sdk = { async *start({ tools }) { yield { k: 'session', id: 'sess-1' }; await tools.submitDraft('a draft'); yield { k: 'result', ok: true } } }

async function until(f: () => boolean | Promise<boolean>, ms = 3000) {
  const t0 = Date.now()
  while (!(await f())) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 20)) }
}

async function backend() {
  const home = mkdtempSync(join(tmpdir(), 'wc-api-'))
  const cfg = { ...loadConfig({ WORK_CONSOLE_HOME: home, WORK_CONSOLE_FAKE_GATEWAY: '1' }), loopbackPort: 0 }
  const m = await main({ cfg, sdk })
  api.setBase(`http://127.0.0.1:${m.loopbackPort}`)
  await until(async () => (await api.state()).bridge.state === 'ok')
  return m
}

test('only a part B did not give while the bridge is up counts as missing', () => {
  const was = { bridge: api.LIVE.bridge, parts: api.LIVE.parts }
  try {
    api.LIVE.bridge = 'ok'; api.LIVE.parts = { jobs: 'unavailable', runs: 'ok' }
    assert.deepEqual(api.missingParts(), ['jobs'])
    api.LIVE.bridge = 'unavailable'
    assert.deepEqual(api.missingParts(), [], 'the bridge banner already says it')
  } finally { Object.assign(api.LIVE, was) }
})

test('detect: the backend is live, a page-only server is the demo, a 401 is the pairing screen', async () => {
  const m = await backend()
  try {
    const st = await api.detect()
    assert.ok(st && st !== 'unpaired'); assert.equal(st.side, 'loopback'); assert.ok(st.push?.key)
    assert.deepEqual(st.parts, { jobs: 'ok', runs: 'ok', marks: 'ok' })
  } finally { await m.close() }
  for (const [status, body, want] of [[200, '<!doctype html>', null], [401, '{"error":{"code":"not_paired","message":"x"}}', 'unpaired']] as const) {
    const s = createServer((_, res) => { res.writeHead(status, { 'content-type': 'text/html' }); res.end(body) })
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
    api.setBase(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)
    try { assert.equal(await api.detect(), want) } finally { await new Promise((r) => s.close(r)) }
  }
})

test('jobs: create, a command with its version, a stale version, undo', async () => {
  const m = await backend()
  try {
    const { job } = await api.create({ t: 'From the page', key: 'ACME-4242', pb: 'action', prj: 'platform', ws: 'acme' })
    const started = await api.cmd(job.id, { op: 'start' }, job.v)
    const step = T.steps({ PB: (await api.state()).playbooks, TPL: {} }, job.pb).find((s) => T.isLive(started.job.flow[s.id]))!.id
    const r = await api.cmd(job.id, { op: 'noteAdd', step, k: 'q', t: 'why?' }, started.job.v)
    assert.equal(r.job.v, started.job.v! + 1)
    await assert.rejects(api.cmd(job.id, { op: 'noteAdd', step, k: 'q', t: 'again' }, started.job.v), (e: api.ApiError) => e.status === 409)
    const u = await api.undo(job.id, r.job.v!, r.prev)
    assert.equal(u.job.flow[step].b.length, started.job.flow[step].b.length)
    assert.equal((await api.job(job.id)).job.v, u.job.v)
  } finally { await m.close() }
})

test('sources, a thread, a mail body and a mark read in page shapes', async () => {
  const m = await backend()
  try {
    const { concepts } = await api.sources(['chat', 'mail', 'cal'])
    assert.equal(concepts.chat.status, 'ok'); assert.equal(concepts.cal.status, 'ok')
    const chat = concepts.chat.items![0] as { id: string }
    assert.ok(Array.isArray(await api.chatThread(chat.id)))
    const mail = concepts.mail.items![0] as { id: string }
    assert.equal(typeof await api.mailItem(mail.id), 'string')
    await api.markMail(mail.id, { done: true })
    const again = (await api.sources(['mail'])).concepts.mail.items as { id: string; done?: boolean }[]
    assert.equal(again.find((x) => x.id === mail.id)!.done, true)
    m.fake!.setDown(true)
    await until(async () => (await api.state()).bridge.state === 'unavailable')
    assert.equal((await api.state()).parts.jobs, 'unavailable')
    assert.notEqual((await api.sources(['chat'])).concepts.chat.status, 'ok')
  } finally { await m.close() }
})

test('a chat thread is hidden and unhidden through the backend', async () => {
  const m = await backend()
  try {
    const ids = async () => ((await api.sources(['chat'])).concepts.chat.items as { id: string }[]).map((x) => x.id)
    const id = (await ids())[0]
    await api.hideChat(id, true, 'Team Dev')
    assert.deepEqual(await api.hiddenChats(), [{ id, name: 'Team Dev' }])
    await until(async () => !(await ids()).includes(id))
    await api.hideChat(id, false)
    assert.deepEqual(await api.hiddenChats(), [])
    await until(async () => (await ids()).includes(id))
  } finally { await m.close() }
})

test('an act, a run with its feed, cancel without a body, playbooks and pairing', async () => {
  const m = await backend()
  try {
    const { concepts } = await api.sources(['chat'])
    const chat = concepts.chat.items![0] as { id: string; name: string }
    const a = await api.act('chat.post', { chatName: chat.name, text: 'hello' })
    assert.equal(a.status, 'ok')
    assert.deepEqual(m.fake!.acts.at(-1)!.args, { chat: chat.id, text: 'hello' })

    const { job } = await api.create({ t: 'Ask', key: 'ACME-4243', pb: 'action', prj: 'platform', ws: 'acme' })
    const started = await api.cmd(job.id, { op: 'start' }, job.v)
    const step = Object.keys(started.job.flow).find((k) => T.isLive(started.job.flow[k]))!
    const { run } = await api.ask(job.id, step, 'look')
    await until(async () => (await api.runInfo(run.id)).run.state === 'draft')
    assert.equal((await api.job(job.id)).job.flow[step].dr?.t, 'a draft')
    // a POST without a payload still carries JSON, so the backend does not answer 415
    await assert.rejects(api.cancelRun(run.id), (e: api.ApiError) => e.status !== 415)

    const pb: Playbook = { n: 'Mine', ph: [{ c: 'A', n: 'One', s: [{ id: 'mine1', t: 'Do it', m: 'you', x: 'done' }] }] } as unknown as Playbook
    assert.ok((await api.putPlaybook('mine', pb)).playbooks.mine)
    assert.equal((await api.putPlaybook('mine', null)).playbooks.mine, undefined)

    const p = await api.pairNew()
    assert.match(p.url, /^https:\/\/.+\/pair\?code=/); assert.match(p.qr, /^<svg/); assert.ok(Date.parse(p.expires) > Date.now())
    assert.deepEqual((await api.devices()).devices, [])
  } finally { await m.close() }
})

test('knowledge: the page lists, decides and edits through the backend', async () => {
  const m = await backend()
  try {
    const r = await fetch(`${m.fake!.url}/api/knowledge/propose`, { method: 'POST', headers: { authorization: `Bearer ${m.fake!.llmToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Page note', text: 'a', reason: 'test' }) })
    assert.equal(r.status, 200)
    await until(async () => (await api.proposals()).length === 1)
    const [p] = await api.proposals()
    const n = await api.decide(p.id, true)
    assert.equal(n?.title, 'Page note')
    await until(async () => (await api.notes()).some((x) => x.id === n!.id))
    const e = await api.saveNote(n!.id, { title: 'Page note', tags: ['x'], text: 'b' }, n!.v)
    assert.equal((await api.note(e.id)).text, 'b')
    assert.equal((await api.searchNotes('b')).length, 1)
    await assert.rejects(api.saveNote(n!.id, { title: 'Page note', tags: [], text: 'c' }, n!.v), (x: unknown) => x instanceof api.ApiError && x.code === 'conflict')
  } finally { await m.close() }
})
