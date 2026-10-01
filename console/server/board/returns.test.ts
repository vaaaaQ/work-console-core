import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as T from '../../src/model/transitions.ts'
import type { Job } from '../../src/model/types.ts'
import { Bus } from '../events.ts'
import { Jobs } from '../jobs/jobs.ts'
import { fileStore } from '../store/file.ts'
import { demoCtx, demoSeed } from '../testkit.ts'
import { BoardReturns } from './returns.ts'

type Col = { id: string; column: string | null }

function setup(first: Col[]) {
  const store = fileStore(join(mkdtempSync(join(tmpdir(), 'wc-ret-')), 's.json'), demoSeed)
  const bus = new Bus(), jobs = new Jobs({ store, bus, ctx: demoCtx, gate: () => true })
  const pushes: { title: string; body: string; url: string }[] = [], generic: string[] = []
  let board = first
  const r = new BoardReturns({ bus, jobs, ctx: demoCtx, read: async () => board, push: async (title, body, url) => { pushes.push({ title, body, url }) } })
  jobs.onNeedsYou((j) => { if (!r.handling(j.id)) generic.push(j.id) })
  return { bus, jobs, r, pushes, generic, setBoard: (b: Col[]) => { board = b } }
}
async function until(f: () => boolean, ms = 2000) {
  const t0 = Date.now()
  while (!f()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 5)) }
}
const openNotes = (j: Job) => Object.values(j.flow).flatMap((f) => f.b).filter((b) => b.o)

test('QA → Dev on a done job: reopened, a problem note makes it need the user, one push', async () => {
  const s = setup([{ id: 'ACME-480', column: 'QA' }, { id: 'ACME-512', column: 'Code Review' }])
  s.bus.emit({ kind: 'bridge', state: 'ok', concepts: {} })
  await new Promise((r) => setTimeout(r, 20))
  s.bus.emit({ kind: 'source', concept: 'board', upserts: [{ id: 'ACME-480', column: 'Dev' }], removes: [] })
  await until(() => s.pushes.length > 0)
  const j = (await s.jobs.get('J-0398'))!
  assert.equal(T.isClosed(j), false)
  assert.ok(T.needsYou(demoCtx(), j))
  const notes = openNotes(j)
  assert.equal(notes.length, 1)
  assert.equal(notes[0].k, 'p'); assert.equal(notes[0].t, 'QA returned ACME-480 to Dev; return the job to a step.')
  assert.match(j.jr[0].a, /console/)
  assert.deepEqual(s.pushes, [{ title: 'J-0398: QA returned it to Dev', body: j.t, url: '/?job=J-0398' }])
  assert.deepEqual(s.generic, [], 'the reopen does not push a second time')
  // the same column again, by delta or by re-read, is not a second return
  await s.r.see([{ id: 'ACME-480', column: 'Dev' }])
  s.setBoard([{ id: 'ACME-480', column: 'Dev' }])
  await s.r.reload()
  assert.equal(s.pushes.length, 1)
})

test('QA → Dev on an open job: a note on its current step; other moves and job-less items are ignored', async () => {
  const s = setup([])
  await s.r.see([{ id: 'ACME-530', column: 'QA' }, { id: 'ACME-512', column: 'Code Review' }, { id: 'ACME-603', column: 'QA' }])
  const before = (await s.jobs.get('J-0418'))!, at = T.atOf(demoCtx(), before)!, v0 = (await s.jobs.get('J-0412'))!.v
  await s.r.see([{ id: 'ACME-530', column: 'Dev' }, { id: 'ACME-512', column: 'Dev' }, { id: 'ACME-603', column: 'Dev' }])
  const j = (await s.jobs.get('J-0418'))!
  assert.equal(j.flow[at].b.at(-1)!.t, 'QA returned ACME-530 to Dev; return the job to a step.')
  assert.equal(j.flow[at].b.at(-1)!.o, 1)
  assert.deepEqual(s.pushes.map((p) => p.title), ['J-0418: QA returned it to Dev'])
  assert.equal((await s.jobs.get('J-0412'))!.v, v0, 'Code Review to Dev is not a QA return')
})

test('the first read only remembers: an item already in Dev is not a return', async () => {
  const s = setup([{ id: 'ACME-480', column: 'Dev' }])
  await s.r.reload()
  s.bus.emit({ kind: 'source', concept: 'board', upserts: [{ id: 'ACME-480', column: 'Dev' }], removes: [] })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(s.pushes.length, 0)
})
