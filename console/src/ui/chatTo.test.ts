import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Chat } from '../model/types.ts'
import { toRows } from './chatTo.ts'

const chat = (id: string, name: string, o: Partial<Chat> = {}): Chat => ({ id, name, kind: 'oneOnOne', unread: 0, sum: '', msgs: [], at: '10:00', ...o })
const CHATS = [chat('c1', 'Team Dev', { kind: 'group' }), chat('c2', 'Priya Nair', { at: '', kept: 1 }), chat('c3', 'Sam Rivera')]
const PEOPLE = [
  { name: 'Priya Nair', mail: 'priya.nair@acme.example', title: 'Systems Administrator' },
  { name: 'Priyanka Rao', mail: 'p.rao@acme.example', title: null },
]

test('fewer than two letters offer nothing', () => {
  assert.deepEqual(toRows(' p ', CHATS, PEOPLE), [])
})

test('listed chats come first; a person named as one of them is that chat', () => {
  assert.deepEqual(toRows('priy', CHATS, PEOPLE), [
    { pick: { chat: 'c2', name: 'Priya Nair' }, sub: 'oneOnOne · kept' },
    { pick: { addr: 'p.rao@acme.example', name: 'Priyanka Rao' }, sub: 'p.rao@acme.example' },
  ])
})

test('a typed address nobody found is offered as a new chat; one somebody has is that person', () => {
  assert.deepEqual(toRows('lena@acme.example', CHATS, []), [{ pick: { addr: 'lena@acme.example', name: 'lena@acme.example' }, sub: 'a new chat with this address' }])
  assert.deepEqual(toRows('P.Rao@acme.example', [], [PEOPLE[1]]).map((r) => r.pick), [{ addr: 'p.rao@acme.example', name: 'Priyanka Rao' }])
})

test('a person with a title shows it before the mail', () => {
  assert.equal(toRows('nair', [], PEOPLE)[0].sub, 'Systems Administrator · priya.nair@acme.example')
})
