import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { sep } from 'node:path'
import { ALLOW, DENY, askOptions, exeOption, mcpServers, permissions, runToolDefs, userMessage } from './sdk.ts'
import type { RunTools } from './sdk.ts'

test("a session loads no user or local settings, and may use only its own tools, A's reads and runTools", () => {
  const p = permissions(['mcp__my-tools', 'Bash(npm test)'])
  assert.deepEqual(p.settingSources, ['project'], "the user's shell allow rules must not reach a session")
  assert.equal(p.permissionMode, 'dontAsk')
  assert.deepEqual(p.allowedTools, [...ALLOW, 'mcp__my-tools', 'Bash(npm test)'])
  assert.ok(!p.allowedTools.includes('mcp__bridge__bridge_act'))
  for (const k of ['mcp__run__knowledge_search', 'mcp__run__knowledge_read', 'mcp__run__knowledge_propose']) assert.ok(p.allowedTools.includes(k), k)
  assert.ok(!p.allowedTools.some((t) => t.startsWith('mcp__bridge__knowledge')), 'knowledge is the console\'s, not the bridge\'s')
  for (const d of ['mcp__bridge__bridge_act', 'Read(~/.bridge/**)', 'Read(~/.work-console/**)']) assert.ok(p.disallowedTools.includes(d), d)
})

test("a session never reads the user's own CLAUDE.md, which a work dir under the home folder would reach as a parent's", () => {
  const h = homedir().split(sep).join('/')
  assert.deepEqual(permissions([]).settings.claudeMdExcludes, [`${h}/.claude/CLAUDE.md`, `${h}/.claude/rules/**`])
})

test("a session's MCP servers: A's bridge with the LLM token, its run tools, and the workspace's own", () => {
  const run = { type: 'sdk' } as never, tracker = { type: 'http', url: 'http://127.0.0.1:1/mcp' }
  const s = mcpServers({ gatewayUrl: 'http://127.0.0.1:47821/', llmToken: () => 'llm-tok', mcp: { tracker } }, run)
  assert.deepEqual(Object.keys(s), ['bridge', 'run', 'tracker'])
  assert.deepEqual(s.bridge, { type: 'http', url: 'http://127.0.0.1:47821/mcp', headers: { Authorization: 'Bearer llm-tok' } })
  assert.equal(s.run, run); assert.equal(s.tracker, tracker)
  assert.deepEqual(Object.keys(mcpServers({ gatewayUrl: 'http://g', llmToken: () => '' }, run)), ['bridge', 'run'])
})

test("a session gets no user-scope MCP servers and never the console's own job tools", () => {
  const p = permissions([])
  assert.equal(p.strictMcpConfig, true)
  for (const d of ['mcp__work-console', 'Bash(*mcp.token*)', 'PowerShell(*mcp.token*)']) assert.ok(p.disallowedTools.includes(d), d)
})

test('a workspace without a gateway: no bridge server, no bridge tools, and the deny list still holds', () => {
  const run = { type: 'sdk' } as never, tracker = { type: 'http', url: 'http://127.0.0.1:1/mcp' }
  let read = false
  const s = mcpServers({ gatewayUrl: 'http://g', llmToken: () => { read = true; return '' }, mcp: { tracker }, bridge: false }, run)
  assert.deepEqual(Object.keys(s), ['run', 'tracker'])
  assert.equal(read, false, 'no LLM token is read without a bridge')
  const p = permissions(['Edit'], false)
  assert.ok(!p.allowedTools.some((t) => t.startsWith('mcp__bridge__')), p.allowedTools.join(', '))
  for (const t of ['mcp__run__submit_draft', 'mcp__run__journal', 'Edit']) assert.ok(p.allowedTools.includes(t), t)
  assert.deepEqual(p.disallowedTools, permissions([]).disallowedTools)
})

