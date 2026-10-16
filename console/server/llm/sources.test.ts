import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourcesSection } from './sources.ts'
import type { PackView } from '../../src/model/packs.ts'

const v = (o: Partial<PackView>): PackView => ({
  name: 'talk', title: 'Talk', kind: 'browser', about: 'chats', listed: true, on: true, concepts: ['chat'], actions: ['talk.post'], scoped: true,
  scopes: [], acts: ['talk.post'], llmActs: [], state: 'ok', guide: '', ...o,
})

test('a pack that is on: title, kind, concepts, state, scopes by name, the acts runs may call, then its guide', () => {
  const s = sourcesSection([v({ scopes: [{ id: 't1', name: 'Brothers' }, { id: 't2' }], llmActs: ['talk.post'], guide: 'Read a chat with bridge_get {concept: "chat", id, pack: "talk"}.' })], true)
  assert.match(s, /^## Sources\n/)
  assert.match(s, /### Talk \(talk, browser tab\)/)
  assert.match(s, /Serves: chat · state: ok/)
  assert.match(s, /Scopes: Brothers \(t1\), t2/)
  assert.match(s, /Runs may call: talk\.post/)
  assert.match(s, /Read a chat with bridge_get/)
})

test('a scoped pack with no scopes says it serves nothing; a signed-out one names the host; an error its reason', () => {
  assert.match(sourcesSection([v({})], true), /No scopes ticked: it serves nothing until they are ticked in Settings → Packs\./)
  assert.match(sourcesSection([v({ scopes: [{ id: 't1' }], state: 'signin_required', host: 'talk.example' })], true), /state: signin_required \(sign in to talk\.example\)/)
  assert.match(sourcesSection([v({ state: 'error', message: 'a.post is served by b' })], true), /state: error: a\.post is served by b/)
})

test('the packs that are off are named in one line; nothing on and nothing listed is no section', () => {
  const s = sourcesSection([v({ scopes: [{ id: 't1' }] }), v({ name: 'mail', title: 'Mail', on: false, state: 'off' }), v({ name: 'hid', on: false, listed: false })], true)
  assert.match(s, /Off: Mail \(mail\)\. They are turned on in Settings → Packs; a step that needs one says so in a not_done draft\./)
  assert.doesNotMatch(s, /hid/)
  assert.equal(sourcesSection([], true), '')
})

test('an mcp pack that is on names its server; an empty about leaves no blank line', () => {
  const s = sourcesSection([v({ name: 'kb', title: 'KB', kind: 'mcp', about: '', scoped: false, mcp: 'https://kb.example/mcp' })], true)
  assert.match(s, /### KB \(kb, MCP server\)\nServer: https:\/\/kb\.example\/mcp\nServes: chat/)
  assert.doesNotMatch(s, /\n\n\n|\n\n(?=Serves)/)
})

test("an mcp pack that is on lists the tools runs may call and those the person has not ticked; an off one says it is an MCP server", () => {
  const tools = [{ name: 'list', act: false, on: true }, { name: 'run', act: true, on: true }, { name: 'sudo', act: true, on: false }]
  const s = sourcesSection([v({ name: 'ssh', title: 'SSH', kind: 'mcp', scoped: false, concepts: [], mcp: 'npx -y shell-mcp@1.0.0', tools }),
    v({ name: 'filesystem', title: 'Folders', kind: 'mcp', on: false, state: 'off' })], true)
  assert.match(s, /Tools: mcp__ssh__list; that change things: mcp__ssh__run\. Not given: sudo; ask with request_access \{runTools\} if a step needs one\./)
  assert.match(s, /Off: Folders \(filesystem, MCP server\)/)
})
