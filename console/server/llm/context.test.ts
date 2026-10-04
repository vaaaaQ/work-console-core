import '../testkit.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CtxItem } from '../../src/model/types.ts'
import type { ConceptReply } from '../bridge/wire.ts'
import { notesStore } from '../knowledge/notes.ts'
import { resolveItem } from './context.ts'

const mail: CtxItem = { k: 'mail', id: 'm-17', n: 1, name: 'Quota' }
const note: CtxItem = { k: 'note', id: 'tracker-rest', n: 1 }

test("a mail is read through the bridge's mail get; a note from the workspace's notes, never the bridge", async () => {
  const asked: string[] = []
  const b = { get: async (concept: string, id: string): Promise<ConceptReply> => { asked.push(`${concept}/${id}`); return { status: 'ok', rev: 1, items: { body: 'Quota is 5.', attachments: ['q.xlsx'] } } } }
  const notes = notesStore(join(mkdtempSync(join(tmpdir(), 'wc-ctx-')), 'kn'))
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