test('the run server has its own four tools, and screenshot only when the run carries it', () => {
  const none = async () => {}
  const base: RunTools = { submitDraft: none, addArtifact: none, addArtifactFile: none, journal: none }
  assert.deepEqual(runToolDefs(base).map((d) => d.name), ['submit_draft', 'add_artifact', 'add_artifact_file', 'journal'])
  assert.deepEqual(runToolDefs({ ...base, screenshot: none }).map((d) => d.name).at(-1), 'screenshot')
  for (const d of runToolDefs({ ...base, screenshot: none })) assert.ok(ALLOW.includes(`mcp__run__${d.name}`), d.name)
})

test('context only when the run carries it; it answers with each picture after its label, then the text', async () => {
  const none = async () => {}
  const base: RunTools = { submitDraft: none, addArtifact: none, addArtifactFile: none, journal: none }
  assert.ok(!runToolDefs(base).some((d) => d.name === 'context'))
  const call = async (context: RunTools['context']) => {
    const d = runToolDefs({ ...base, context }).find((d) => d.name === 'context')!
    assert.ok(ALLOW.includes(`mcp__run__${d.name}`))
    return (d.handler as (a: unknown, x: unknown) => Promise<{ content: unknown; isError?: boolean }>)({}, {})
  }
  assert.deepEqual((await call(async () => ({ text: '## Job J-1: x', images: [] }))).content, [{ type: 'text', text: '## Job J-1: x' }])
  const pic = { label: '[image 1] ACME-1, description: a.png', mime: 'image/png', data: 'UE5H' }
  assert.deepEqual((await call(async () => ({ text: 'T', images: [pic] }))).content,
    [{ type: 'text', text: pic.label }, { type: 'image', data: 'UE5H', mimeType: 'image/png' }, { type: 'text', text: 'T' }])
  const bad = await call(async () => { throw new Error('the job is gone') })
  assert.deepEqual([bad.content, bad.isError], [[{ type: 'text', text: 'failed: the job is gone' }], true])
})

test("a first prompt with pictures is one user message: each picture after its label, the prompt's text last", () => {
  assert.deepEqual(userMessage('the prompt', [{ label: '[image 1] W, description: a.png', mime: 'image/png', data: 'UE5H' }]), {
    type: 'user', parent_tool_use_id: null,
    message: { role: 'user', content: [
      { type: 'text', text: '[image 1] W, description: a.png' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'UE5H' } },
      { type: 'text', text: 'the prompt' },
    ] },
  })
})

test('create_job and start_job only when the run carries them; create_job answers with the new id', async () => {
  const none = async () => {}
  const base: RunTools = { submitDraft: none, addArtifact: none, addArtifactFile: none, journal: none }
  assert.ok(!runToolDefs(base).some((d) => d.name === 'create_job' || d.name === 'start_job'))
  const defs = runToolDefs({ ...base, createJob: async () => 'AD-0009', startJob: none })
  assert.deepEqual(defs.map((d) => d.name).slice(-2), ['create_job', 'start_job'])
  for (const d of defs) assert.ok(ALLOW.includes(`mcp__run__${d.name}`), d.name)
  const create = defs.find((d) => d.name === 'create_job')!.handler as (a: unknown, x: unknown) => Promise<{ content: unknown }>
  const r = await create({ title: 'x' }, {})
  assert.deepEqual(r.content, [{ type: 'text', text: 'created AD-0009' }])
})

