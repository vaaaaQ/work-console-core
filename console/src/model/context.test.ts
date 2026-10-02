import '../testkit.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PB0 } from '../data/playbooks.ts'
import { JOBS0, JR, OVR, TPL0 } from '../data/demo.ts'
import { clone } from '../lib/util.ts'
import { badItem, contextSection, ctxOf, okItem, parseWorkId, renderChat, renderWork, workId } from './context.ts'
import { CmdError, apply, atOf, freshJob, isClosed, seedFlow } from './transitions.ts'
import type { Ctx } from './transitions.ts'
import type { CtxItem, Job } from './types.ts'

const X: Ctx = { PB: PB0, TPL: TPL0, now: () => new Date('2026-09-30T12:00:00Z') }
const jobs = (): Job[] => clone(JOBS0).map((s) => { const j = s as Job; seedFlow(X, j, OVR[j.id], JR[j.id]); return j })
const find = (p: (j: Job) => boolean) => jobs().find(p)!
const open = () => find((j) => !isClosed(j) && j.st !== 'recurring' && j.st !== 'draft' && !!atOf(X, j))
const code = (f: () => unknown, c: string) => assert.throws(f, (e: unknown) => e instanceof CmdError && e.code === c)

const W: CtxItem = { k: 'work', id: 'ACME-603', n: 2, name: 'ACME-603' }
const C: CtxItem = { k: 'chat', id: 'c4', n: 2, name: 'Sam Rivera' }

test('a job key that looks like an item id names a work item; any other key names none', () => {
  assert.equal(workId('acme', 'ACME-512'), 'ACME-512')
  assert.equal(workId('acme', 'NEW'), null)
  assert.equal(parseWorkId('acme', ' ACME-603 '), 'ACME-603')
  assert.equal(parseWorkId('acme', 'hello'), null)
})

test('a work item reads as header, sections and its newest comments, oldest first', () => {
  const t = renderWork(W, {
    type: 'Bug', title: 'Export ignores the filter', state: 'To Do', assignedTo: null,
    description: 'Open the grid.', reproSteps: '1. filter\n2. export', acceptanceCriteria: '',
    comments: [
      { author: 'Ann', at: '2026-09-30T09:00:00Z', text: 'third' },
      { author: 'Bob', at: '2026-09-28T09:00:00Z', text: 'first' },
      { author: 'Cy', at: '2026-09-29T09:00:00Z', text: 'second' },
    ],
  })
  assert.equal(t, [
    'Bug ACME-603: Export ignores the filter', 'State To Do · assigned to nobody', '',
    'Description:', 'Open the grid.', '', 'Repro steps:', '1. filter\n2. export', '',
    'Comments, oldest first:', '- 2026-09-29 09:00Z Cy: second', '- 2026-09-30 09:00Z Ann: third',
  ].join('\n'))
})

test('an item from an older pack keeps what it has; long text is clipped', () => {
  const t = renderWork(W, { description: 'x'.repeat(5000), comments: [] })
  assert.match(t, /^Work item ACME-603\n\nDescription:\nx{4000} \[…\]\n\nNo comments\.$/)
})

test('a chat reads as its newest messages, oldest first, me as the user', () => {
  const t = renderChat(C, { messages: [
    { author: 'Sam', authorKind: 'person', at: '2026-09-30T09:00:00Z', text: 'one' },
    { author: 'Me', authorKind: 'me', at: '2026-09-30T09:05:00Z', text: 'two\nlines' },
    { author: 'Sam', authorKind: 'person', at: '2026-09-30T09:10:00Z', text: 'three' },
    { author: 'Sam', authorKind: 'person', at: '2026-09-30T09:11:00Z', text: '  ' },
  ] })
  assert.equal(t, '- 2026-09-30 09:05Z the user: two\n  lines\n- 2026-09-30 09:10Z Sam: three')
  assert.equal(renderChat(C, {}), 'No messages.')
})

test("me's own entries carry the workspace's name for the user when it has one", () => {
  const me = { author: 'Someone', authorKind: 'me', at: '2026-09-30T09:05:00Z', text: 'mine' }
  assert.equal(renderChat(C, { messages: [me] }, 'Robin'), '- 2026-09-30 09:05Z Robin: mine')
  assert.equal(renderChat(C, { messages: [me] }, ''), '- 2026-09-30 09:05Z the user: mine', 'an empty name is no name')
  assert.match(renderWork(W, { comments: [me] }, 'Robin'), /\n- 2026-09-30 09:05Z Robin: mine$/)
  assert.match(okItem(W, { comments: [me] }, 'Robin').text, /Robin: mine$/)
  assert.match(okItem(W, { comments: [me] }).text, /the user: mine$/)
})

