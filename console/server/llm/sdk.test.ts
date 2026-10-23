import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir, tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { ALLOW, DENY, agentOptions, askOptions, exeOption, mcpServers, permissions, reportOf, runOptions, runToolDefs, sessionEvents, userMessage } from './sdk.ts'
import { agentLimits } from '../agent/limits.ts'
import type { RunTools } from './sdk.ts'
import { BROWSER_TOOLS, WITHHELD } from './runBrowser.ts'

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

test('with the browser on, a session gets the browser tools by name, and still never the whole server', () => {
  const p = permissions(['Read'], true, true)
  assert.deepEqual(p.allowedTools, [...ALLOW, ...BROWSER_TOOLS, 'Read'])
  assert.ok(p.allowedTools.includes('mcp__run__signin_needed'))
  assert.ok(!permissions(['Read']).allowedTools.some((t) => t.startsWith('mcp__browser__')))
  for (const t of WITHHELD) assert.ok(p.disallowedTools.includes(`mcp__browser__${t}`), t)
})

test("a session's browser server comes before the workspace's own, which may not replace it", () => {
  const run = { type: 'sdk' } as never, browser = { type: 'stdio' as const, command: 'node', args: ['cli.js'] }
  const s = mcpServers({ gatewayUrl: 'http://g', llmToken: () => '', mcp: { tracker: { type: 'http', url: 'http://t' } }, bridge: false }, run, browser)
  assert.deepEqual(Object.keys(s), ['run', 'browser', 'tracker'])
  assert.equal(s.browser, browser)
})

test('signin_needed only when the run carries it; it says to stop', async () => {
  const none = async () => {}
  const base: RunTools = { submitDraft: none, addArtifact: none, addArtifactFile: none, journal: none }
  assert.ok(!runToolDefs(base).some((d) => d.name === 'signin_needed'))
  let got: unknown
  const d = runToolDefs({ ...base, signinNeeded: async (o) => { got = o } }).find((d) => d.name === 'signin_needed')!
  assert.ok(ALLOW.includes(`mcp__run__${d.name}`))
  const r = await (d.handler as (a: unknown, x: unknown) => Promise<{ content: { text: string }[] }>)({ site: 'Telegram', url: 'https://web.telegram.example/' }, {})
  assert.deepEqual(got, { site: 'Telegram', url: 'https://web.telegram.example/' })
  assert.match(r.content[0].text, /stop here/)
})

test("a session never reads the user's own CLAUDE.md, which a work dir under the home folder would reach as a parent's", () => {
  const h = homedir().split(sep).join('/')
  assert.deepEqual(permissions([]).settings.claudeMdExcludes, [`${h}/.claude/CLAUDE.md`, `${h}/.claude/rules/**`])
})

