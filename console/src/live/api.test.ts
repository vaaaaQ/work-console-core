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
import type { WorkspaceServer } from '../../server/workspace.ts'
import acmeServer from '../../workspaces/acme/server.ts'
import { acme } from '../testkit.ts'
import { CHATS, JOBS, S } from '../model/world.ts'
import * as T from '../model/transitions.ts'
import type { Playbook } from '../model/types.ts'
import * as api from './api.ts'
import { zone } from '../lib/zone.ts'
import { L, applyState, fromQuery, loadSources, onEvent, pbWs, srcState } from './boot.ts'

/* The page's client against the real backend (fake gateways, scripted SDK): the shapes the page
   sends and reads are the ones the server speaks. Two workspaces: acme mints A-NNNN, beta is Acme
   under another id and prefix, on its own fake gateway. */

const sdk: Sdk = { async *start({ tools }) { yield { k: 'session', id: 'sess-1' }; await tools.submitDraft('a draft'); yield { k: 'result', ok: true } } }
const betaW: WorkspaceServer = { ...acmeServer, page: { ...acme, id: 'beta', playbooks: {} }, jobPrefix: 'B' }

async function until(f: () => boolean | Promise<boolean>, ms = 3000) {
  const t0 = Date.now()
  while (!(await f())) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 20)) }
}

async function backend() {
  const home = mkdtempSync(join(tmpdir(), 'wc-api-'))
  const cfg = { ...loadConfig({ WORK_CONSOLE_HOME: home, WORK_CONSOLE_FAKE_GATEWAY: '1' }), loopbackPort: 0 }
  const m = await main({ cfg, sdk, workspaces: [acmeServer, betaW] })
  api.setBase(`http://127.0.0.1:${m.loopbackPort}`)
  await until(async () => { const { ws } = await api.state(); return ws.acme?.bridge.state === 'ok' && ws.beta?.bridge.state === 'ok' })
  return m
}

/** the console paths the page's client fetched while f ran; the backend's own calls to its gateways are left out */
async function paths(port: number, f: () => Promise<unknown>) {
  const seen: string[] = [], real = globalThis.fetch
  globalThis.fetch = (u, i) => { const x = new URL(String(u)); if (x.port === String(port)) seen.push(x.pathname); return real(u, i) }
  try { await f() } finally { globalThis.fetch = real }
  return seen
}

test('only a part B did not give while the bridge is up counts as missing, per workspace', () => {
  const was = { ws: api.LIVE.ws }, sel = S.ws
  try {
    api.LIVE.ws = { acme: { ...api.blankWs(), parts: { jobs: 'unavailable', runs: 'ok' } }, beta: api.blankWs() }
    S.ws = 'acme'
    assert.deepEqual(api.missingParts(), ['jobs'])
    assert.deepEqual(api.missingParts('beta'), [], "beta's parts are its own")
    api.LIVE.ws.acme.bridge = 'unavailable'
    assert.deepEqual(api.missingParts(), [], 'the bridge banner already says it')
  } finally { Object.assign(api.LIVE, was); S.ws = sel }
})

test('detect: the backend is live in the per-workspace shape, a page-only server is the demo, a 401 is the pairing screen', async () => {
  const m = await backend()
  try {
    const st = await api.detect()
    assert.ok(st && st !== 'unpaired'); assert.equal(st.side, 'loopback'); assert.ok(st.push?.key)
    assert.equal(typeof st.home.tz, 'string'); assert.equal(typeof st.home.pc, 'string')
    assert.deepEqual(Object.keys(st.ws), ['acme', 'beta'])
    assert.deepEqual(st.ws.acme.parts, { jobs: 'ok', runs: 'ok', marks: 'ok' }); assert.equal(st.ws.beta.bridge.state, 'ok')
    for (const k of ['jobs', 'runs', 'marks', 'parts', 'playbooks', 'bridge']) assert.equal(k in st, false, `no top-level ${k}`)
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
    const step = T.steps({ PB: (await api.state()).ws.acme.playbooks, TPL: {} }, job.pb).find((s) => T.isLive(started.job.flow[s.id]))!.id
    const r = await api.cmd(job.id, { op: 'noteAdd', step, k: 'q', t: 'why?' }, started.job.v)
    assert.equal(r.job.v, started.job.v! + 1)
    await assert.rejects(api.cmd(job.id, { op: 'noteAdd', step, k: 'q', t: 'again' }, started.job.v), (e: api.ApiError) => e.status === 409)
    const u = await api.undo(job.id, r.job.v!, r.prev)
    assert.equal(u.job.flow[step].b.length, started.job.flow[step].b.length)
    assert.equal((await api.job(job.id)).job.v, u.job.v)
  } finally { await m.close() }
})

