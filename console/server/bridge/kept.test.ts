import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Job } from '../../src/model/types.ts'
import { Bus } from '../events.ts'
import type { Mark } from '../store/port.ts'
import { jobChats, keepJobChats, keptChats, withKept, withKeptNames } from './kept.ts'

const MARKS: Record<string, Mark> = {
  'chat:c9': { kept: true, name: 'Priya Nair' },
  'chat:c1': { kept: true, name: 'Team Dev' },
  'chat:c5': { kept: true, hidden: true, name: 'Lena Ortiz' },
  'chat:c2': { hidden: true, name: 'Ops' },
  m1: { done: true },
}
const item = (id: string, name: string) => ({ id, name, kind: 'chat', unread: 1, lastAt: '2026-10-13T10:00:00Z' })

test('kept chats are the chat marks with kept, by name', () => {
  assert.deepEqual(keptChats(MARKS).map((c) => c.id), ['c5', 'c9', 'c1'])
})

test('a listed kept chat carries kept; an unlisted one comes last with no last message; a hidden one stays out', () => {
  const out = withKept([item('c1', 'Team Dev'), item('c3', 'Sam Rivera')], MARKS)
  assert.deepEqual(out.map((i) => [i.id, i.kept ?? false]), [['c1', true], ['c3', false], ['c9', true]])
  assert.deepEqual(out[2], { id: 'c9', name: 'Priya Nair', kind: 'chat', unread: 0, lastAt: null, lastFrom: null, lastPreview: null, kept: true })
})

test('the act finds a kept chat the source no longer lists', () => {
  assert.deepEqual(withKeptNames([{ id: 'c1', name: 'Team Dev' }], MARKS).map((c) => c.id), ['c1', 'c5', 'c9'])
})

const job = (o: Partial<Job>): Job => ({ id: 'A-0001', v: 1, ...o }) as Job

test("a job's chats are its own and its context's, once each", () => {
  assert.deepEqual(jobChats(job({ chat: 'c1', ctx: [{ k: 'chat', id: 'c4', name: 'Sam' }, { k: 'mail', id: 'm1', name: 'x' }, { k: 'chat', id: 'c1', name: 'Team' }] } as Partial<Job>)), ['c1', 'c4'])
  assert.deepEqual(jobChats(job({})), [])
})

function fakeStore(marks: Record<string, Mark> = {}) {
  const puts: [string, Mark | null][] = []
  const st = {
    puts, down: false, marks: async () => structuredClone(marks),
    putMark: async (id: string, m: Mark | null) => { if (st.down) throw new Error('store down'); puts.push([id, m]); if (m) marks[id] = { ...marks[id], ...m } },
  }
  return st
}
const settle = () => new Promise((r) => setTimeout(r, 20))

test("a saved job's chats are kept once, named from its context or the source's list", async () => {
  const bus = new Bus(), store = fakeStore({ 'chat:c1': { kept: true, name: 'Team Dev' } })
  let listed = 0
  const off = keepJobChats({ bus, store, chats: async () => { listed++; return [{ id: 'c7', name: 'Lena Ortiz' }] } })
  bus.emit({ kind: 'job', job: job({ chat: 'c1', ctx: [{ k: 'chat', id: 'c4', name: 'Sam Rivera' }] } as Partial<Job>) })
  await settle()
  assert.deepEqual(store.puts, [['chat:c4', { kept: true, name: 'Sam Rivera' }]])
  assert.equal(listed, 0, 'every name came from the context')
  bus.emit({ kind: 'job', job: job({ v: 2, chat: 'c7', ctx: [{ k: 'chat', id: 'c4', name: 'Sam Rivera' }] } as Partial<Job>) })
  await settle()
  assert.deepEqual(store.puts.slice(1), [['chat:c7', { kept: true, name: 'Lena Ortiz' }]])
  off()
  bus.emit({ kind: 'job', job: job({ chat: 'c8' }) })
  await settle()
  assert.equal(store.puts.length, 2)
})

test('a chat the store could not keep is tried again on the next save', async (t) => {
  t.mock.method(console, 'error', () => {})
  const bus = new Bus(), store = fakeStore()
  keepJobChats({ bus, store, chats: async () => [] })
  store.down = true
  bus.emit({ kind: 'job', job: job({ chat: 'c4' }) })
  await settle()
  store.down = false
  bus.emit({ kind: 'job', job: job({ v: 2, chat: 'c4' }) })
  await settle()
  assert.deepEqual(store.puts, [['chat:c4', { kept: true }]])
})
