import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HttpError } from '../events.ts'
import { noteIn, notesStore, parseNote } from './notes.ts'

function setup() {
  const dir = join(mkdtempSync(join(tmpdir(), 'wc-notes-')), 'kn')
  const changes: [string, unknown[], string[]][] = []
  let t = 0
  const now = () => new Date(Date.UTC(2026, 9, 4, 12, 0, t++)).toISOString()
  return { dir, changes, kn: notesStore(dir, { now, onChange: (c, u, r) => changes.push([c, u, r]) }) }
}
const code = (status: number, c?: string) => (e: unknown) => e instanceof HttpError && e.status === status && (!c || e.code === c)

test('a new note is a Markdown file with JSON front matter, read back as written', async () => {
  const { dir, kn } = setup()
  const n = await kn.save(null, { title: 'Where the CLIs live', tags: ['machine'], playbooks: ['dev-item'], text: 'sqlcmd is on PATH\n\n---\n\ngit is the VS one\n' }, null)
  assert.equal(n.id, 'where-the-clis-live'); assert.equal(n.v, 1)
  assert.equal(readFileSync(join(dir, 'where-the-clis-live.md'), 'utf8'), [
    '---', 'title: "Where the CLIs live"', 'tags: ["machine"]', 'playbooks: ["dev-item"]', 'v: 1', 'updated: "2026-10-04T12:00:00.000Z"', '---',
    'sqlcmd is on PATH\n\n---\n\ngit is the VS one\n'].join('\n'))
  assert.deepEqual(await kn.read(n.id), n)
  await kn.save(null, { title: 'Access rules', tags: [], playbooks: [], text: 'ask first' }, null)
  assert.deepEqual((await kn.list()).map((x) => [x.id, x.size]), [['access-rules', 9], ['where-the-clis-live', 42]])
})

test('an edit names the v it replaces; an old v, a taken title or a missing note is refused', async () => {
  const { kn } = setup()
  const n = await kn.save(null, { title: 'VPN', tags: [], playbooks: [], text: 'a' }, null)
  const e = await kn.save(n.id, { title: 'VPN', tags: ['net'], playbooks: [], text: 'b' }, 1)
  assert.equal(e.v, 2); assert.equal((await kn.read('vpn')).text, 'b')
  await assert.rejects(kn.save(n.id, { title: 'VPN', tags: [], playbooks: [], text: 'c' }, 1), code(409, 'conflict'))
  await assert.rejects(kn.save(null, { title: 'vpn', tags: [], playbooks: [], text: 'd' }, null), code(409, 'conflict'))
  await assert.rejects(kn.read('no-such-note'), code(404, 'not_found'))
  assert.equal((await kn.read('vpn')).text, 'b')
})

test('delete names its v too', async () => {
  const { dir, kn, changes } = setup()
  const n = await kn.save(null, { title: 'Old', tags: [], playbooks: [], text: 'x' }, null)
  await assert.rejects(kn.remove(n.id, 7), code(409, 'conflict'))
  await kn.remove(n.id, 1)
  assert.equal(existsSync(join(dir, 'old.md')), false)
  await assert.rejects(kn.remove(n.id, 1), code(404, 'not_found'))
  assert.deepEqual(changes.map(([c, u, r]) => [c, u.length, r]), [['notes', 1, []], ['notes', 0, ['old']]])
})

test('an id that could leave the folder is refused before any file is touched', async () => {
  const { kn } = setup()
  for (const id of ['..\\x', '../x', 'a/b', '.hidden', '', 'a.b'])
    for (const call of [() => kn.read(id), () => kn.save(id, { title: 't', tags: [], playbooks: [], text: 'x' }, null), () => kn.remove(id, 1)])
      await assert.rejects(call, code(400, 'bad_id'))
  await assert.rejects(kn.propose({ note: '../x', title: 't', text: 'x', reason: 'r', by: 'llm' }), code(400, 'bad_id'))
  await assert.rejects(kn.decide('../P-0001', true), code(400, 'bad_id'))
})

test('a text over 64 KB is too large', async () => {
  const { kn } = setup()
  await assert.rejects(kn.save(null, { title: 'Big', tags: [], playbooks: [], text: 'x'.repeat(64 * 1024 + 1) }, null), code(413, 'too_large'))
  await assert.rejects(kn.propose({ title: 'Big', text: 'x'.repeat(64 * 1024 + 1), reason: 'r', by: 'llm' }), code(413, 'too_large'))
})