test("sources('beta', …) goes to beta's workspace route", async () => {
  const m = await backend()
  try {
    let got: Awaited<ReturnType<typeof api.sources>> | undefined
    assert.deepEqual(await paths(m.loopbackPort, async () => { got = await api.sources('beta', ['chat']) }), ['/api/ws/beta/sources'])
    assert.equal(got!.concepts.chat.status, 'ok')
    m.fakes.beta.setDown(true)
    await until(async () => (await api.state()).ws.beta.bridge.state === 'unavailable')
    assert.notEqual((await api.sources('beta', ['chat'])).concepts.chat.status, 'ok')
    assert.equal((await api.sources('acme', ['chat'])).concepts.chat.status, 'ok', "acme's gateway is still up")
  } finally { await m.close() }
})

test('sources, a thread, a mail body and a mark read in page shapes', async () => {
  const m = await backend()
  try {
    const { concepts } = await api.sources('acme', ['chat', 'mail', 'cal'])
    assert.equal(concepts.chat.status, 'ok'); assert.equal(concepts.cal.status, 'ok')
    const chat = concepts.chat.items![0] as { id: string }
    assert.ok(Array.isArray(await api.chatThread('acme', chat.id)))
    const mail = concepts.mail.items![0] as { id: string }
    assert.equal(typeof await api.mailItem('acme', mail.id), 'string')
    await api.markMail('acme', mail.id, { done: true })
    const again = (await api.sources('acme', ['mail'])).concepts.mail.items as { id: string; done?: boolean }[]
    assert.equal(again.find((x) => x.id === mail.id)!.done, true)
    const there = (await api.sources('beta', ['mail'])).concepts.mail.items as { id: string; done?: boolean }[]
    assert.notEqual(there.find((x) => x.id === mail.id)?.done, true, "a mark in acme is not beta's")
    m.fakes.acme.setDown(true)
    await until(async () => (await api.state()).ws.acme.bridge.state === 'unavailable')
    assert.equal((await api.state()).ws.acme.parts.jobs, 'unavailable')
    assert.notEqual((await api.sources('acme', ['chat'])).concepts.chat.status, 'ok')
  } finally { await m.close() }
})

test('a chat thread is hidden and unhidden through the backend', async () => {
  const m = await backend()
  try {
    const ids = async () => ((await api.sources('acme', ['chat'])).concepts.chat.items as { id: string }[]).map((x) => x.id)
    const id = (await ids())[0]
    await api.hideChat('acme', id, true, 'Team Dev')
    assert.deepEqual(await api.hiddenChats('acme'), [{ id, name: 'Team Dev' }])
    assert.deepEqual(await api.hiddenChats('beta'), [], 'hidden in acme only')
    await until(async () => !(await ids()).includes(id))
    await api.hideChat('acme', id, false)
    assert.deepEqual(await api.hiddenChats('acme'), [])
    await until(async () => (await ids()).includes(id))
  } finally { await m.close() }
})

test('an act, a run with its feed, cancel without a body, playbooks and pairing', async () => {
  const m = await backend()
  try {
    const { concepts } = await api.sources('acme', ['chat'])
    const chat = concepts.chat.items![0] as { id: string; name: string }
    const a = await api.act('acme', 'chat.post', { chatName: chat.name, text: 'hello' })
    assert.equal(a.status, 'ok')
    assert.deepEqual(m.fakes.acme.acts.at(-1)!.args, { chat: chat.id, text: 'hello' })
    const b = await api.act('beta', 'chat.post', { chatName: chat.name, text: 'there' })
    assert.equal(b.status, 'ok')
    assert.deepEqual(m.fakes.beta.acts.at(-1)!.args, { chat: chat.id, text: 'there' }, "beta's act reaches beta's gateway")

    const { job } = await api.create({ t: 'Ask', key: 'ACME-4243', pb: 'action', prj: 'platform', ws: 'acme' })
    const started = await api.cmd(job.id, { op: 'start' }, job.v)
    const step = Object.keys(started.job.flow).find((k) => T.isLive(started.job.flow[k]))!
    const { run } = await api.ask(job.id, step, 'look')
    await until(async () => (await api.runInfo(run.id)).run.state === 'draft')
    assert.equal((await api.job(job.id)).job.flow[step].dr?.t, 'a draft')
    // a POST without a payload still carries JSON, so the backend does not answer 415
    await assert.rejects(api.cancelRun(run.id), (e: api.ApiError) => e.status !== 415)

    const pb: Playbook = { n: 'Mine', ph: [{ c: 'A', n: 'One', s: [{ id: 'mine1', t: 'Do it', m: 'you', x: 'done' }] }] } as unknown as Playbook
    assert.ok((await api.putPlaybook('beta', 'mine', pb)).playbooks.mine)
    assert.ok((await api.state()).ws.beta.playbooks.mine); assert.equal((await api.state()).ws.acme.playbooks.mine, undefined)
    assert.equal((await api.putPlaybook('beta', 'mine', null)).playbooks.mine, undefined)

    const p = await api.pairNew()
    assert.match(p.url, /^https:\/\/.+\/pair\?code=/); assert.match(p.qr, /^<svg/); assert.ok(Date.parse(p.expires) > Date.now())
    assert.deepEqual((await api.devices()).devices, [])
  } finally { await m.close() }
})

