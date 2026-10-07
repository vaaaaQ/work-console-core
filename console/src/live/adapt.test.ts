import { test } from 'node:test'
import assert from 'node:assert/strict'
import { actFor, adapt, isAddr, when } from './adapt.ts'

const now = new Date('2026-09-30T15:00:00Z') // 12:00 at home (UTC−3)

test('times show as home-zone wall time today, yesterday, or the date', () => {
  assert.equal(when('2026-09-30T11:47:00Z', now), '08:47')
  assert.equal(when('2026-09-29T20:00:00Z', now), 'yesterday')
  assert.equal(when('2026-09-20T12:00:00Z', now), '20/09')
  assert.equal(when('not a date', now), 'not a date')
})

test('a chat item becomes a chat with the last message as its summary', () => {
  const c = adapt.chat({ id: '19:abc', name: 'Team Dev', kind: 'group', unread: 2, lastAt: '2026-09-30T13:05:00Z', lastFrom: 'Tom Becker', lastPreview: 'Will look after lunch.', link: 'https://x' }, now)
  assert.deepEqual(c, { id: '19:abc', name: 'Team Dev', kind: 'group', unread: 2, sum: 'Tom Becker: Will look after lunch.', msgs: [], at: '10:05', link: 'https://x' })
})

test('a hidden thread brought back by a mention keeps both marks; plain threads carry neither', () => {
  const c = adapt.chat({ id: '19:h', name: 'Noisy', kind: 'group', unread: 1, lastAt: '2026-09-30T13:05:00Z', hidden: true, mentioned: true }, now)
  assert.equal(c.hidden, 1); assert.equal(c.mentioned, 1)
  const p = adapt.chat({ id: '19:p', name: 'Plain', kind: 'group', unread: 0, lastAt: '2026-09-30T13:05:00Z', mentioned: false }, now)
  assert.ok(!('hidden' in p) && !('mentioned' in p))
})

test('messages mark me and bots', () => {
  assert.deepEqual(adapt.msg({ id: '1', author: 'Me', authorKind: 'me', at: '2026-09-30T12:12:00Z', text: 'hi' }, now), { who: 'You', me: 1, at: '09:12', t: 'hi' })
  assert.equal(adapt.msg({ author: 'Jenkins', authorKind: 'bot', at: '', text: 'x' }, now).bot, 1)
})

test('mail keeps its category, shows who a waiting mail went to, and takes the console marks', () => {
  const m = adapt.mail({ id: 'm3', from: 'Me', to: ['Release team'], subject: 'ACME-530 staging window', at: '2026-09-29T18:00:00Z', preview: 'p', category: 'wait', myReply: false }, { job: 'J-0418' }, now)
  assert.deepEqual(m, { id: 'm3', cat: 'wait', from: 'You → Release team', subj: 'ACME-530 staging window', at: 'yesterday', sum: 'p', body: '', job: 'J-0418' })
  assert.equal(adapt.mail({ id: 'x', category: 'weird', myReply: true }, {}, now).cat, 'reply')
  assert.equal(adapt.mail({ id: 'x', category: 'reply', myReply: true }, {}, now).done, true)
})

test('a calendar event shows the home and the team zone', () => {
  const e = adapt.cal({ subject: 'Stand-up', start: '2026-09-30T08:00:00Z', end: '2026-09-30T08:15:00Z', organizer: 'SM', cancelled: false, joinUrl: 'https://zoom.example/j' }, 'Europe/Berlin')
  assert.deepEqual(e, {
    b: '05:00', v: '10:00', t: 'Stand-up', d: '15 min', n: 'SM',
    day: '2026-09-30', start: '2026-09-30T08:00:00.000Z', end: '2026-09-30T08:15:00.000Z', org: 'SM', join: 'https://zoom.example/j',
  })
  const x = adapt.cal({ subject: 'x', start: '2026-09-30T08:00:00Z', end: '2026-09-30T08:00:00Z', cancelled: true, joinUrl: 'javascript:alert(1)' }, null)
  assert.equal(x.n, 'cancelled'); assert.equal(x.x, 1); assert.equal(x.join, undefined); assert.equal(x.org, undefined)
})

test('a calendar event takes its home-zone date, not the UTC one; winter moves only the team zone', () => {
  assert.equal(adapt.cal({ start: '2026-10-01T02:30:00Z', end: '2026-10-01T03:00:00Z' }, 'Europe/Berlin').day, '2026-09-30')
  const w = adapt.cal({ start: '2026-11-02T09:00:00Z', end: '2026-11-02T09:30:00Z' }, 'Europe/Berlin')
  assert.deepEqual([w.b, w.v, w.day], ['06:00', '10:00', '2026-11-02'])
  assert.equal(adapt.cal({ start: 'nope', end: 'nope' }, null).day, undefined)
})

test('actFor maps a send channel to its bridge action', () => {
  assert.deepEqual(actFor('chat', 'Team Dev', 't'), { action: 'chat.post', args: { chatName: 'Team Dev', text: 't' } })
  assert.deepEqual(actFor('work', 'ACME-512', 't'), { action: 'work.comment', args: { id: 'ACME-512', text: 't' } })
  assert.deepEqual(actFor('mail', 'm2', 't'), { action: 'mail.send', args: { replyTo: 'm2', text: 't' } })
  assert.equal(actFor('pr', 'x', 't'), null)
})

test('actFor sends a new mail with its head: addresses split on commas, semicolons or spaces, no cc when empty', () => {
  assert.deepEqual(actFor('mail', 'ignored', 'body', { to: 'a@x.example; b@x.example', cc: 'c@x.example', subject: 'Hi' }),
    { action: 'mail.send', args: { to: ['a@x.example', 'b@x.example'], cc: ['c@x.example'], subject: 'Hi', text: 'body' } })
  assert.deepEqual(actFor('mail', '', 'body', { to: 'a@x.example', cc: ' ', subject: 'Hi' })?.args, { to: ['a@x.example'], subject: 'Hi', text: 'body' })
  assert.deepEqual([isAddr('a@x.example'), isAddr('Sam Rivera'), isAddr('a@')], [true, false, false])
})
