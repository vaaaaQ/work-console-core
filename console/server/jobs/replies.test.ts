import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import type { Cmd, Job, ReplyWatch, Tpl } from '../../src/model/types.ts'
import { Bus } from '../events.ts'
import { fileStore } from '../store/file.ts'
import { tempDir } from '../testdirs.ts'
import { demoCtx, demoSeed } from '../testkit.ts'
import { Jobs } from './jobs.ts'
import { Replies, chatHit, mailHit, watches } from './replies.ts'
import type { MailItem } from './replies.ts'

type Msg = { id: string; author: string; authorKind: string; at: string; text: string }
const iso = (ms: number) => new Date(ms).toISOString()

function setup() {
  const store = fileStore(join(tempDir('replies'), 's.json'), demoSeed)
  const bus = new Bus(), jobs = new Jobs({ store, bus, ctx: demoCtx, gate: () => true })
  const threads: Record<string, Msg[]> = {}, mails: MailItem[] = [], bodies: Record<string, string> = {}, st = { down: false }
  const source = {
    // a thread comes newest first, as the gateway gives it
    get: async (c: string, id: string) => {
      if (st.down) throw new Error('the source is down')
      return c === 'chat' ? { status: 'ok', items: { messages: [...(threads[id] ?? [])].reverse() } } : { status: 'ok', items: { body: bodies[id] } }
    },
    read: async () => { if (st.down) throw new Error('the source is down'); return { mail: { status: 'ok', items: mails } } },
  }
  const replies = new Replies({ jobs, source, bus })
  /** a started job whose ask step n1 sent its message: the watch starts now */
  const asked = async (tpl: Tpl, sent: Partial<Extract<Cmd, { op: 'sent' }>>) => {
    const j = await jobs.create({ t: 'Ask', key: 'K-1', pb: 'action', prj: 'p', ws: 'acme' })
    await jobs.cmd(j.id, { op: 'start' })
    await jobs.cmd(j.id, { op: 'ppSet', say: 'ask the PO', cmds: [{ op: 'stepAdd', before: 'tr', step: { t: 'Ask the PO', m: 'you', ask: 1 }, tpl: [tpl] }], by: 'c1' }, undefined, 'console')
    await jobs.cmd(j.id, { op: 'ppAccept' })
    const r = await jobs.cmd(j.id, { op: 'sent', step: 'n1', i: 0, t: tpl[2], to: 'them', ...sent })
    return { id: j.id, at: Date.parse(r.job.flow.n1.rw!.at) }
  }
  const msg = (ch: string, id: string, at: number, text: string, authorKind = 'person', author = 'Ana') => (threads[ch] ??= []).push({ id, author, authorKind, at: iso(at), text })
  const chatEv = (ids: string[], reset = false) => bus.emit({ kind: 'source', concept: 'chat', upserts: ids.map((id) => ({ id })), removes: [], ...(reset ? { reset } : {}) })
  const rp = async (id: string) => (await jobs.get(id))!.flow.n1.rp ?? []
  return { jobs, bus, threads, mails, bodies, st, replies, asked, msg, chatEv, rp }
}
const w: ReplyWatch = { src: 'mail', ch: 'm-1', to: 'ana@x.org, bo@x.org', at: '2026-10-09T12:00:00.000Z' }

test('chatHit counts a person\'s message after at; me, bot and earlier ones do not', () => {
  const c: ReplyWatch = { src: 'chat', ch: 'c-1', at: w.at }
  assert.equal(chatHit(c, { authorKind: 'person', at: '2026-10-09T12:00:01.000Z' }), true)
  assert.equal(chatHit(c, { authorKind: 'me', at: '2026-10-09T12:00:01.000Z' }), false)
  assert.equal(chatHit(c, { authorKind: 'bot', at: '2026-10-09T12:00:01.000Z' }), false)
  assert.equal(chatHit(c, { authorKind: 'person', at: '2026-10-09T11:59:59.000Z' }), false)
})

