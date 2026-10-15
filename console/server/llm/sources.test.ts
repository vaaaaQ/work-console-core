import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourcesSection } from './sources.ts'
import type { PackView } from '../../src/model/packs.ts'

const v = (o: Partial<PackView>): PackView => ({
  name: 'talk', title: 'Talk', kind: 'browser', about: 'chats', listed: true, on: true, concepts: ['chat'], actions: ['talk.post'], scoped: true,
  scopes: [], acts: ['talk.post'], llmActs: [], state: 'ok', guide: '', ...o,
})

test('a pack that is on: title, kind, concepts, state, scopes by name, the acts runs may call, then its guide', () => {
  const s = sourcesSection([v({ scopes: [{ id: 't1', name: 'Brothers' }, { id: 't2' }], llmActs: ['talk.post'], guide: 'Read a chat with bridge_get {concept: "chat", id, pack: "talk"}.' })])
  assert.match(s, /^## Sources\n/)
  assert.match(s, /### Talk \(talk, browser tab\)/)
  assert.match(s, /Serves: chat · state: ok/)
  assert.match(s, /Scopes: Brothers \(t1\), t2/)
  assert.match(s, /Runs may call: talk\.post/)
  assert.match(s, /Read a chat with bridge_get/)
})

test('a scoped pack with no scopes says it serves nothing; a signed-out one names the host; an error its reason', () => {
  assert.match(sourcesSection([v({})]), /No scopes ticked: it serves nothing until they are ticked in Settings → Packs\./)
  assert.match(sourcesSection([v({ scopes: [{ id: 't1' }], state: 'signin_required', host: 'talk.example' })]), /state: signin_required \(sign in to talk\.example\)/)
  assert.match(sourcesSection([v({ state: 'error', message: 'a.post is served by b' })]), /state: error: a\.post is served by b/)
})

test('the packs that are off are named in one line; nothing on and nothing listed is no section', () => {
  const s = sourcesSection([v({ scopes: [{ id: 't1' }] }), v({ name: 'mail', title: 'Mail', on: false, state: 'off' }), v({ name: 'hid', on: false, listed: false })])
  assert.match(s, /Off: Mail \(mail\)\. They are turned on in Settings → Packs; a step that needs one says so in a not_done draft\./)
  assert.doesNotMatch(s, /hid/)
  assert.equal(sourcesSection([]), '')
})

test('an mcp pack that is on names its server; an empty about leaves no blank line', () => {
  const s = sourcesSection([v({ name: 'kb', title: 'KB', kind: 'mcp', about: '', scoped: false, mcp: 'https://kb.example/mcp' })])
  assert.match(s, /### KB \(kb, MCP server\)\nServer: https:\/\/kb\.example\/mcp\nServes: chat/)
  assert.doesNotMatch(s, /\n\n\n|\n\n(?=Serves)/)
})