test("the knowledge tools only when the run carries them: search lists, read gives the note, a proposal answers with its id", async () => {
  const none = async () => {}
  const base: RunTools = { submitDraft: none, addArtifact: none, addArtifactFile: none, journal: none }
  assert.ok(!runToolDefs(base).some((d) => d.name.startsWith('knowledge_')))
  const asked: unknown[] = []
  const defs = runToolDefs({
    ...base,
    knowledgeSearch: async (q, tags) => { asked.push([q, tags]); return [{ id: 'ado-rest', v: 2, title: 'ADO REST', tags: ['ado'], playbooks: [], updated: '', size: 9, score: 3, snippet: 'use a PAT' }] },
    knowledgeRead: async (id) => ({ id, v: 2, title: 'ADO REST', tags: ['ado'], playbooks: ['dev-item'], text: 'use a PAT', updated: '' }),
    knowledgePropose: async (p) => { asked.push(p); return 'P-0004' },
  })
  assert.deepEqual(defs.map((d) => d.name).slice(-3), ['knowledge_search', 'knowledge_read', 'knowledge_propose'])
  for (const d of defs) assert.ok(ALLOW.includes(`mcp__run__${d.name}`), d.name)
  const call = (n: string, a: unknown) => (defs.find((d) => d.name === n)!.handler as (a: unknown, x: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>)(a, {})
  assert.equal((await call('knowledge_search', { q: 'pat' })).content[0].text, '- ado-rest: ADO REST (tags ado) use a PAT')
  assert.equal((await call('knowledge_read', { id: 'ado-rest' })).content[0].text, '# ADO REST\nid ado-rest · v2 · tags ado · playbooks dev-item\n\nuse a PAT')
  assert.match((await call('knowledge_propose', { title: 't', text: 'x', reason: 'r' })).content[0].text, /^proposed P-0004/)
  assert.deepEqual(asked, [['pat', undefined], { title: 't', text: 'x', reason: 'r' }])
  const bad = runToolDefs({ ...base, knowledgeRead: async () => { throw new Error("note 'x' does not exist") } }).find((d) => d.name === 'knowledge_read')!
  const r = await (bad.handler as (a: unknown, x: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>)({ id: 'x' }, {})
  assert.equal(r.isError, true); assert.match(r.content[0].text, /does not exist/)
})

test("an ask loads no settings, has no built-in tool, may use only its own tools, keeps no transcript and answers in the schema's shape", () => {
  const abort = new AbortController(), schema = { type: 'object' }
  const o = askOptions({ system: 'Fill the form.', schema, tools: ['knowledge_search', 'source_get'], cwd: 'C:/tmp/build', abort })
  assert.deepEqual(o.settingSources, [], "not even the project's: a build runs outside any repo")
  assert.equal(o.strictMcpConfig, true)
  assert.deepEqual(o.tools, [], 'no Read, Bash or any other built-in tool')
  assert.equal(o.persistSession, false)
  assert.equal(o.permissionMode, 'dontAsk')
  assert.deepEqual(o.allowedTools, ['mcp__ask__knowledge_search', 'mcp__ask__source_get'])
  assert.deepEqual(o.disallowedTools, DENY)
  assert.deepEqual(o.outputFormat, { type: 'json_schema', schema })
  assert.equal(o.systemPrompt, 'Fill the form.'); assert.equal(o.cwd, 'C:/tmp/build'); assert.equal(o.abortController, abort)
})

test('a run reads nothing of the console home: its tokens, its config and the database password', () => {
  const deny = permissions([]).disallowedTools
  for (const d of ['Read(~/.work-console/**)', 'Read(**/.work-console/**)', 'Bash(*.work-console*)', 'PowerShell(*.work-console*)']) assert.ok(deny.includes(d), d)
})

test('open_blocker is offered only when given, and is allowed', () => {
  const none = async () => {}
  const base = { submitDraft: none, addArtifact: none, addArtifactFile: none, journal: none }
  assert.equal(runToolDefs(base).some((d) => d.name === 'open_blocker'), false)
  const defs = runToolDefs({ ...base, openBlocker: none })
  assert.ok(defs.some((d) => d.name === 'open_blocker'))
  for (const d of defs) assert.ok(ALLOW.includes(`mcp__run__${d.name}`), d.name)
})

test('the settings\' Claude Code binary goes to the SDK only when one is set', () => {
  assert.deepEqual(exeOption('C:/x/claude.exe'), { pathToClaudeCodeExecutable: 'C:/x/claude.exe' })
  assert.deepEqual(exeOption(undefined), {})
  assert.deepEqual(exeOption(''), {})
})
