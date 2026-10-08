import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildId } from '../../server/build.ts'
import { loadConfig } from '../../server/config.ts'
import { main } from '../../server/main.ts'
import type { Sdk } from '../../server/llm/sdk.ts'
import type { WorkspaceServer } from '../../server/workspace.ts'
import { localSource } from '../../server/bridge/local.ts'
import { startFakeCdp } from '../../server/browser/fake-cdp.ts'
import type { Browser } from '../../server/browser/launcher.ts'
import acmeServer from '../../workspaces/acme/server.ts'
import { acme } from '../testkit.ts'
import { CHATS, JOBS, PB, S, TPL } from '../model/world.ts'
import * as T from '../model/transitions.ts'
import type { Playbook, Tpl } from '../model/types.ts'
import * as api from './api.ts'
import { LIVE } from './api.ts'
import { setZone, zone } from '../lib/zone.ts'
import { HID, hiddenOf, hideIn, loadHidden, unhideIn } from '../actions/hidden.ts'
import { L, applyState, buildFeed, down, fromQuery, loadSources, onEvent, pbWs, signinHost, srcState } from './boot.ts'
import { tempDir } from '../../server/testdirs.ts'

/* The page's client against the real backend (fake gateways, scripted SDK): the shapes the page
   sends and reads are the ones the server speaks. Two workspaces: acme mints A-NNNN, beta is Acme
   under another id and prefix, with one playbook of its own, on its own fake gateway. */

/** what each build's session was asked, in order */
const asks: Parameters<NonNullable<Sdk['ask']>>[0][] = []
const sdk: Sdk = {
  async *start({ tools }) { yield { k: 'session', id: 'sess-1' }; await tools.submitDraft('a draft'); yield { k: 'result', ok: true } },
  // a build searches the notes once and answers; one told to hold on waits until it is stopped
  async *ask(o) {
    asks.push(o)
    yield { k: 'tool', name: 'knowledge_search', input: { q: 'login' } }
    if (o.prompt.includes('hold on')) await new Promise((_ok, no) => o.abort.signal.addEventListener('abort', () => no(new Error('aborted')), { once: true }))
    yield { k: 'result', ok: true, out: { title: 'Fix login', key: 'ACME-7', project: 'web', playbook: 'dev-item', description: 'Fix it', context: [{ k: 'work', id: 'ACME-7' }], due: '', problems: [] } }
  },
}
const betaPb = { n: 'Beta only', ph: [{ c: 'A', n: 'One', s: [{ id: 'b1', t: 'Do it', m: 'you', x: 'done' }] }] } as unknown as Playbook
const betaW: WorkspaceServer = { ...acmeServer, page: { ...acme, id: 'beta', playbooks: { 'beta-only': betaPb } }, jobPrefix: 'B' }

async function until(f: () => boolean | Promise<boolean>, ms = 3000) {
  const t0 = Date.now()
  while (!(await f())) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 20)) }
}

