import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Job, RunRec } from '../../src/model/types.ts'
import { Bus } from '../events.ts'
import { acme, demoCtx, demoSeed } from '../testkit.ts'
import { install } from '../../src/workspace.ts'
import beta from '../../workspaces/beta/page.ts'
import { Notify } from './notify.ts'
import type { Sender, Sub } from './notify.ts'

const JOBS = demoSeed().jobs as Job[]
const sub = (n: number): Sub => ({ endpoint: `https://push.example/${n}`, keys: { p256dh: 'p', auth: 'a' } })

function setup(status: (s: Sub) => number = () => 201) {
  const dir = mkdtempSync(join(tmpdir(), 'wc-push-')), bus = new Bus()
  const sent: { to: string; title: string; body: string; url: string }[] = []
  const sender: Sender = { async send(s, p) { sent.push({ to: s.endpoint, ...JSON.parse(p) }); return { status: status(s) } } }
  let needs: ((j: Job) => void) | null = null, settled: ((r: RunRec) => void) | null = null
  const n = new Notify({
    dir, bus, ctx: demoCtx, sender,
    jobs: { onNeedsYou: (f) => { needs = f } }, runs: { onSettled: (f) => { settled = f } },
    jobFor: (t) => JOBS.find((j) => /^ACME-\d/.test(j.key) && t.includes(j.key)),
    job: (id) => JOBS.find((j) => j.id === id),
  })
  n.subscribe(sub(1))
  return { dir, bus, sent, n, needs: (j: Job) => needs!(j), settled: (r: RunRec) => settled!(r) }
}
const flush = () => new Promise((r) => setTimeout(r, 10))

test('runs: draft ready, failed and interrupted each push with the step name', async () => {
  const { sent, settled } = setup()
  const r: RunRec = { id: 'r1', job: 'J-0419', step: 'tr', q: 'q', state: 'draft', at: '' }
  settled(r); settled({ ...r, state: 'failed', reason: 'signin_required' }); settled({ ...r, state: 'interrupted', reason: 'A down' })
  await flush()
  assert.deepEqual(sent.map((s) => s.title), [
    'J-0419 · Understand the request: draft ready', 'J-0419 · Understand the request: run failed', 'J-0419 · Understand the request: run interrupted'])
  assert.equal(sent[1].body, 'signin_required')
  assert.equal(sent[0].url, '/?job=J-0419&step=tr&ws=acme', "the url opens the job's workspace")
})

test('an interrupted run that resumes by itself says so', async () => {
  const { sent, settled } = setup()
  settled({ id: 'r1', job: 'J-0419', step: 'tr', q: 'q', state: 'interrupted', reason: 'the console restarted', at: '', ar: 'due' })
  await flush()
  assert.equal(sent[0].title, 'J-0419 · Understand the request: run interrupted, resumes by itself')
})

test('a job that starts needing you pushes', async () => {
  const { sent, needs } = setup()
  needs(JOBS.find((j) => j.id === 'J-0419')!)
  await flush()
  assert.equal(sent.length, 1)
  assert.match(sent[0].title, /^J-0419: /)
  assert.equal(sent[0].url, '/?job=J-0419&ws=acme')
})

test('chat: more unread pushes sender and first line; reading it does not', async () => {
  const { sent, bus } = setup()
  bus.emit({ kind: 'source', concept: 'chat', upserts: [{ id: 'c1', name: 'Team Dev', unread: 1, lastFrom: 'Priya', lastPreview: '\nPlease look\nsecond line' }], removes: [] })
  bus.emit({ kind: 'source', concept: 'chat', upserts: [{ id: 'c1', name: 'Team Dev', unread: 0, lastFrom: 'Priya', lastPreview: 'x' }], removes: [] })
  bus.emit({ kind: 'source', concept: 'chat', upserts: [{ id: 'c1', name: 'Team Dev', unread: 0 }], removes: [], reset: true })
  await flush()
  assert.deepEqual(sent.map((s) => [s.title, s.body]), [['Team Dev', 'Priya: Please look']])
})

test('chat: a hidden thread that comes back with an unread mention pushes again', async () => {
  const { sent, bus } = setup()
  const t = { id: 'c1', name: 'Noisy', unread: 1, lastFrom: 'Ann', lastPreview: 'x' }
  bus.emit({ kind: 'source', concept: 'chat', upserts: [t], removes: [] })
  bus.emit({ kind: 'source', concept: 'chat', upserts: [], removes: ['c1'] })
  bus.emit({ kind: 'source', concept: 'chat', upserts: [{ ...t, hidden: true, mentioned: true, lastPreview: '@me look' }], removes: [] })
  await flush()
  assert.deepEqual(sent.map((s) => [s.title, s.body]), [['Noisy', 'Ann: x'], ['Noisy', 'Ann: @me look']])
})

