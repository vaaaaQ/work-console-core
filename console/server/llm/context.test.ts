import '../testkit.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import type { CtxItem, Job } from '../../src/model/types.ts'
import { GatewayError } from '../bridge/wire.ts'
import type { ConceptReply } from '../bridge/wire.ts'
import { notesStore } from '../knowledge/notes.ts'
import { IMG_MAX, resolveContext, resolveItem } from './context.ts'
import { tempDir } from '../testdirs.ts'

const mail: CtxItem = { k: 'mail', id: 'm-17', n: 1, name: 'Quota' }
const note: CtxItem = { k: 'note', id: 'tracker-rest', n: 1 }

test("a mail is read through the bridge's mail get; a note from the workspace's notes, never the bridge", async () => {
  const asked: string[] = []
  const b = { get: async (concept: string, id: string): Promise<ConceptReply> => { asked.push(`${concept}/${id}`); return { status: 'ok', rev: 1, items: { body: 'Quota is 5.', attachments: ['q.xlsx'] } } } }
  const notes = notesStore(join(tempDir('ctx'), 'kn'))
  await notes.save(null, { title: 'Tracker REST', tags: [], playbooks: [], text: 'Use a token header.' }, null)
  const m = await resolveItem(b, mail, undefined, notes)
  assert.deepEqual([m.status, m.text], ['ok', 'Quota is 5.\n\nAttachments: q.xlsx'])
  const n = await resolveItem(b, note, undefined, notes)
  assert.deepEqual([n.status, n.text], ['ok', 'Use a token header.'])
  assert.deepEqual(asked, ['mail/m-17'])
  const gone = await resolveItem(b, { ...note, id: 'nope' }, undefined, notes)
  assert.equal(gone.status, 'not_found'); assert.match(gone.text, /does not exist/)
  const none = await resolveItem(b, note)
  assert.deepEqual([none.status, none.text], ['unavailable', 'this workspace has no notes'])
})

const job = (ctx: CtxItem[]) => ({ ws: 'acme', key: 'X', ctx }) as unknown as Job
const png = (data: string): ConceptReply => ({ status: 'ok', rev: 1, items: { name: 'x.png', mime: 'image/png', data, width: 1, height: 1 } })
const listed = (refs: string[], from = 'description') => refs.map((ref) => ({ ref, name: `${ref}.png`, from }))
/** a bridge with these work items and these pictures by ref; asked keeps every get */
function bridge(work: Record<string, object>, pics: Record<string, () => ConceptReply>, asked: string[] = []) {
  return {
    asked,
    get: async (concept: string, id: string): Promise<ConceptReply> => {
      asked.push(`${concept}/${id}`)
      if (concept === 'image') return pics[id] ? pics[id]() : { status: 'not_found', message: `no image ${id}` }
      if (concept === 'chat') return { status: 'ok', rev: 1, items: { messages: [{ author: 'Bo', at: '2026-09-30T10:00:00Z', text: 'look at [image 1]' }] } }
      return { status: 'ok', rev: 1, items: work[id] }
    },
  }
}