test('search ranks title over tags over text, filters by tag and shows a snippet', async () => {
  const { kn } = setup()
  await kn.save(null, { title: 'Stand stuff', tags: [], playbooks: [], text: 'nothing here' }, null)
  await kn.save(null, { title: 'Other', tags: ['stand'], playbooks: [], text: 'nothing here' }, null)
  await kn.save(null, { title: 'Third', tags: ['ops'], playbooks: [], text: `${'filler '.repeat(30)}the local stand needs a cert` }, null)
  assert.deepEqual((await kn.search('stand')).map((h) => [h.id, h.score]), [['stand-stuff', 3], ['other', 2], ['third', 1]])
  const hit = (await kn.search('cert'))[0]
  assert.ok(hit.snippet.includes('the local stand needs a cert'))
  assert.ok(hit.snippet.length <= 160)
  assert.deepEqual((await kn.search('', ['OPS'])).map((h) => h.id), ['third'])
  assert.deepEqual(await kn.search('nothing-like-it'), [])
  assert.equal((await kn.search('')).length, 3)
})

test('a note written by hand: no front matter, a BOM, CRLF, YAML-ish values', async () => {
  const { dir, kn } = setup()
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'plain.md'), '﻿# Plain heading\r\nbody\r\n')
  writeFileSync(join(dir, 'yamlish.md'), '---\r\ntitle: Hand made\r\ntags: [a, "b"]\r\nv: 4\r\n---\r\ntext\r\n')
  writeFileSync(join(dir, 'skip.me.md'), 'not a note id')
  writeFileSync(join(dir, 'notes.txt'), 'not markdown')
  const l = await kn.list()
  assert.deepEqual(l.map((x) => [x.id, x.title, x.v, x.tags]), [['yamlish', 'Hand made', 4, ['a', 'b']], ['plain', 'Plain heading', 1, []]])
  assert.equal((await kn.read('plain')).text, '# Plain heading\nbody\n')
  const e = await kn.save('yamlish', { title: 'Hand made', tags: ['a'], playbooks: [], text: 'new' }, 4)
  assert.equal(e.v, 5)
})

test('notes attached to a playbook come back in full', async () => {
  const { kn } = setup()
  await kn.save(null, { title: 'B', tags: [], playbooks: ['dev-item', 'other'], text: 'bee' }, null)
  await kn.save(null, { title: 'A', tags: [], playbooks: ['dev-item'], text: 'ay' }, null)
  await kn.save(null, { title: 'C', tags: [], playbooks: [], text: 'sea' }, null)
  assert.deepEqual((await kn.forPlaybook('dev-item')).map((n) => [n.id, n.text]), [['a', 'ay'], ['b', 'bee']])
  assert.deepEqual(await kn.forPlaybook('none'), [])
})

test('a proposal waits as a file; accepting writes the note, rejecting drops it', async () => {
  const { dir, kn, changes } = setup()
  const p = await kn.propose({ title: 'Sleeping tabs', tags: ['edge'], text: 'freeze fetch', reason: 'seen twice', by: 'run J-0001/s2' })
  assert.equal(p.id, 'P-0001')
  assert.ok(existsSync(join(dir, '.proposals', 'P-0001.json')))
  assert.deepEqual((await kn.proposals()).map((x) => [x.id, x.by, x.reason, x.playbooks]), [['P-0001', 'run J-0001/s2', 'seen twice', []]])
  const n = await kn.decide(p.id, true, 'Sleeping tabs freeze fetch; set the lifecycle state active first')
  assert.equal(n?.id, 'sleeping-tabs'); assert.equal(n?.text, 'Sleeping tabs freeze fetch; set the lifecycle state active first')
  assert.deepEqual(await kn.proposals(), [])
  const q = await kn.propose({ title: 'Sleeping tabs', text: 'second note, same title', reason: 'guess', by: 'llm' })
  assert.equal(q.id, 'P-0002')
  assert.equal((await kn.decide(q.id, true))?.id, 'sleeping-tabs-2')
  const r = await kn.propose({ title: 'Wrong', text: 'x', reason: 'guess', by: 'llm' })
  assert.equal(r.id, 'P-0003')
  assert.equal(await kn.decide(r.id, false), null)
  assert.deepEqual(readdirSync(join(dir, '.proposals')).filter((f) => f.endsWith('.json')), [])
  await assert.rejects(kn.decide(r.id, true), code(404, 'not_found'))
  assert.deepEqual(changes.filter(([c]) => c === 'proposals').map(([, u, r]) => [u.length, r]), [[1, []], [0, ['P-0001']], [1, []], [0, ['P-0002']], [1, []], [0, ['P-0003']]])
})