test('mail: a new reply-category mail pushes once; others do not', async () => {
  const { sent, bus } = setup()
  const m = { id: 'm9', category: 'reply', from: 'Priya', subject: 'Q3 export', myReply: false, unread: true }
  bus.emit({ kind: 'source', concept: 'mail', upserts: [m, { ...m, id: 'm10', category: 'fyi' }, { ...m, id: 'm11', myReply: true }], removes: [] })
  bus.emit({ kind: 'source', concept: 'mail', upserts: [m], removes: [] })
  await flush()
  assert.deepEqual(sent.map((s) => s.title), ['Mail: Priya'])
})

test("a workspace's source event links to that workspace, and what it pushed is remembered per workspace", async () => {
  const { sent, bus } = setup()
  const c = { id: 'c1', name: 'Team Dev', unread: 1, lastFrom: 'Priya', lastPreview: 'hi' }
  const m = { id: 'm9', category: 'reply', from: 'Priya', subject: 'Q3 export', myReply: false, unread: true }
  for (const ws of ['acme', 'beta2', 'acme']) {
    bus.emit({ kind: 'source', concept: 'chat', upserts: [c], removes: [], ws })
    bus.emit({ kind: 'source', concept: 'mail', upserts: [m], removes: [], ws })
  }
  await flush()
  assert.deepEqual(sent.map((s) => s.url), [
    '/?view=chats&chat=c1&ws=acme', '/?view=mail&mail=m9&ws=acme', '/?view=chats&chat=c1&ws=beta2', '/?view=mail&mail=m9&ws=beta2'])
})

test('review and ci changes on a job key push; unrelated ones do not', async () => {
  const { sent, bus } = setup()
  const pr = { id: '482', title: 'feature/ACME-512-rate-limit', votes: [{ reviewer: 'Priya', vote: 1 }], activeThreads: 1 }
  bus.emit({ kind: 'source', concept: 'review', upserts: [pr, { id: '1', title: 'unrelated', votes: [] }], removes: [] })
  bus.emit({ kind: 'source', concept: 'review', upserts: [pr], removes: [] })
  bus.emit({ kind: 'source', concept: 'ci', upserts: [{ id: 'b1', pipeline: 'main', branch: 'feature/ACME-512-rate-limit', status: 'completed', result: 'failed' }], removes: [] })
  await flush()
  assert.deepEqual(sent.map((s) => s.title), ['J-0412: review #482: Priya +1', 'J-0412: build main failed'])
  assert.equal(sent[0].url, '/?job=J-0412&ws=acme', "no ws on the event: the job's own")
})

test("a review id is written with its workspace's mark, # by default", async () => {
  install([{ page: acme }, { page: { ...beta, reviewMark: '!' } }])
  try {
    const { sent, bus } = setup()
    const pr = { id: '7001', title: 'feature/ACME-512-rate-limit', votes: [{ reviewer: 'Priya', vote: 1 }] }
    for (const ws of ['beta', 'acme']) bus.emit({ kind: 'source', concept: 'review', upserts: [pr], removes: [], ws })
    await flush()
    assert.deepEqual(sent.map((s) => s.title), ['J-0412: review !7001: Priya +1', 'J-0412: review #7001: Priya +1'])
  } finally { install([{ page: acme }]) }
})

test('410 and 404 drop the subscription; a subscription seen twice is kept once', async () => {
  const { n, dir } = setup((s) => (s.endpoint.endsWith('/2') ? 410 : s.endpoint.endsWith('/3') ? 404 : 201))
  n.subscribe(sub(1)); n.subscribe(sub(2)); n.subscribe(sub(3))
  assert.equal(n.count(), 3)
  await n.push('t', 'b', '/')
  assert.equal(n.count(), 1)
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'push.json'), 'utf8')).map((s: Sub) => s.endpoint), ['https://push.example/1'])
  assert.throws(() => n.subscribe({ endpoint: 'http://insecure' }))
})

test('VAPID keys are made once and reused', () => {
  const { dir, n } = setup()
  assert.ok(existsSync(join(dir, 'vapid.json')))
  const again = new Notify({ dir, bus: new Bus(), ctx: demoCtx, jobFor: () => undefined, sender: { send: async () => ({ status: 201 }) } })
  assert.equal(again.publicKey(), n.publicKey())
})

test('a new knowledge proposal pushes once, to Approvals', async () => {
  const { sent, bus } = setup()
  const p = { id: 'P-0001', title: 'Sleeping tabs', reason: 'seen twice\nmore', by: 'llm' }
  bus.emit({ kind: 'source', concept: 'proposals', upserts: [p], removes: [] })
  bus.emit({ kind: 'source', concept: 'proposals', upserts: [p], removes: [] })
  await flush()
  assert.deepEqual(sent.map((s) => [s.title, s.body, s.url]), [['Knowledge: Sleeping tabs', 'llm: seen twice', '/?view=approvals']])
})