test("a work item's pictures come with the run, numbered across the prompt as its text names them; one that cannot be read says so", async () => {
  const b = bridge({
    'W-1': { description: 'See [image 2] and [image 1].', acceptanceCriteria: 'Like [image 1] again.',
      comments: [{ author: 'Ann', at: '2026-09-30T09:00:00Z', text: 'Broken: [image 3]' }],
      images: [...listed(['a1', 'a2'], 'description'), ...listed(['a3'], 'comment:7')] },
    'W-2': { description: 'Old: [image 9].', reproSteps: 'One [image 1]. Two [image 2]. Three [image 3]. Four [image 4].', comments: [],
      images: listed(['b1', 'b2', 'b3', 'b4'], 'reproSteps') },
  }, {
    a1: () => png('A1'), a2: () => png('A2'), a3: () => png('A3'), b1: () => png('B1'),
    b2: () => { throw new GatewayError(504, 'timeout', 'slow') },
    b3: () => ({ status: 'ok', rev: 1, items: { name: 'b3.bmp', mime: 'image/bmp', data: 'B3', width: 1, height: 1 } }),
  })
  const r = await resolveContext(b, job([{ k: 'work', id: 'W-1', n: 10, name: 'Limiter' }, { k: 'chat', id: 'c1', n: 10, name: 'Sam' }, { k: 'work', id: 'W-2', n: 10, name: 'Search' }]))
  const [w1, chat, w2] = r.ctx
  assert.match(w1.text, /Description:\nSee \[image 1\] and \[image 2\]\.\n/)
  assert.match(w1.text, /Acceptance criteria:\nLike \[image 2\] again\.\n/)
  assert.match(w1.text, /Ann: Broken: \[image 3\]$/)
  assert.equal(chat.text, '- 2026-09-30 10:00Z Bo: look at [image 1]', 'only work items name pictures')
  assert.match(w2.text, /Description:\nOld: \[image: unavailable\]\.\n/)
  assert.match(w2.text, /One \[image 4\]\. Two \[image 5: unavailable\]\. Three \[image 6: unavailable\]\. Four \[image 7: unavailable\]\./)
  assert.deepEqual(r.images, [
    { label: '[image 1] Limiter, description: a2.png', mime: 'image/png', data: 'A2' },
    { label: '[image 2] Limiter, description: a1.png', mime: 'image/png', data: 'A1' },
    { label: '[image 3] Limiter, comment 7: a3.png', mime: 'image/png', data: 'A3' },
    { label: '[image 4] Search, repro steps: b1.png', mime: 'image/png', data: 'B1' },
  ])
  assert.deepEqual(b.asked.filter((a) => a.startsWith('image/')).sort(), ['image/a1', 'image/a2', 'image/a3', 'image/b1', 'image/b2', 'image/b3', 'image/b4'])
})

test(`at most ${IMG_MAX} pictures a run, in the pack's order: the first items' first; the rest say unavailable and are never read`, async () => {
  const many = Array.from({ length: 25 }, (_, i) => `a${i + 1}`)
  const pics = Object.fromEntries([...many, 'b1'].map((ref) => [ref, () => png(ref.toUpperCase())]))
  const b = bridge({
    'W-1': { description: many.map((_, i) => `[image ${25 - i}]`).join(' '), comments: [], images: listed(many) },
    'W-2': { description: 'Also [image 1].', comments: [], images: listed(['b1']) },
  }, pics)
  const r = await resolveContext(b, job([{ k: 'work', id: 'W-1', n: 10, name: 'One' }, { k: 'work', id: 'W-2', n: 10, name: 'Two' }]))
  assert.equal(r.images.length, IMG_MAX)
  assert.deepEqual(b.asked.filter((a) => a.startsWith('image/')).sort(), many.slice(0, 20).map((a) => `image/${a}`).sort(), 'the pack lists the first pictures first')
  assert.deepEqual([r.images[0].label, r.images[19].label], ['[image 6] One, description: a20.png', '[image 25] One, description: a1.png'])
  assert.match(r.ctx[0].text, /^\[image 1: unavailable\] \[image 2: unavailable\] \[image 3: unavailable\] \[image 4: unavailable\] \[image 5: unavailable\] \[image 6\] \[image 7\] /m)
  assert.match(r.ctx[1].text, /Also \[image 26: unavailable\]\./)
})

test('a comment the run does not get brings no picture; a malformed listed picture is unavailable, one without a name or a place is labelled with what it has', async () => {
  const b = bridge({
    'W-1': { description: '[image 1] [image 2] [image 3]', images: [null, { ref: '', name: 'empty.png' }, { ref: 'x3' }, ...listed(['x4'], 'comment:2')],
      comments: [{ author: 'Ann', at: '2026-09-01T09:00:00Z', text: 'old [image 4]' }, { author: 'Ann', at: '2026-09-02T09:00:00Z', text: 'new' }] },
  }, { x3: () => png('X3'), x4: () => png('X4') })
  const r = await resolveContext(b, job([{ k: 'work', id: 'W-1', n: 1, name: 'Old' }]))
  assert.match(r.ctx[0].text, /Description:\n\[image: unavailable\] \[image: unavailable\] \[image 1\]\n/)
  assert.doesNotMatch(r.ctx[0].text, /old \[image/)
  assert.deepEqual(r.images, [{ label: '[image 1] Old', mime: 'image/png', data: 'X3' }])
  assert.deepEqual(b.asked, ['work/W-1', 'image/x3'])
})