test('a change keeps the note\'s tags and playbooks unless it names its own', async () => {
  const { kn } = setup()
  const n = await kn.save(null, { title: 'Stand-up', tags: ['meet'], playbooks: ['dev-item'], text: '09:30' }, null)
  const p = await kn.propose({ note: n.id, title: 'Stand-up', text: '09:30, Zoom', reason: 'more precise', by: 'session' })
  assert.deepEqual([p.note, p.baseV, p.tags, p.playbooks], ['stand-up', 1, ['meet'], ['dev-item']])
  const s = await kn.decide(p.id, true)
  assert.deepEqual([s?.id, s?.v, s?.text, s?.playbooks], ['stand-up', 2, '09:30, Zoom', ['dev-item']])
})

test('a change proposed against an old v cannot be accepted and stays for a decision', async () => {
  const { kn } = setup()
  const n = await kn.save(null, { title: 'Stand-up', tags: [], playbooks: [], text: '09:30' }, null)
  const p = await kn.propose({ note: n.id, title: 'Stand-up', text: '09:30, Zoom', reason: 'more precise', by: 'llm' })
  await kn.save(n.id, { title: 'Stand-up', tags: [], playbooks: [], text: 'moved' }, 1)
  await assert.rejects(kn.decide(p.id, true), code(409, 'conflict'))
  assert.deepEqual((await kn.proposals()).map((x) => x.id), [p.id])
  assert.equal((await kn.read(n.id)).text, 'moved')
  await assert.rejects(kn.propose({ note: 'gone', title: 't', text: 'x', reason: 'r', by: 'llm' }), code(404, 'not_found'))
  await assert.rejects(kn.propose({ title: ' ', text: 'x', reason: 'r', by: 'llm' }), code(400, 'bad_args'))
})

test('proposal ids never repeat, even after every proposal was decided', async () => {
  const { dir, kn } = setup()
  const a = await kn.propose({ title: 'A', text: 'x', reason: 'r', by: 'llm' })
  await kn.decide(a.id, false)
  assert.equal((await kn.propose({ title: 'B', text: 'x', reason: 'r', by: 'llm' })).id, 'P-0002')
  assert.equal((await notesStore(dir).propose({ title: 'C', text: 'x', reason: 'r', by: 'llm' })).id, 'P-0003')
})

test('an empty or missing folder is no notes and no proposals', async () => {
  const { kn } = setup()
  assert.deepEqual(await kn.list(), [])
  assert.deepEqual(await kn.proposals(), [])
  assert.deepEqual(await kn.search('x'), [])
})

test('parallel saves of one note: one wins, the other is a conflict', async () => {
  const { kn } = setup()
  const n = await kn.save(null, { title: 'Race', tags: [], playbooks: [], text: '0' }, null)
  const r = await Promise.allSettled([1, 2].map((i) => kn.save(n.id, { title: 'Race', tags: [], playbooks: [], text: String(i) }, 1)))
  assert.deepEqual(r.map((x) => x.status).sort(), ['fulfilled', 'rejected'])
})

test('parseNote reads front matter only at the very top', () => {
  const n = parseNote('x', 'text first\n---\ntitle: "Not it"\n---\n', '2026-01-01T00:00:00.000Z')
  assert.equal(n.title, 'x'); assert.equal(n.updated, '2026-01-01T00:00:00.000Z')
})

test('noteIn wants a title and a text and keeps only string tags and playbooks', () => {
  assert.deepEqual(noteIn({ title: ' T ', tags: ['a', 3, ' b ', ''], playbooks: ['p', null], text: 'x' }), { title: 'T', tags: ['a', 'b'], playbooks: ['p'], text: 'x' })
  assert.deepEqual(noteIn({ title: 'T', text: '' }), { title: 'T', tags: [], playbooks: [], text: '' })
  assert.throws(() => noteIn({ title: '', text: 'x' }), code(400))
  assert.throws(() => noteIn({ title: 'T' }), code(400))
})