test('mailHit counts an Inbox mail after at in the thread or from the addressee; Sent and other threads do not', () => {
  const m = (o: Partial<MailItem>): MailItem => ({ id: 'm-2', folder: 'Inbox', from: 'Cy', at: '2026-10-09T12:05:00.000Z', conversationId: 'conv-1', ...o })
  assert.equal(mailHit(w, 'conv-1', m({})), true)
  assert.equal(mailHit(w, 'conv-1', m({ folder: 'Sent' })), false)
  assert.equal(mailHit(w, 'conv-1', m({ at: '2026-10-09T11:00:00.000Z' })), false)
  assert.equal(mailHit(w, 'conv-1', m({ conversationId: 'conv-9' })), false)
  assert.equal(mailHit(w, null, m({ conversationId: 'conv-9', from: 'Bo <BO@x.org>' })), true)
  assert.equal(mailHit({ ...w, to: undefined }, null, m({ from: 'ana@x.org' })), false)
})

test('watches are the live ask steps of open jobs that wait in chat or mail', async () => {
  const s = setup(), a = await s.asked(['chat', 'team', 'ok?'], { ch: 'c-1' })
  const all = await s.jobs.all()
  assert.deepEqual(watches(all).map((x) => [x.job, x.step, x.rw.ch]), [[a.id, 'n1', 'c-1']])
  const closed = all.map((j): Job => (j.id === a.id ? { ...j, st: 'done' } : j))
  assert.deepEqual(watches(closed), [])
  s.replies.stop()
})

test('a chat upsert of the watched channel records the reply once, even when the event repeats', async () => {
  const s = setup(), a = await s.asked(['chat', 'team', 'ok?'], { ch: 'c-1' })
  s.msg('c-1', 'x0', a.at - 1000, 'an older one')
  s.msg('c-1', 'x1', a.at + 1000, 'mine', 'me', 'You')
  s.msg('c-1', 'x2', a.at + 2000, 'Yes, go ahead')
  s.msg('c-1', 'x3', a.at + 3000, 'and one more')
  s.chatEv(['c-9'])
  await s.replies.idle()
  assert.deepEqual(await s.rp(a.id), [])
  s.chatEv(['c-1']); s.chatEv(['c-1'])
  await s.replies.idle()
  assert.deepEqual((await s.rp(a.id)).map((r) => [r.id, r.from, r.t]), [['x2', 'Ana', 'Yes, go ahead'], ['x3', 'Ana', 'and one more']])
  assert.equal((await s.jobs.get(a.id))!.jr.filter((e) => e.o.startsWith('Reply from')).length, 2)
  s.replies.stop()
})

test('a chat reset checks every chat watch', async () => {
  const s = setup(), a = await s.asked(['chat', 'team', 'ok?'], { ch: 'c-1' }), b = await s.asked(['chat', 'team', 'ok?'], { ch: 'c-2' })
  s.msg('c-1', 'x1', a.at + 1000, 'one'); s.msg('c-2', 'y1', b.at + 1000, 'two')
  s.chatEv([], true)
  await s.replies.idle()
  assert.deepEqual((await s.rp(a.id)).map((r) => r.t), ['one'])
  assert.deepEqual((await s.rp(b.id)).map((r) => r.t), ['two'])
  s.replies.stop()
})

test('a mail upsert in the thread of the replied mail is recorded with its body and link', async () => {
  const s = setup(), a = await s.asked(['mail', 'reply', 'ok?'], { ch: 'm-1' })
  s.mails.push({ id: 'm-1', folder: 'Inbox', from: 'Ana', at: iso(a.at - 60000), conversationId: 'conv-1' })
  s.bodies['m-2'] = 'Yes, the full answer'
  const m2: MailItem = { id: 'm-2', folder: 'Inbox', from: 'Ana', at: iso(a.at + 1000), conversationId: 'conv-1', preview: 'Yes', link: 'https://mail.example/m-2' }
  const other: MailItem = { id: 'm-3', folder: 'Inbox', from: 'Ana', at: iso(a.at + 2000), conversationId: 'conv-7', preview: 'other' }
  s.bus.emit({ kind: 'source', concept: 'mail', upserts: [m2, other], removes: [] })
  await s.replies.idle()
  assert.deepEqual(await s.rp(a.id), [{ id: 'm-2', at: m2.at, from: 'Ana', t: 'Yes, the full answer', link: 'https://mail.example/m-2' }])
  s.replies.stop()
})