test("a run's and the workspace agent's commits and PRs carry no Claude attribution, whatever the user's settings say", () => {
  const limits = agentLimits(join(tmpdir(), 'consumer'), 'w1', [])
  for (const s of [permissions([]).settings, permissions(['Read'], false, true).settings, agentOptions({ limits, tools: [], system: '' }).settings])
    assert.deepEqual(s.attribution, { commit: '', pr: '' })
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

test('ask_question only when the run carries it: allowed, one question a call, its answer or why not', async () => {
  const none = async () => {}, got: string[] = []
  const base: RunTools = { submitDraft: none, addArtifact: none, addArtifactFile: none, journal: none }
  assert.ok(!runToolDefs(base).some((d) => d.name === 'ask_question'))
  const d = runToolDefs({ ...base, askQuestion: async (t) => { got.push(t); return `question 1 is open on “Analysis”` } }).find((x) => x.name === 'ask_question')!
  assert.ok(ALLOW.includes('mcp__run__ask_question'))
  assert.match(d.description, /one per call/)
  const call = d.handler as (a: unknown, x: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }>
  const r = await call({ text: 'Which mailbox?' }, {})
  assert.deepEqual([got, r.isError, r.content[0].text], [['Which mailbox?'], undefined, 'question 1 is open on “Analysis”'])
  const bad = runToolDefs({ ...base, askQuestion: async () => { throw new Error('this run already asked 10 questions') } }).find((x) => x.name === 'ask_question')!
  const b = await (bad.handler as typeof call)({ text: 'one more?' }, {})
  assert.deepEqual([b.isError, b.content[0].text], [true, 'failed: this run already asked 10 questions'])
})

test('submit_draft takes an optional outcome, return_to and why and hands them on', async () => {
  const none = async () => {}, got: unknown[] = []
  const base: RunTools = { submitDraft: async (t, r) => { got.push([t, r]) }, addArtifact: none, addArtifactFile: none, journal: none }
  const d = runToolDefs(base).find((x) => x.name === 'submit_draft')!
  assert.match(d.description, /outcome/)
  const call = d.handler as (a: unknown, x: unknown) => Promise<{ isError?: boolean }>
  await call({ text: 'done it' }, {})
  await call({ text: 'smoke red', outcome: 'failed', return_to: 'Run the deploy', why: 'the smoke test failed' }, {})
  assert.deepEqual(got, [['done it', {}], ['smoke red', { o: 'failed', rt: 'Run the deploy', why: 'the smoke test failed' }]])
  for (const k of ['outcome', 'return_to', 'why']) assert.ok(k in (d.inputSchema as Record<string, unknown>), k)
})

test('submit_draft takes the commands the draft waits to have approved and hands them on as cm', async () => {
  const none = async () => {}, got: unknown[] = []
  const base: RunTools = { submitDraft: async (t, r) => { got.push([t, r]) }, addArtifact: none, addArtifactFile: none, journal: none }
  const d = runToolDefs(base).find((x) => x.name === 'submit_draft')!
  assert.ok('commands' in (d.inputSchema as Record<string, unknown>))
  assert.match(d.description, /commands: when the step's instruction says a command runs only after it is approved/)
  const call = d.handler as (a: unknown, x: unknown) => Promise<{ isError?: boolean }>
  await call({ text: 'push it', commands: ['git push', 'npm run deploy'] }, {})
  await call({ text: 'none', commands: [] }, {})
  assert.deepEqual(got, [['push it', { cm: ['git push', 'npm run deploy'] }], ['none', { cm: [] }]])
  assert.deepEqual(reportOf({ commands: ['a'] }), { cm: ['a'] })
  assert.deepEqual(reportOf({}), {})
})

test('submit_draft takes the facts the draft reports and hands them on as fx; its help names each kind and none', async () => {
  const none = async () => {}, got: unknown[] = []
  const base: RunTools = { submitDraft: async (t, r) => { got.push([t, r]) }, addArtifact: none, addArtifactFile: none, journal: none }
  const d = runToolDefs(base).find((x) => x.name === 'submit_draft')!
  assert.ok('facts' in (d.inputSchema as Record<string, unknown>))
  assert.match(d.description, /facts: what this step leaves.*branch \{repo, name, sha.*pr \{url.*deploy \{what, where, version, ok.*check \{name, ok.*\{kind, none: why\}/)
  const call = d.handler as (a: unknown, x: unknown) => Promise<{ isError?: boolean }>
  const fx = [{ kind: 'branch', repo: 'core', name: 'job/x', sha: 'abcdef1' }]
  await call({ text: 'built', facts: fx }, {})
  assert.deepEqual(got, [['built', { fx }]])
  assert.deepEqual(reportOf({ facts: fx }), { fx })
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

test("request_access only when the run carries it: it passes the add and the reason, and a refusal is the run's error", async () => {
  const none = async () => {}
  const base: RunTools = { submitDraft: none, addArtifact: none, addArtifactFile: none, journal: none }
  assert.ok(!runToolDefs(base).some((d) => d.name === 'request_access'))
  const asked: unknown[] = []
  const d = runToolDefs({ ...base, requestAccess: async (add, reason) => { asked.push([add, reason]); return 'asked for + host a.example' } }).find((x) => x.name === 'request_access')!
  assert.ok(ALLOW.includes('mcp__run__request_access'))
  const call = (h: typeof d, a: unknown) => (h.handler as (a: unknown, x: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>)(a, {})
  assert.equal((await call(d, { add: { hosts: ['a.example'] }, reason: 'reads it' })).content[0].text, 'asked for + host a.example')
  assert.deepEqual(asked, [[{ hosts: ['a.example'] }, 'reads it']])
  const bad = runToolDefs({ ...base, requestAccess: async () => { throw new Error('already grants all of it') } }).find((x) => x.name === 'request_access')!
  const r = await call(bad, { add: { hosts: ['a.example'] }, reason: 'r' })
  assert.equal(r.isError, true); assert.match(r.content[0].text, /already grants/)
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

test("the workspace agent's options: project settings, the five file tools, edits only within its limits, its own tools", async () => {
  const root = join(tmpdir(), 'consumer'), limits = agentLimits(root, 'w1', [])
  const o = agentOptions({ limits, tools: ['check', 'apply'], system: 'You are the agent.' })
  assert.equal(o.cwd, root)
  assert.deepEqual(o.settingSources, ['project'])
  assert.equal(o.permissionMode, 'dontAsk')
  assert.equal(o.strictMcpConfig, true)
  assert.deepEqual(o.tools, ['Read', 'Glob', 'Grep', 'Edit', 'Write'])
  assert.deepEqual(o.allowedTools, ['Read', 'Glob', 'Grep', 'Edit(workspaces/w1/**)', 'Write(workspaces/w1/**)', 'Edit(tools/**)', 'Write(tools/**)', 'mcp__agent__check', 'mcp__agent__apply'])
  for (const t of [...DENY, 'Bash', 'PowerShell', 'NotebookEdit', 'Edit(workspaces/w1/grants.json)', 'Write(workspaces/w1/grants.json)', 'Edit(workspaces/page.ts)', 'Write(workspaces/server.ts)', 'Edit(core.lock.json)'])
    assert.ok(o.disallowedTools.includes(t), `${t} is denied`)
  assert.deepEqual(o.systemPrompt, { type: 'preset', preset: 'claude_code', append: 'You are the agent.' })
  const guard = o.hooks.PreToolUse[0].hooks[0], signal = new AbortController().signal
  const decide = async (tool_name: string, tool_input: Record<string, unknown>) =>
    ((await guard({ hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 't', session_id: 's', transcript_path: '', cwd: root } as never, 't', { signal })) as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision
  assert.equal(await decide('Write', { file_path: join(root, 'workspaces', 'w1', 'page.ts'), content: '' }), undefined)
  assert.equal(await decide('Edit', { file_path: join(root, 'workspaces', 'page.ts') }), 'deny')
  assert.equal(await decide('Write', { file_path: join(root, 'workspaces', 'w1', 'grants.json') }), 'deny')
  assert.equal(await decide('NotebookEdit', { notebook_path: join(tmpdir(), 'n.ipynb') }), 'deny')
  assert.equal(await decide('Write', {}), 'deny')
})

test("the agent's own tools come out by their bare names; built-ins and others' tools keep theirs", async () => {
  async function* msgs() {
    yield { type: 'system', subtype: 'init', session_id: 's1' }
    yield { type: 'assistant', message: { content: [
      { type: 'tool_use', name: 'mcp__agent__apply', input: { summary: 'x' } },
      { type: 'tool_use', name: 'Edit', input: {} },
      { type: 'tool_use', name: 'mcp__other__apply', input: {} },
    ] } }
    yield { type: 'result', subtype: 'success', is_error: false, result: 'done' }
  }
  const got = []
  for await (const e of sessionEvents(msgs() as never, 'agent')) got.push(e.k === 'tool' ? e.name : e.k)
  assert.deepEqual(got, ['session', 'apply', 'Edit', 'mcp__other__apply', 'result'])
})

test('save_source_file only when the run carries it; it hands its args on and answers what the run tool said', async () => {
  const none = async () => {}
  const base: RunTools = { submitDraft: none, addArtifact: none, addArtifactFile: none, journal: none }
  assert.ok(!runToolDefs(base).some((d) => d.name === 'save_source_file'))
  let got: unknown
  const d = runToolDefs({ ...base, saveSourceFile: async (o) => { got = o; return 'saved a.pdf (1 KB)' } }).find((x) => x.name === 'save_source_file')!
  assert.ok(ALLOW.includes(`mcp__run__${d.name}`))
  const r = await (d.handler as (a: unknown, x: unknown) => Promise<{ content: { text: string }[] }>)({ concept: 'chat', id: '-1', file: '2' }, {})
  assert.deepEqual(got, { concept: 'chat', id: '-1', file: '2' })
  assert.match(r.content[0].text, /saved a\.pdf/)
})

test("a session's start says which MCP servers did not connect, as one feed line after its id", async () => {
  async function* msgs() {
    yield { type: 'system', subtype: 'init', session_id: 's1', mcp_servers: [{ name: 'run', status: 'connected' }, { name: 'ssh', status: 'failed' }] }
    yield { type: 'result', subtype: 'success', is_error: false, result: 'done' }
  }
  const got = []
  for await (const e of sessionEvents(msgs() as never)) got.push(e)
  assert.deepEqual(got.slice(0, 2), [{ k: 'session', id: 's1' }, { k: 'text', t: 'MCP servers that did not start: ssh (failed). Their tools are not there for this run.' }])
})

test('runOptions: the workspace servers start with their values, a missing one is a line, the guard and the elicitation handler are set', async () => {
  const problems: string[] = []
  const none = async () => {}
  const tools: RunTools = { submitDraft: none, addArtifact: none, addArtifactFile: none, journal: none, mcpProblem: async (t) => { problems.push(t) } }
  const r = runOptions({ mcp: { ssh: { command: 'node', args: ['s.mjs', '--k=${env:K}'] }, gone: { command: 'node', env: { T: '${env:NOPE}' } } }, runTools: ['mcp__ssh__list'], acting: new Set(['mcp__ssh__run']), vars: { K: 'kv-secret' } }, tools)
  assert.deepEqual(r.servers, { ssh: { command: 'node', args: ['s.mjs', '--k=kv-secret'] } })
  assert.deepEqual(r.lines, ["The MCP server gone is not started for this run: no variable NOPE (set it in the console's environment or in mcp.env)"])
  assert.equal(typeof r.options.onElicitation, 'function')
  const pre = r.options.hooks.PreToolUse[0].hooks[0] as unknown as (i: unknown, id: string, o: unknown) => Promise<unknown>
  await pre({ hook_event_name: 'PreToolUse', tool_name: 'mcp__ssh__run', tool_input: { k: 'kv-secret' } }, 'u', { signal: new AbortController().signal })
  assert.deepEqual(problems, ['Refused mcp__ssh__run {"k":"***"}: it is not ticked for this workspace in Packs or Access. Not retried.'])
  // a run that cannot ask the person declines with a problem
  const d = await r.options.onElicitation({ serverName: 'ssh', message: 'sure?', mode: 'form' }, { signal: new AbortController().signal, requestId: 'x' })
  assert.deepEqual(d, { action: 'decline' })
})

test('request_access says an MCP server from the catalog is asked for as a pack, and its tools that change things only by the person', () => {
  const none = async () => {}
  const d = runToolDefs({ submitDraft: none, addArtifact: none, addArtifactFile: none, journal: none, requestAccess: async () => 'ok' }).find((x) => x.name === 'request_access')!
  assert.match(d.description, /An MCP server from the catalog \(an MCP pack under ## Sources\) is asked for in packs; its read tools come with it, a tool that changes things only when the person ticks it/)
})