test('the context section heads each item and marks the unreadable ones', () => {
  assert.equal(contextSection('acme', []), '')
  const s = contextSection('acme', [okItem(C, { messages: [] }), badItem(W, 'signin_required', 'sign in to Jira')])
  assert.equal(s, '## Context\n### Chat Sam Rivera (last 2 messages)\nNo messages.\n\n### Work item ACME-603 (last 2 comments) — unavailable\nsign in to Jira\n')
  assert.equal(badItem(W, 'ok', 'empty').status, 'source_error')
})

/* ===== the job's list ===== */
test('a new job gets its context from its key and its chat', () => {
  const both = freshJob(X, 'J-9010', { t: 'x', key: 'ACME-512', pb: 'action', prj: 'platform', ws: 'acme', chat: 'c4', chatName: 'Sam Rivera' })
  assert.deepEqual(both.ctx, [{ k: 'work', id: 'ACME-512', n: 10, name: 'ACME-512' }, { k: 'chat', id: 'c4', n: 10, name: 'Sam Rivera' }])
  assert.equal(freshJob(X, 'J-9011', { t: 'x', key: 'NEW', pb: 'action', prj: 'platform', ws: 'acme' }).ctx, undefined)
  assert.deepEqual(freshJob(X, 'J-9012', { t: 'x', key: 'CHAT', pb: 'action', prj: 'platform', ws: 'acme', chat: '19:abc' }).ctx, [{ k: 'chat', id: '19:abc', n: 10 }])
})

test('context ops add, recount and remove items and journal each change', () => {
  const j = open(), base = ctxOf(j).length
  const a = apply(X, j, { op: 'ctxAdd', k: 'chat', id: 'c4', name: 'Sam Rivera' }).job
  assert.deepEqual(a.ctx!.at(-1), { k: 'chat', id: 'c4', n: 10, name: 'Sam Rivera' })
  assert.equal(a.ctx!.length, base + 1)
  assert.equal(a.jr[0].o, 'Added chat Sam Rivera to the context.')
  const s = apply(X, a, { op: 'ctxSet', k: 'chat', id: 'c4', n: 25 }).job
  assert.equal(s.ctx!.at(-1)!.n, 25)
  assert.equal(s.jr[0].o, 'Chat Sam Rivera now gives the last 25 messages.')
  const d = apply(X, s, { op: 'ctxDel', k: 'chat', id: 'c4' }).job
  assert.equal(d.ctx!.length, base)
  assert.equal(d.jr[0].o, 'Removed chat Sam Rivera from the context.')
  assert.equal(j.ctx, undefined, 'apply leaves the input alone')
})

test('context ops refuse bad kinds, ids, counts, duplicates, missing items and closed jobs', () => {
  const j = apply(X, open(), { op: 'ctxAdd', k: 'work', id: 'ACME-999' }).job
  code(() => apply(X, j, { op: 'ctxAdd', k: 'mail' as never, id: 'm1' }), 'bad_args')
  code(() => apply(X, j, { op: 'ctxAdd', k: 'work', id: 'hello' }), 'bad_args')
  code(() => apply(X, j, { op: 'ctxAdd', k: 'chat', id: ' ' }), 'bad_args')
  code(() => apply(X, j, { op: 'ctxAdd', k: 'work', id: 'ACME-999' }), 'bad_args')
  code(() => apply(X, j, { op: 'ctxSet', k: 'work', id: 'ACME-999', n: 21 }), 'bad_args')
  code(() => apply(X, j, { op: 'ctxSet', k: 'work', id: 'ACME-999', n: 1.5 }), 'bad_args')
  code(() => apply(X, j, { op: 'ctxDel', k: 'chat', id: 'nope' }), 'bad_args')
  let full = j
  while (full.ctx!.length < 10) full = apply(X, full, { op: 'ctxAdd', k: 'chat', id: `c-${full.ctx!.length}` }).job
  code(() => apply(X, full, { op: 'ctxAdd', k: 'chat', id: 'one-more' }), 'bad_args')
  const closed = apply(X, j, { op: 'close', st: 'done' }).job
  code(() => apply(X, closed, { op: 'ctxDel', k: 'work', id: 'ACME-999' }), 'bad_state')
})

test('a job made before context lists starts from its defaults on the first edit', () => {
  const j = find((x) => x.key === 'CHAT')
  assert.equal(j.ctx, undefined)
  assert.deepEqual(ctxOf(j), [{ k: 'chat', id: 'c4', n: 10 }])
  const r = apply(X, j, { op: 'ctxSet', k: 'chat', id: 'c4', n: 5 }).job
  assert.deepEqual(r.ctx, [{ k: 'chat', id: 'c4', n: 5 }])
  const w = find((x) => x.key === 'ACME-512')
  assert.deepEqual(ctxOf(w), [{ k: 'work', id: 'ACME-512', n: 10, name: 'ACME-512' }])
})

test('a build or ticket job names no work item, though its key looks like an item id', () => {
  assert.deepEqual(ctxOf(find((x) => x.key === 'BUILD-1287')), [])
  assert.deepEqual(ctxOf(find((x) => x.key === 'SUP-77')), [])
})
