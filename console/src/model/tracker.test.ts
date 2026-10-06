import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTracker, isOffline } from './tracker.ts'
import type { TrackerGet } from './tracker.ts'

const NOW = '2026-10-06T12:00:00.000Z'
/** a get over fixed answers: concept/id → reply, an Error → a rejected get */
const over = (m: Record<string, unknown>): TrackerGet => async (c, id) => {
  const r = m[`${c}/${id}`]
  if (r instanceof Error) throw r
  return (r as { status: string }) ?? { status: 'source_error', message: `no ${c} ${id}` }
}
const ok = (items: unknown) => ({ status: 'ok', rev: 1, items })

test('cards carry the header, the text and the linked PR ids; PRs are the union, active first, newest first', async () => {
  const t = await buildTracker(['7', '8'], over({
    'work/7': ok({ type: 'Story', title: 'Seven', state: 'Active', assignedTo: 'Kim', area: 'A\\B', iteration: 'R8', link: 'https://t.example/7',
      description: 'd', reproSteps: '', acceptanceCriteria: 'ac', comments: [], prs: ['20', '21', '22'] }),
    'work/8': ok({ type: 'Bug', title: 'Eight', state: 'New', assignedTo: null, prs: ['21', '30'] }),
    'review/20': ok({ threads: [], pr: { title: 'old', status: 'abandoned', votes: [] } }),
    'review/21': ok({ threads: [], pr: { title: 'api', status: 'completed', closedAt: '2026-10-06T09:56:00Z', target: 'qa', votes: [{ reviewer: 'Imre', vote: 10 }], merge: 'succeeded', policies: null } }),
    'review/22': ok({ threads: [], pr: { title: 'ui', status: 'active', source: 'vh-ui', target: 'qa', draft: false, votes: [{ reviewer: 'Imre', vote: 0 }],
      merge: 'succeeded', policies: [{ name: 'Minimum number of reviewers', status: 'queued', blocking: true }] } }),
    'review/30': ok({ threads: [] }),
  }), NOW)
  assert.equal(t.supported, true)
  assert.equal(t.at, NOW)
  assert.deepEqual(t.items.map((c) => [c.id, c.title, c.prs]), [['7', 'Seven', ['20', '21', '22']], ['8', 'Eight', ['21', '30']]])
  assert.equal(t.items[0].area, 'A\\B')
  assert.equal(t.items[0].acceptanceCriteria, 'ac')
  assert.equal('comments' in t.items[0] ? 'present' : undefined, undefined, 'a card does not carry the comments')
  assert.deepEqual(t.prs.map((p) => [p.id, p.status ?? null, p.items]), [
    ['22', 'active', ['7']], ['30', null, ['8']], ['21', 'completed', ['7', '8']], ['20', 'abandoned', ['7']],
  ])
  assert.deepEqual(t.prs[0].policies, [{ name: 'Minimum number of reviewers', status: 'queued', blocking: true }])
  assert.equal(isOffline(t), false)
})

test('an older pack: no prs, no pr header, no area; the card shows what it has', async () => {
  const t = await buildTracker(['7'], over({ 'work/7': ok({ type: 'Story', title: 'Seven', state: 'Active', assignedTo: null }) }), NOW)
  assert.deepEqual(t.items[0].prs, [])
  assert.equal(t.items[0].area, undefined)
  assert.deepEqual(t.prs, [])
})

test('a PR id that is not a plain id is dropped; an item that fails is a card saying why, the rest still shows', async () => {
  const t = await buildTracker(['7', '9', '10'], over({
    'work/7': ok({ title: 'Seven', prs: ['5', '', 7, null] }),
    'work/9': { status: 'not_found', message: 'no work item 9' },
    'work/10': Object.assign(new Error('the gateway did not answer'), { code: 'unavailable' }),
    'review/5': { status: 'source_error', message: 'boom' },
  }), NOW)
  assert.deepEqual(t.items.map((c) => [c.id, c.err ?? null]), [['7', null], ['9', 'no work item 9'], ['10', 'the gateway did not answer']])
  assert.deepEqual(t.prs.map((p) => [p.id, p.err ?? null]), [['5', 'boom']])
  assert.equal(isOffline(t), false)
})

test('every item failing is offline; every work get unsupported, or no work item at all, is unsupported', async () => {
  const down = await buildTracker(['7', '8'], over({ 'work/7': new Error('down'), 'work/8': { status: 'unavailable', message: 'bridge is down' } }), NOW)
  assert.equal(down.supported, true)
  assert.equal(isOffline(down), true)
  const pg = await buildTracker(['7'], over({ 'work/7': { status: 'unsupported', message: 'no tracker' } }), NOW)
  assert.equal(pg.supported, false)
  assert.equal(isOffline(pg), false)
  const gone = await buildTracker(['7'], over({ 'work/7': { status: 'not_found', message: 'no work item 7' } }), NOW)
  assert.equal(isOffline(gone), false, 'a deleted item is not a down bridge')
  const none = await buildTracker([], over({}), NOW)
  assert.equal(none.supported, false)
})