test('knowledge: the page lists, decides and edits through the backend', async () => {
  const m = await backend()
  try {
    const r = await fetch(`${m.fakes.acme.url}/api/knowledge/propose`, { method: 'POST', headers: { authorization: `Bearer ${m.fakes.acme.llmToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Page note', text: 'a', reason: 'test' }) })
    assert.equal(r.status, 200)
    await until(async () => (await api.proposals('acme')).length === 1)
    assert.deepEqual(await api.proposals('beta'), [], "acme's proposal is not beta's")
    const [p] = await api.proposals('acme')
    const n = await api.decide('acme', p.id, true)
    assert.equal(n?.title, 'Page note')
    await until(async () => (await api.notes('acme')).some((x) => x.id === n!.id))
    const e = await api.saveNote('acme', n!.id, { title: 'Page note', tags: ['x'], text: 'b' }, n!.v)
    assert.equal((await api.note('acme', e.id)).text, 'b')
    assert.equal((await api.searchNotes('acme', 'b')).length, 1)
    await assert.rejects(api.saveNote('acme', n!.id, { title: 'Page note', tags: [], text: 'c' }, n!.v), (x: unknown) => x instanceof api.ApiError && x.code === 'conflict')
  } finally { await m.close() }
})

test('applyState fills one live block per workspace; sources load into their own', async () => {
  const m = await backend()
  try {
    await api.create({ t: 'In beta', key: 'NEW', pb: 'action', prj: 'platform', ws: 'beta' })
    applyState(await api.state())
    assert.deepEqual(Object.keys(api.LIVE.ws), ['acme', 'beta'])
    assert.equal(JOBS.find((j) => j.id === 'B-0001')?.ws, 'beta')
    api.LIVE.on = true
    await loadSources('beta')
    assert.equal(srcState('chat', 'beta'), 'ok'); assert.ok(CHATS.beta?.length)
    assert.equal(L('beta').sources.chat, 'ok')
    assert.equal(srcState('chat', 'acme'), 'loading', "acme's sources are not loaded yet")
    assert.equal(srcState('chat', 'nowhere'), 'not served by the console backend')
    // a bridge frame moves only its own workspace
    onEvent({ kind: 'bridge', ws: 'beta', state: 'unavailable', concepts: {} })
    assert.equal(L('beta').bridge, 'unavailable'); assert.equal(L('acme').bridge, 'ok')
    assert.equal(srcState('chat', 'beta'), 'the bridge is unavailable')
    assert.deepEqual(api.missingParts('acme'), [])
  } finally { api.LIVE.on = false; await m.close() }
})

test('applyState takes the home zone and remembers which workspace holds each playbook', async () => {
  const m = await backend()
  const sel = S.ws
  try {
    const st = await api.state()
    applyState(st)
    assert.equal(zone(), st.home.tz)
    S.ws = 'beta'
    assert.equal(pbWs('dev-item'), 'acme', "acme's playbook is saved to acme from any workspace")
    assert.equal(pbWs('not-yet'), 'beta', 'a new one goes to the workspace on screen')
  } finally { S.ws = sel; await m.close() }
})

test('fromQuery: a job opens in its workspace; ws= opens that workspace', async () => {
  const m = await backend()
  const sel = S.ws
  try {
    await api.create({ t: 'In beta', key: 'NEW', pb: 'action', prj: 'platform', ws: 'beta' })
    applyState(await api.state())
    S.ws = 'acme'
    assert.equal(fromQuery('?job=B-0001'), true)
    assert.equal(S.ws, 'beta'); assert.equal(S.view, 'job'); assert.equal(S.job, 'B-0001')
    S.ws = 'acme'
    assert.equal(fromQuery('?view=chats&chat=c1&ws=beta'), true)
    assert.equal(S.ws, 'beta'); assert.equal(S.view, 'chats'); assert.equal(S.chat.beta, 'c1')
    S.ws = 'beta'
    assert.equal(fromQuery('?view=approvals&ws=acme'), true)
    assert.equal(S.ws, 'acme'); assert.equal(S.view, 'approvals')
    S.ws = 'beta'
    assert.equal(fromQuery('?view=mail&mail=m2&ws=nowhere'), true)
    assert.equal(S.ws, 'acme', 'an unknown ws= opens the default workspace, as a link without one does'); assert.equal(S.mail, 'm2')
    S.ws = 'beta'
    assert.equal(fromQuery('?job=B-0001&ws=acme'), true)
    assert.equal(S.ws, 'acme', 'ws= wins over the job'); assert.equal(S.job, 'B-0001')
  } finally { S.ws = sel; await m.close() }
})
