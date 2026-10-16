import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ACT_CALLS_MAX, ELICIT_WAIT, elicitHandler, elicitProblems, mcpGuard, serverStatusLine, startServers, stdioCommand } from './mcpRun.ts'
import type { ElicitIn } from './mcpRun.ts'
import { tempDir } from '../testdirs.ts'

function binDir() {
  const d = tempDir('bin')
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'npx.cmd'), '@echo off')
  writeFileSync(join(d, 'tool.exe'), '')
  writeFileSync(join(d, 'old.bat'), '')
  return d
}

test('stdioCommand: on win32 a command PATH finds as .cmd or .bat goes through cmd.exe; others stay as they are', () => {
  const d = binDir(), env = { PATH: d, PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\Windows\\system32\\cmd.exe' }
  const w = (c: Record<string, unknown>) => stdioCommand(c, 'win32', env)
  assert.deepEqual(w({ command: 'npx', args: ['-y', 'x@1'], env: { A: '1' } }), { command: 'C:\\Windows\\system32\\cmd.exe', args: ['/d', '/s', '/c', 'npx', '-y', 'x@1'], env: { A: '1' } })
  assert.deepEqual(w({ command: 'old', args: [] }).args, ['/d', '/s', '/c', 'old'])
  assert.deepEqual(w({ command: join(d, 'npx.cmd') }).args, ['/d', '/s', '/c', join(d, 'npx.cmd')])
  for (const c of [{ command: 'tool' }, { command: 'node', args: ['s.mjs'] }, { command: join(d, 'tool.exe') }, { type: 'http', url: 'https://x.example/mcp' }])
    assert.deepEqual(w(c), c)
  assert.deepEqual(stdioCommand({ command: 'npx', args: ['-y'] }, 'linux', env), { command: 'npx', args: ['-y'] })
})

test("startServers: each workspace server with its ${env:} put in and its command fit to the platform; one missing a value stays out with a line", () => {
  const d = binDir(), env = { PATH: d, PATHEXT: '.EXE;.CMD', ComSpec: 'cmd.exe' }
  const r = startServers({
    ssh: { command: 'npx', args: ['-y', 'shell-mcp@1', '--key=${env:SSH_KEY}'] },
    api: { type: 'http', url: 'https://a.example/mcp', headers: { Authorization: 'Bearer ${env:API_TOKEN}' } },
  }, { SSH_KEY: 'C:/keys/id_e2e' }, 'win32', env)
  assert.deepEqual(r.servers, { ssh: { command: 'cmd.exe', args: ['/d', '/s', '/c', 'npx', '-y', 'shell-mcp@1', '--key=C:/keys/id_e2e'] } })
  assert.deepEqual(r.lines, ["The MCP server api is not started for this run: no variable API_TOKEN (set it in the console's environment or in mcp.env)"])
  assert.deepEqual(r.secrets, ['C:/keys/id_e2e'])
})

test("a session's start names each MCP server that did not connect, once; connected and pending ones say nothing", () => {
  assert.equal(serverStatusLine([{ name: 'bridge', status: 'connected' }, { name: 'ssh', status: 'failed' }, { name: 'x', status: 'pending' }, { name: 'gh', status: 'needs-auth' }]),
    'MCP servers that did not start: ssh (failed), gh (needs-auth). Their tools are not there for this run.')
  assert.equal(serverStatusLine([{ name: 'bridge', status: 'connected' }]), null)
  assert.equal(serverStatusLine(undefined), null)
})

type Pre = (i: unknown, id: string | undefined, o: { signal: AbortSignal }) => Promise<{ hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }>
const sig = { signal: new AbortController().signal }

test("the guard: an unticked tool of a workspace server is refused with a problem on the step; others' tools are not its business", async () => {
  const problems: string[] = []
  const g = mcpGuard({ servers: ['ssh', 'whole'], runTools: ['mcp__ssh__list', 'mcp__ssh__run', 'mcp__whole'], acting: new Set(['mcp__ssh__run', 'mcp__ssh__sudo']), problem: async (t) => { problems.push(t) } })
  const pre = g.hooks.PreToolUse[0].hooks[0] as unknown as Pre
  const call = (n: string) => pre({ hook_event_name: 'PreToolUse', tool_name: n, tool_input: { command: 'ls' } }, 'u1', sig)
  assert.deepEqual(await call('mcp__ssh__list'), {})
  assert.deepEqual(await call('mcp__whole__anything'), {})
  assert.deepEqual(await call('mcp__bridge__bridge_get'), {})
  assert.deepEqual(await call('Read'), {})
  const no = await call('mcp__ssh__sudo')
  assert.equal(no.hookSpecificOutput?.permissionDecision, 'deny')
  assert.deepEqual(problems, ['Refused mcp__ssh__sudo {"command":"ls"}: it is not ticked for this workspace in Packs or Access. Not retried.'])
})

test(`the guard: at most ${ACT_CALLS_MAX} calls of tools that change things a run; the next is refused, and the calls are counted`, async () => {
  const problems: string[] = []
  const g = mcpGuard({ servers: ['ssh'], runTools: ['mcp__ssh__run', 'mcp__ssh__list'], acting: new Set(['mcp__ssh__run']), max: 2, problem: async (t) => { problems.push(t) } })
  const pre = g.hooks.PreToolUse[0].hooks[0] as unknown as Pre
  const call = (n: string) => pre({ hook_event_name: 'PreToolUse', tool_name: n, tool_input: {} }, 'u', sig)
  assert.deepEqual(await call('mcp__ssh__run'), {})
  assert.deepEqual(await call('mcp__ssh__list'), {})
  assert.deepEqual(await call('mcp__ssh__run'), {})
  assert.equal((await call('mcp__ssh__run')).hookSpecificOutput?.permissionDecision, 'deny')
  assert.deepEqual(problems, ['Refused mcp__ssh__run {}: this run already called 2 tools that change things. Not retried.'])
  assert.deepEqual(g.calls(), ['mcp__ssh__run', 'mcp__ssh__run'])
  assert.equal(ACT_CALLS_MAX, 30)
})

test("the guard's check answers a provider that asks per call (Cursor): null lets it through, else why not", async () => {
  const problems: string[] = []
  const g = mcpGuard({ servers: ['ssh'], runTools: ['mcp__ssh__run'], acting: new Set(['mcp__ssh__run']), max: 1, problem: async (t) => { problems.push(t) } })
  assert.equal(await g.check('mcp__ssh__run', {}), null)
  assert.match((await g.check('mcp__ssh__run', {}))!, /already called 1 tools that change things/)
  assert.match((await g.check('mcp__ssh__sudo', {}))!, /not ticked/)
  assert.equal(await g.check('mcp__run__journal', {}), null)
  assert.equal(problems.length, 2)
})

test('the guard: a tool that changes things and fails is a problem with its text, secrets masked', async () => {
  const problems: string[] = []
  const g = mcpGuard({ servers: ['ssh'], runTools: ['mcp__ssh__run', 'mcp__ssh__list'], acting: new Set(['mcp__ssh__run']), problem: async (t) => { problems.push(t) }, scrub: (t) => t.replace('hunter2', '***') })
  const post = g.hooks.PostToolUse[0].hooks[0] as unknown as Pre, fail = g.hooks.PostToolUseFailure[0].hooks[0] as unknown as Pre
  await post({ hook_event_name: 'PostToolUse', tool_name: 'mcp__ssh__run', tool_input: { command: 'rm -rf /tmp/x' }, tool_response: [{ type: 'text', text: 'ok' }] }, 'u', sig)
  await post({ hook_event_name: 'PostToolUse', tool_name: 'mcp__ssh__run', tool_input: { command: 'rm -rf /tmp/x' }, tool_response: { isError: true, content: [{ type: 'text', text: 'APPROVAL_UNAVAILABLE: declined' }] } }, 'u', sig)
  await fail({ hook_event_name: 'PostToolUseFailure', tool_name: 'mcp__ssh__run', tool_input: {}, error: 'auth failed for hunter2' }, 'u', sig)
  await fail({ hook_event_name: 'PostToolUseFailure', tool_name: 'mcp__ssh__list', tool_input: {}, error: 'read failed' }, 'u', sig)
  assert.deepEqual(problems, [
    'Failed mcp__ssh__run {"command":"rm -rf /tmp/x"}: APPROVAL_UNAVAILABLE: declined. Not retried.',
    'Failed mcp__ssh__run {}: auth failed for ***. Not retried.',
  ])
})

const q = (o: Partial<{ mode: 'form' | 'url'; url: string }> = {}) => ({ serverName: 'ssh', message: 'Run rm -rf /tmp/ad26 on e2e?', mode: o.mode, url: o.url, requestedSchema: { type: 'object', properties: { ok: { type: 'boolean' } } }, title: 'Destructive command' })

test('an elicitation in form mode goes to the person and their answer back to the server', async () => {
  let got: ElicitIn | undefined
  const h = elicitHandler({ ask: async (x) => { got = x; return { action: 'accept', content: { ok: true } } }, problem: async () => {} })
  assert.deepEqual(await h(q(), { signal: new AbortController().signal, requestId: 'r1' }), { action: 'accept', content: { ok: true } })
  assert.deepEqual(got, { srv: 'ssh', msg: 'Run rm -rf /tmp/ad26 on e2e?', schema: { type: 'object', properties: { ok: { type: 'boolean' } } }, title: 'Destructive command' })
})

test('an elicitation that asks to open a link, or that a run cannot ask, is declined with a problem', async () => {
  const problems: string[] = []
  const problem = async (t: string) => { problems.push(t) }
  const s = { signal: new AbortController().signal, requestId: 'r' }
  assert.deepEqual(await elicitHandler({ ask: async () => ({ action: 'accept' }), problem })(q({ mode: 'url', url: 'https://login.example/' }), s), { action: 'decline' })
  assert.deepEqual(await elicitHandler({ problem })(q(), s), { action: 'decline' })
  assert.deepEqual(problems, [
    'The MCP server ssh asks to open a link (https://login.example/); that is not supported yet. Declined.',
    'The MCP server ssh asked for a confirmation this run cannot ask the person for: Run rm -rf /tmp/ad26 on e2e? Declined.',
  ])
})

test('an elicitation not answered in time is declined with a problem; an aborted run cancels it', async () => {
  const problems: string[] = []
  const never = (_: ElicitIn, signal: AbortSignal) => new Promise<never>((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))))
  const h = elicitHandler({ ask: never, problem: async (t) => { problems.push(t) }, waitMs: 20 })
  assert.deepEqual(await h(q(), { signal: new AbortController().signal, requestId: 'r' }), { action: 'decline' })
  assert.deepEqual(problems, ['No answer in time to the MCP server ssh: Run rm -rf /tmp/ad26 on e2e? Declined.'])
  const ac = new AbortController(), p = elicitHandler({ ask: never, problem: async () => {}, waitMs: 60_000 })(q(), { signal: ac.signal, requestId: 'r' })
  ac.abort()
  assert.deepEqual(await p, { action: 'cancel' })
})

test("an answer's fields are checked against the server's flat schema: types, enums, required ones and no others", () => {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' }, n: { type: 'integer' }, mode: { type: 'string', enum: ['a', 'b'] }, tags: { type: 'array', items: { type: 'string' } } }, required: ['ok'] }
  assert.deepEqual(elicitProblems(schema, { ok: true, n: 2, mode: 'a', tags: ['x'] }), [])
  assert.deepEqual(elicitProblems(schema, { n: 1.5, mode: 'c', extra: 1, tags: [1] }), ['ok is required', 'n is not an integer', 'mode is not one of a, b', 'extra is not asked for', 'tags is not a list of strings'])
  assert.deepEqual(elicitProblems(undefined, {}), [])
})

test("a server's question waits 10 minutes, as long as the catalog's ssh server waits for its answer", () => {
  assert.equal(ELICIT_WAIT, 10 * 60_000)
})