async function backend() {
  const home = tempDir('api')
  const cfg = { ...loadConfig({ WORK_CONSOLE_HOME: home, WORK_CONSOLE_FAKE_GATEWAY: '1' }), loopbackPort: 0 }
  const m = await main({ cfg, sdk, workspaces: [acmeServer, betaW] })
  api.setBase(`http://127.0.0.1:${m.loopbackPort}`)
  await until(async () => { const { ws } = await api.state(); return ws.acme?.bridge.state === 'ok' && ws.beta?.bridge.state === 'ok' })
  return Object.assign(m, { home })
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

test('hidden chats: one list per workspace; an Unhide acts on the workspace whose list held the thread', async () => {
  const m = await backend()
  const sel = S.ws
  try {
    applyState(await api.state())
    api.LIVE.on = true
    await loadSources('acme'); await loadSources('beta')
    const id = CHATS.acme[0].id
    assert.ok(CHATS.beta.some((x) => x.id === id), 'beta has a thread under the same id')
    S.ws = 'acme'
    const r = hideIn('acme', id)!
    assert.equal(await r.done, null)
    assert.deepEqual(hiddenOf('acme').map((h) => h.id), [id])
    S.ws = 'beta'
    await loadHidden('beta'); await loadHidden('acme')
    assert.deepEqual(hiddenOf('beta'), [], "acme's hidden thread is not in beta's list")
    assert.deepEqual(hiddenOf('acme').map((h) => h.id), [id], "a list that lands after the switch stays its own workspace's")
    // the Unhide clicked in acme's list runs while beta is on screen
    assert.equal(await unhideIn('acme', id), null)
    assert.deepEqual(await api.hiddenChats('acme'), [], 'unhidden in acme')
    assert.deepEqual(hiddenOf('acme'), [])
    assert.deepEqual(await api.hiddenChats('beta'), [], 'beta was never asked')
    assert.ok(CHATS.beta.some((x) => x.id === id))
  } finally { S.ws = sel; api.LIVE.on = false; api.LIVE.ws = {}; HID.list = {}; await m.close() }
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

test('knowledge: the page lists, decides, edits and deletes through the backend', async () => {
  const m = await backend()
  try {
    await m.spaces.get('acme')!.notes.propose({ title: 'Page note', text: 'a', reason: 'test', by: 'run A-0001/s1' })
    await until(async () => (await api.proposals('acme')).length === 1)
    assert.deepEqual(await api.proposals('beta'), [], "acme's proposal is not beta's")
    const [p] = await api.proposals('acme')
    const n = await api.decide('acme', p.id, true)
    assert.equal(n?.title, 'Page note')
    await until(async () => (await api.notes('acme')).some((x) => x.id === n!.id))
    const e = await api.saveNote('acme', n!.id, { title: 'Page note', tags: ['x'], playbooks: ['action'], text: 'b' }, n!.v)
    assert.deepEqual((await api.note('acme', e.id)).playbooks, ['action'])
    assert.equal((await api.note('acme', e.id)).text, 'b')
    assert.equal((await api.searchNotes('acme', 'b')).length, 1)
    await assert.rejects(api.saveNote('acme', n!.id, { title: 'Page note', tags: [], playbooks: [], text: 'c' }, n!.v), (x: unknown) => x instanceof api.ApiError && x.code === 'conflict')
    await assert.rejects(api.deleteNote('acme', e.id, n!.v), (x: unknown) => x instanceof api.ApiError && x.code === 'conflict')
    await api.deleteNote('acme', e.id, e.v)
    assert.deepEqual(await api.notes('acme'), [])
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
    // a source frame reloads that concept in its own workspace only
    L('beta').sources.mail = 'stale'
    const seen = await paths(m.loopbackPort, async () => {
      onEvent({ kind: 'source', ws: 'beta', concept: 'mail' })
      await until(() => L('beta').sources.mail === 'ok')
    })
    assert.deepEqual(seen, ['/api/ws/beta/sources'])
    assert.equal(L('acme').sources.mail, undefined, "acme's block is not touched")
    // a bridge frame moves only its own workspace
    onEvent({ kind: 'bridge', ws: 'beta', state: 'unavailable', concepts: {} })
    assert.equal(L('beta').bridge, 'unavailable'); assert.equal(L('acme').bridge, 'ok')
    assert.equal(srcState('chat', 'beta'), 'the bridge is unavailable')
    assert.deepEqual(api.missingParts('acme'), [])
  } finally { api.LIVE.on = false; await m.close() }
})

test('applyState takes the home zone and remembers which workspace holds each playbook', async () => {
  const m = await backend()
  const sel = S.ws, was = zone()
  try {
    const st = await api.state()
    // a home zone unlike the one test.env pins, so only applyState can have set it
    const home = was === 'Asia/Tokyo' ? 'Europe/Lisbon' : 'Asia/Tokyo'
    applyState({ ...st, home: { ...st.home, tz: home } })
    assert.equal(zone(), home)
    applyState({ ...st, home: { ...st.home, tz: 'Nowhere/Atlantis' } })
    assert.equal(zone(), home, 'a zone this runtime does not know leaves the one it had')
    applyState(st)
    S.ws = 'acme'
    assert.equal(PB['beta-only']?.n, 'Beta only', "beta's own playbook is in PB")
    assert.equal(pbWs('beta-only'), 'beta', 'and is saved to beta from any workspace')
    S.ws = 'beta'
    assert.equal(pbWs('dev-item'), 'acme', "acme's playbook is saved to acme from any workspace")
    assert.ok('action' in st.ws.acme.playbooks && 'action' in st.ws.beta.playbooks)
    assert.equal(pbWs('action'), 'beta', "a key both carry is the last block's, the copy PB holds")
    assert.equal(pbWs('not-yet'), 'beta', 'a new one goes to the workspace on screen')
  } finally { S.ws = sel; setZone(was); await m.close() }
})

test("a saved playbook's planned messages come back in the state, reach the page, and go with it", async () => {
  const m = await backend()
  try {
    const pb = { n: 'Mine', ph: [{ c: 'A', n: 'One', s: [{ id: 'mine1', t: 'Tell', m: 'you', x: 'told', msg: 1 }] }] } as unknown as Playbook
    const msg: Tpl[] = [['chat', 'team chat', 'done: {key}']]
    assert.deepEqual((await api.putPlaybook('beta', 'mine', pb, { mine1: msg })).templates.mine1, msg)
    const st = await api.state()
    assert.deepEqual(st.ws.beta.templates.mine1, msg); assert.equal(st.ws.acme.templates.mine1, undefined)
    applyState(st)
    assert.deepEqual(TPL.mine1, msg)
    assert.ok(Object.keys(acme.templates!).every((k) => TPL[k]), 'the built-in ones are there too')
    assert.equal((await api.putPlaybook('beta', 'mine', null)).templates.mine1, undefined)
    applyState(await api.state())
    assert.equal(TPL.mine1, undefined)
  } finally { await m.close() }
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

test("build: the page sends the says and its form, hears the session's reading under the build's id, and gets the form back checked; Stop drops it", async () => {
  const m = await backend()
  // what boot does with the event stream's frames
  const off = m.hub.on((e) => { if (e.kind === 'build') onEvent(e) })
  const form = { t: '', key: '', prj: '', pb: '', d: '', ctx: [], due: '', npb: null, why: [] }
  try {
    const lines: [string, string | undefined][] = []
    buildFeed.set('b1', (t, tool) => lines.push([t, tool]))
    assert.deepEqual(await api.build('acme', 'b1', ['fix the login, ACME-7'], form), {
      t: 'Fix login', key: 'ACME-7', prj: 'web', pb: 'dev-item', d: 'Fix it', ctx: [{ k: 'work', id: 'ACME-7', n: 10 }], due: '', npb: null, why: [],
    })
    assert.deepEqual(lines, [['Started', undefined], ['Searching notes for “login”', 'knowledge_search']])
    assert.match(asks.at(-1)!.prompt, /^1\. fix the login, ACME-7$/m)
    const n = asks.length, stop = new AbortController()
    const held = api.build('acme', 'b2', ['hold on'], form, stop.signal)
    await until(() => asks.length > n)
    stop.abort()
    await assert.rejects(held, (e: unknown) => e instanceof api.ApiError && e.status === 499)
    await until(() => asks[n].abort.signal.aborted)
  } finally { off(); buildFeed.clear(); await m.close() }
})

test('voice: the state says when the PC has a key; the page sends a recording and gets its words', async () => {
  const m = await backend(), real = globalThis.fetch
  try {
    applyState(await api.state())
    assert.equal(LIVE.voice, false, 'no key, no mic')
    writeFileSync(join(m.home, 'openai.key'), 'sk-test-0000')
    applyState(await api.state())
    assert.equal(LIVE.voice, true, 'a key placed while the console runs turns the mic on')
    let sent: FormData | null = null
    // the backend runs in this process, so its call to OpenAI goes through this fetch too
    globalThis.fetch = async (u, i) => {
      if (String(u).startsWith('https://api.openai.com/')) { sent = i!.body as FormData; return Response.json({ text: ' armá un job ' }) }
      return real(u, i)
    }
    assert.equal(await api.transcribe('acme', Buffer.from('opus').toString('base64'), 'audio/webm;codecs=opus'), 'armá un job')
    assert.equal(sent!.get('model'), 'whisper-1')
  } finally { globalThis.fetch = real; LIVE.voice = false; await m.close() }
})

test('providers: the state names them, settings round-trip, a step opens in the manual one', async () => {
  const m = await backend()
  try {
    applyState(await api.state())
    assert.deepEqual(LIVE.providers, { auto: 'claude', manual: 'claude', manualLabel: 'Claude Code' })
    const g = await api.settings()
    assert.deepEqual(g.settings, { auto: 'claude', manual: 'claude' })
    assert.deepEqual(g.providers.map((p) => p.id), ['claude', 'cursor'])
    await assert.rejects(api.putSettings({ auto: 'cursor' }), (e: api.ApiError) => e.status === 400 && e.code === 'bad_args')
    assert.equal((await api.putSettings({ manual: 'cursor' })).settings.manual, 'cursor')
    applyState(await api.state())
    assert.equal(LIVE.providers.manualLabel, 'Cursor')
    const { job } = await api.create({ t: 'By hand', key: 'ACME-4243', pb: 'action', prj: 'platform', ws: 'acme' })
    const started = await api.cmd(job.id, { op: 'start' }, job.v)
    const step = Object.keys(started.job.flow).find((k) => T.isLive(started.job.flow[k]))!
    const o = await api.openStep(job.id, step)
    assert.equal(o.label, 'Cursor'); assert.equal(o.open.kind, 'link')
    assert.match(o.open.value, /^cursor:\/\/anysphere\.cursor-deeplink\/prompt\?text=/)
  } finally { LIVE.providers = { auto: 'claude', manual: 'claude', manualLabel: 'Claude Code' }; await m.close() }
})

test("the agent through the page's client: a managed workspace shows it; a message runs a turn; a rejected grants change goes back with its reason", async () => {
  const home = tempDir('api'), root = tempDir('root')
  mkdirSync(join(root, 'workspaces', 'beta'), { recursive: true })
  writeFileSync(join(root, 'workspaces', 'beta', 'grants.json'), JSON.stringify({ packs: ['p'] }))
  const prompts: string[] = []
  const withAgent: Sdk = {
    ...sdk,
    async *agent(o) {
      prompts.push(o.prompt)
      yield { k: 'session', id: 's1' }
      if (prompts.length === 1) await o.tools.find((t) => t.name === 'propose_grants')!.run({ change: { packs: ['p'], hosts: ['api.example.com'] }, reason: 'read the tracker' })
      yield { k: 'text', t: prompts.length === 1 ? 'Asked for the tracker.' : 'Understood.' }
      yield { k: 'result', ok: true }
    },
  }
  const cfg = { ...loadConfig({ WORK_CONSOLE_HOME: home, WORK_CONSOLE_FAKE_GATEWAY: '1' }), loopbackPort: 0 }
  const m = await main({ cfg, sdk: withAgent, workspaces: [acmeServer, betaW], root })
  api.setBase(`http://127.0.0.1:${m.loopbackPort}`)
  const idle = async () => (await api.state()).ws.beta.agent?.status === 'idle'
  try {
    applyState(await api.state())
    assert.deepEqual([L('acme').managed, L('beta').managed, L('beta').agent], [false, true, null])
    assert.equal((await api.agentSay('beta', 'set it up')).status, 'running')
    await until(idle)
    applyState(await api.state())
    const a = L('beta').agent!
    assert.deepEqual(a.turns.map((t) => [t.who, t.t]), [['you', 'set it up'], ['agent', 'Asked for the tracker.']])
    assert.deepEqual(a.pending?.diff, ['+ host api.example.com'])
    await assert.rejects(api.agentGrants('beta', false, ' '), (e: api.ApiError) => e.status === 400)
    assert.equal((await api.agentGrants('beta', false, 'not yet')).pending, undefined)
    await until(async () => prompts.length === 2 && await idle())
    assert.match(prompts[1], /Their reason: not yet/)
    // a new conversation replaces the one on screen; a late frame of the older one does not
    const fresh = await api.agentNew('beta')
    onEvent({ kind: 'agent', ws: 'beta', agent: fresh })
    onEvent({ kind: 'agent', ws: 'beta', agent: a })
    assert.equal(L('beta').agent!.id, fresh.id)
    // a reply that arrives after its own conversation's later events does not undo them
    const later = { ...fresh, status: 'idle' as const, updated: new Date(Date.parse(fresh.updated) + 5).toISOString() }
    onEvent({ kind: 'agent', ws: 'beta', agent: later })
    onEvent({ kind: 'agent', ws: 'beta', agent: { ...fresh, status: 'running' } })
    assert.equal(L('beta').agent!.updated, later.updated)
  } finally { await m.close() }
})

test('a workspace on its own store names the database and why when it is down; a gateway one keeps the bridge wording', async () => {
  const m = await backend()
  try {
    const st = await api.state()
    st.ws.beta.bridge = { state: 'unavailable', concepts: {}, via: 'store', why: 'Postgres not running — start Docker and run install again' }
    applyState(st)
    api.LIVE.on = true
    assert.equal(down('beta').banner, 'The database is unavailable: Postgres not running — start Docker and run install again. Jobs cannot be read or changed until it is back; nothing is queued.')
    assert.equal(down('beta').off, 'The database is unavailable')
    assert.equal(srcState('chat', 'beta'), 'the database is unavailable')
    assert.equal(down('acme').banner, 'The bridge is unavailable: sources are unavailable and changes are refused until it is back. Nothing is queued.')
    // a later frame brings a new reason; what the workspace stands on stays
    onEvent({ kind: 'bridge', ws: 'beta', state: 'unavailable', concepts: {}, why: 'connect ECONNREFUSED 127.0.0.1:55433.' })
    assert.equal(L('beta').via, 'store')
    assert.match(down('beta').banner, /^The database is unavailable: connect ECONNREFUSED 127\.0\.0\.1:55433\. Jobs/)
    onEvent({ kind: 'bridge', ws: 'beta', state: 'unavailable', concepts: {} })
    assert.match(down('beta').banner, /^The database is unavailable\. Jobs/, 'no reason, no colon')
  } finally { api.LIVE.on = false; await m.close() }
})

test('the state names the build the server serves; a later state with another build flags the page as updated', async () => {
  const m = await backend()
  const was = { build: LIVE.build, updated: LIVE.updated }
  try {
    const st = await api.state()
    assert.equal(st.build, buildId(fileURLToPath(new URL('../../dist/index.html', import.meta.url))))
    LIVE.build = null; LIVE.updated = false
    applyState({ ...st, build: null })
    assert.equal(LIVE.updated, false, 'no build (the dev server) is never an update')
    applyState({ ...st, build: 'a' })
    applyState({ ...st, build: 'a' })
    assert.equal(LIVE.build, 'a')
    assert.equal(LIVE.updated, false, 'the same build again is not an update')
    applyState({ ...st, build: 'b' })
    assert.equal(LIVE.updated, true, 'a restart into another build asks for a reload')
    assert.equal(LIVE.build, 'a', 'the page still runs the build it loaded')
    applyState({ ...st, build: null })
    assert.equal(LIVE.updated, true, 'and keeps asking')
  } finally { Object.assign(LIVE, was); await m.close() }
})

test("a source waiting for a sign-in names its host; Sign in brings that tab of the console's browser forward", async () => {
  const cdp = await startFakeCdp()
  cdp.addTab('https://board.example/acme/core', { DATA: { work: [] } })
  const inbox = cdp.addTab('https://mail.example/inbox', { DATA: { chat: [] } })
  inbox.ctx.MODE = { mail: { ok: false, code: 'unauthorized', message: 'GET /api → 401' } }
  const browser: Browser = { endpoint: () => cdp.url, status: () => ({ state: 'up' }), start: async () => {}, stop: async () => {}, onChange: () => () => {} }
  const w: WorkspaceServer = {
    page: { ...acme, id: 'own' }, jobPrefix: 'O',
    source: (cfg, o) => localSource(cfg, {
      ...o, browser, packsDir: join(import.meta.dirname, '..', '..', 'server', 'browser', 'testdata', 'packs'), tickMs: 20,
      grants: () => ({ packs: ['fixture'], hosts: ['board.example', 'mail.example'], config: { fixture: { org: 'acme' } } }),
      docs: { load: async () => ({ docs: {}, seq: 0 }), put: async () => {}, seq: async () => {} },
    }),
  }
  const home = tempDir('api')
  const m = await main({ cfg: { ...loadConfig({ WORK_CONSOLE_HOME: home }), loopbackPort: 0 }, sdk, workspaces: [w] })
  api.setBase(`http://127.0.0.1:${m.loopbackPort}`)
  try {
    applyState(await api.state())
    api.LIVE.on = true
    await until(async () => { await loadSources('own', ['mail', 'chat']); return signinHost('mail', 'own') !== undefined })
    assert.equal(signinHost('mail', 'own'), 'mail.example')
    assert.match(srcState('mail', 'own')!, /sign-in required at mail\.example/)
    assert.equal(signinHost('chat', 'own'), undefined, 'a source that reads has nothing to sign in to')
    await api.front('own', 'mail.example')
    assert.deepEqual(cdp.activated, [inbox.id])
    await assert.rejects(api.front('own', 'elsewhere.example'), /no tab/)
  } finally { api.LIVE.on = false; await m.close(); await cdp.close() }
})

test('the event stream hands the page each kind the server sends: an update that ends clears the banner', () => {
  const g = globalThis as { EventSource?: unknown }, was = g.EventSource, heard = new Map<string, (m: { data: string }) => void>()
  g.EventSource = class { addEventListener(k: string, f: (m: { data: string }) => void) { heard.set(k, f) } close() {} }
  try {
    const got: api.Ev[] = []
    const off = api.events((e) => got.push(e))
    heard.get('update')?.({ data: JSON.stringify({ update: null }) })
    heard.get('build')?.({ data: JSON.stringify({ id: 'b1', t: 'built' }) })
    off()
    assert.deepEqual(got, [{ kind: 'update', update: null }, { kind: 'build', id: 'b1', t: 'built' }])
  } finally { g.EventSource = was }
})

test("a failed core update through the page's client: the state and its events carry it; Reintegrate opens a conversation; Give up drops it", async () => {
  const home = tempDir('api'), root = tempDir('root'), wt = tempDir('wt')
  mkdirSync(join(root, 'workspaces', 'beta'), { recursive: true })
  writeFileSync(join(root, 'workspaces', 'beta', 'grants.json'), JSON.stringify({ packs: ['p'] }))
  mkdirSync(join(root, 'scripts'))
  writeFileSync(join(root, 'scripts', 'update.mjs'), "import { rmSync } from 'node:fs'\nif (process.argv.includes('--give-up')) rmSync(process.env.WORK_CONSOLE_HOME + '/update-failed.json')\n")
  const git = (...a: string[]) => execFileSync('git', ['-C', wt, ...a], { encoding: 'utf8' }).trim()
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't')
  writeFileSync(join(wt, 'a.ts'), 'export const a = 1\n'); git('add', '-A'); git('commit', '-q', '-m', 'folder')
  const pre = git('rev-parse', 'HEAD')
  writeFileSync(join(wt, 'a.ts'), 'export const a = 2\n'); git('add', '-A'); git('commit', '-q', '-m', 'core eeeeeee')
  writeFileSync(join(home, 'update-failed.json'), JSON.stringify({ core: 'e'.repeat(40), from: 'f'.repeat(40), repo: wt, branch: 'update/eeeeeee', worktree: wt, dir: wt, pre, head: pre, step: 'build', output: 'vite: beta/ui.tsx failed', at: '2026-10-08T12:00:00.000Z' }))
  const withAgent: Sdk = { ...sdk, async *agent() { yield { k: 'session', id: 's1' }; yield { k: 'text', t: 'Fixing.' }; yield { k: 'result', ok: true } } }
  const cfg = { ...loadConfig({ WORK_CONSOLE_HOME: home, WORK_CONSOLE_FAKE_GATEWAY: '1' }), loopbackPort: 0 }
  const m = await main({ cfg, sdk: withAgent, workspaces: [acmeServer, betaW], root })
  api.setBase(`http://127.0.0.1:${m.loopbackPort}`)
  try {
    applyState(await api.state())
    assert.deepEqual([LIVE.update?.step, LIVE.update?.reintegrable, LIVE.update?.running], ['build', true, null])
    const a = await api.agentReintegrate('beta')
    assert.equal(a.reintegrate?.branch, 'update/eeeeeee')
    await until(async () => (await api.state()).ws.beta.agent?.status === 'idle')
    assert.equal((await api.updateRun('give-up'))?.running, 'give-up')
    await until(async () => (await api.state()).update === null)
    applyState(await api.state())
    assert.equal(LIVE.update, null)
    await assert.rejects(api.updateRun('apply'), (e: api.ApiError) => e.status === 409 && e.code === 'no_update')
    onEvent({ kind: 'update', update: { core: 'c', from: 'f', branch: 'update/c', step: 'sync', output: '', at: '', reintegrable: false, running: null } })
    assert.equal((LIVE.update as api.State['update'])?.step, 'sync', 'an update event replaces it')
  } finally { LIVE.update = null; await m.close() }
})