test('a new mail\'s reply from its addressee is recorded; its preview stands in for a missing body', async () => {
  const s = setup(), a = await s.asked(['mail', 'new', 'ok?'], { ch: '', rto: 'ana@x.org' })
  const sent: MailItem = { id: 'm-1', folder: 'Sent', from: 'You', at: iso(a.at + 500), conversationId: 'conv-1' }
  const back: MailItem = { id: 'm-2', folder: 'Inbox', from: 'Ana <ana@x.org>', at: iso(a.at + 1000), conversationId: 'conv-1', preview: 'Sure' }
  s.bus.emit({ kind: 'source', concept: 'mail', upserts: [sent, back], removes: [] })
  await s.replies.idle()
  assert.deepEqual((await s.rp(a.id)).map((r) => [r.id, r.t]), [['m-2', 'Sure']])
  s.replies.stop()
})

test('reconcile finds what arrived while the source was down', async () => {
  const s = setup(), a = await s.asked(['chat', 'team', 'ok?'], { ch: 'c-1' }), b = await s.asked(['mail', 'reply', 'ok?'], { ch: 'm-1' })
  s.msg('c-1', 'x1', a.at + 1000, 'chat answer')
  s.mails.push({ id: 'm-1', folder: 'Inbox', from: 'Ana', at: iso(b.at - 60000), conversationId: 'conv-1' },
    { id: 'm-2', folder: 'Inbox', from: 'Ana', at: iso(b.at + 1000), conversationId: 'conv-1', preview: 'mail answer' })
  await s.replies.reconcile()
  assert.deepEqual((await s.rp(a.id)).map((r) => r.t), ['chat answer'])
  assert.deepEqual((await s.rp(b.id)).map((r) => r.t), ['mail answer'])
  s.replies.stop()
})

test('a source that throws on get leaves the next event\'s check working', async () => {
  const s = setup(), a = await s.asked(['chat', 'team', 'ok?'], { ch: 'c-1' })
  s.msg('c-1', 'x1', a.at + 1000, 'here')
  s.st.down = true
  s.chatEv(['c-1'])
  await s.replies.idle()
  assert.deepEqual(await s.rp(a.id), [])
  s.st.down = false
  s.chatEv(['c-1'])
  await s.replies.idle()
  assert.deepEqual((await s.rp(a.id)).map((r) => r.t), ['here'])
  s.replies.stop()
})

test('a step marked done meanwhile ignores its reply', async () => {
  const s = setup(), a = await s.asked(['chat', 'team', 'ok?'], { ch: 'c-1' })
  await s.jobs.cmd(a.id, { op: 'stepDone', step: 'n1' })
  s.msg('c-1', 'x1', a.at + 1000, 'too late')
  s.chatEv(['c-1'])
  await s.replies.idle()
  const j = (await s.jobs.get(a.id))!
  assert.equal(j.flow.n1.rp, undefined)
  assert.ok(!j.jr.some((e) => e.o.startsWith('Reply from')))
  s.replies.stop()
})

test('stop ends the listening', async () => {
  const s = setup(), a = await s.asked(['chat', 'team', 'ok?'], { ch: 'c-1' })
  s.replies.stop()
  s.msg('c-1', 'x1', a.at + 1000, 'unheard')
  s.chatEv(['c-1'])
  await s.replies.idle()
  assert.deepEqual(await s.rp(a.id), [])
})
