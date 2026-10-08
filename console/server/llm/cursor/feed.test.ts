import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Feed } from './feed.ts'
import type { FeedEvent } from './feed.ts'

/** a recorded stream's session updates through a feed, then its last flush */
function replay(name: string, f: Feed): FeedEvent[] {
  const lines = readFileSync(join(import.meta.dirname, 'fixtures', `${name}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const out: FeedEvent[] = []
  for (const l of lines) if (l.dir === '<' && l.x.method === 'session/update') out.push(...f.update(l.x.params.update))
  return [...out, ...f.flush()]
}
const shape = (es: FeedEvent[]) => es.map((e) => (e.k === 'text' ? `text ${e.t.trim().split('\n')[0]}` : `tool ${e.name} ${JSON.stringify(e.input)}`))

test('a run\'s text comes one message per stretch between tool calls, and each tool once with its input', () => {
  const f = new Feed()
  assert.deepEqual(shape(replay('mcp', f)), [
    'text I\'ll call `probe_echo`, list available MCP servers/tools, and run the shell command.',
    'tool Shell {"command":"node -p \\"os.homedir()\\""}',
    'text Calling `probe_echo` next.',
    'tool mcp__run__probe_echo {"text":"hi"}',
    'text hi-5f3ad770',
  ])
  assert.match(f.last, /^hi-5f3ad770/)
})

test('a tool whose input comes in a later update waits for it; the own server\'s tools go by bare name, hidden ones not at all', () => {
  assert.deepEqual(shape(replay('hook', new Feed())).filter((s) => s.startsWith('tool')), ['tool Edit {"path":"<work>\\\\core.txt"}'])
  const a = new Feed('run', ['answer'])
  const es = replay('answer', a)
  assert.ok(!es.some((e) => e.k === 'tool' && e.name === 'answer'))
  assert.equal(new Feed('run').update({ sessionUpdate: 'tool_call_update', toolCallId: 'x', rawInput: { providerIdentifier: 'run', toolName: 'journal', args: { observed: 'o' } } })[0].k, 'tool')
})

test('a tool that completes without ever naming its input is still told, by its kind; what the feed keeps answers a permission request', () => {
  const f = new Feed()
  assert.deepEqual(f.update({ sessionUpdate: 'tool_call', toolCallId: 'a', title: 'Delete File', kind: 'delete', rawInput: {} }), [])
  assert.deepEqual(f.update({ sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'completed' }), [{ k: 'tool', name: 'Delete', input: {} }])
  assert.deepEqual(f.update({ sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'completed' }), [])
  f.update({ sessionUpdate: 'tool_call', toolCallId: 'b', title: 'MCP: tool', kind: 'other', rawInput: {} })
  f.update({ sessionUpdate: 'tool_call_update', toolCallId: 'b', rawInput: { providerIdentifier: 'bridge', toolName: 'bridge_get', args: {} } })
  assert.deepEqual(f.raw('b'), { providerIdentifier: 'bridge', toolName: 'bridge_get', args: {} })
})

test('thoughts, the user\'s own lines, titles and commands are not the agent\'s text', () => {
  const f = new Feed()
  for (const u of [{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } }, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi' } },
    { sessionUpdate: 'session_info_update', title: 'x' }, { sessionUpdate: 'available_commands_update', availableCommands: [] }, null, 'x']) assert.deepEqual(f.update(u), [])
  assert.deepEqual(f.flush(), [])
  assert.equal(f.last, '')
})
