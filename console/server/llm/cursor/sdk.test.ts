import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import { tempDir } from '../../testdirs.ts'
import type { RunTools } from '../sdk.ts'
import { cursorSdk } from './sdk.ts'
import type { CursorOpts } from './sdk.ts'

/* The provider against fake-agent.mjs, which replays the streams the real CLI sent in the spike. */

const FAKE = join(import.meta.dirname, 'fake-agent.mjs'), FIXTURES = join(import.meta.dirname, 'fixtures')
const SID = '00000000-0000-4000-8000-000000000001'
type Seen = Record<string, unknown>

function rig(opts: Partial<CursorOpts> | ((work: string) => Partial<CursorOpts>) = {}) {
  const work = tempDir('cursor-sdk-work'), seen: Seen[] = [], pids: number[] = [], envs: Record<string, string>[] = []
  const o = typeof opts === 'function' ? opts(work) : opts, home = o.home ?? tempDir('cursor-sdk-home')
  let fixture = 'prompt', subst: [string, string][] = [], hook: unknown[] = [], onSeen = (_: Seen) => {}
  // the options' own descriptors, so a getter stays one
  const sdk = cursorSdk(Object.defineProperties({
    gatewayUrl: 'http://127.0.0.1:1', llmToken: () => 't', runTools: [] as string[], home,
    launch: (cwd: string, env: Record<string, string>) => {
      const p = spawn(process.execPath, [FAKE, fixture], { cwd, env: { ...env, FAKE_WORK: work, FAKE_SUBST: JSON.stringify(subst), FAKE_HOOK: JSON.stringify(hook) }, stdio: 'pipe' })
      pids.push(p.pid!)
      envs.push(env)
      createInterface({ input: p.stderr }).on('line', (l) => { try { const x = JSON.parse(l) as Seen; seen.push(x); onSeen(x) } catch { /* not ours */ } })
      return p
    },
  }, Object.getOwnPropertyDescriptors(o)) as CursorOpts)
  const play = (f: string, s: [string, string][] = [], h: unknown[] = [], on = (_: Seen) => {}) => { fixture = f; subst = s; hook = h; onSeen = on; seen.length = 0 }
  const of = (k: string) => seen.filter((x) => k in x).map((x) => x[k])
  return { sdk, home, work, seen, pids, envs, play, of }
}
async function all<T>(xs: AsyncIterable<T>): Promise<T[]> { const out: T[] = []; for await (const x of xs) out.push(x); return out }
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
async function gone(r: ReturnType<typeof rig>) {
  for (let i = 0; i < 40 && (readdirSync(join(r.home, 'cursor', 'runs')).length || r.pids.some(alive)); i++) await new Promise((ok) => setTimeout(ok, 50))
  assert.deepEqual(readdirSync(join(r.home, 'cursor', 'runs')), [], 'the run folder goes')
  assert.deepEqual(r.pids.filter(alive), [], 'no agent process is left')
}
const runTools = (journal: string[][] = []): RunTools => ({
  submitDraft: async () => {}, addArtifact: async () => {}, addArtifactFile: async () => {},
  journal: async (a, b, c) => { journal.push([a, b, c]) },
})
const start = (r: ReturnType<typeof rig>, more: { prompt?: string; resume?: string; cwd?: string; tools?: RunTools; abort?: AbortController; images?: { label: string; mime: string; data: string }[] } = {}) =>
  all(r.sdk.start({ prompt: 'Reply with the single word pong.', cwd: r.work, tools: runTools(), abort: new AbortController(), ...more }))

test('a run\'s turn: its session, text and result; the bridge\'s address and token as they are when it starts; pictures before the prompt', async () => {
  const g = { url: 'http://127.0.0.1:1/old', token: 'old' }
  const r = rig({ get gatewayUrl() { return g.url }, llmToken: () => g.token, mcp: { ext: { type: 'http', url: 'http://h/mcp', headers: { A: 'b' } }, local: { command: 'x', args: [1] }, odd: { type: 'ws' } } })
  g.url = 'http://127.0.0.1:2/'
  g.token = 'new'
  const out = await start(r, { images: [{ label: 'picture 1', mime: 'image/png', data: 'AAAA' }] })
  assert.deepEqual(out, [{ k: 'session', id: SID }, { k: 'text', t: 'pong' }, { k: 'result', ok: true, t: 'pong' }])
  const s = r.of('session/new')[0] as { cwd: string; mcpServers: { name: string; url?: string; headers?: { name: string; value: string }[] }[] }
  assert.equal(s.cwd, r.work)
  assert.deepEqual(s.mcpServers.map((x) => x.name), ['run', 'bridge', 'ext', 'local'])
  assert.match(s.mcpServers[0].url!, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
  assert.deepEqual(s.mcpServers[1], { type: 'http', name: 'bridge', url: 'http://127.0.0.1:2/mcp', headers: [{ name: 'Authorization', value: 'Bearer new' }] })
  assert.deepEqual(s.mcpServers.slice(2), [{ type: 'http', name: 'ext', url: 'http://h/mcp', headers: [{ name: 'A', value: 'b' }] }, { name: 'local', command: 'x', args: ['1'], env: [] }])
  assert.deepEqual(r.of('prompt')[0], [{ type: 'text', text: 'picture 1' }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }, { type: 'text', text: 'Reply with the single word pong.' }])
  assert.ok(existsSync(join(r.home, 'cursor', 'sessions', SID, 'meta.json')), 'the session is kept for a resume')
  await gone(r)
})

test('a resume loads the kept session in a new run folder, without the history the CLI replays; one not kept fails before the CLI starts', async () => {
  const r = rig()
  await start(r)
  r.play('resume')
  const out = await start(r, { prompt: 'Which word?', resume: SID })
  assert.deepEqual(out, [{ k: 'session', id: SID }, { k: 'text', t: 'pong' }, { k: 'result', ok: true, t: 'pong' }])
  assert.equal((r.of('session/load')[0] as { sessionId: string }).sessionId, SID)
  assert.deepEqual(r.of('kept'), [true])
  const n = r.pids.length
  assert.deepEqual(await start(r, { resume: '00000000-0000-4000-8000-000000000009' }), [{ k: 'result', ok: false, error: 'the Cursor session 00000000-0000-4000-8000-000000000009 is not kept in this console' }])
  assert.deepEqual(await start(r, { resume: '../x' }), [{ k: 'result', ok: false, error: 'the Cursor session ../x is not kept in this console' }])
  assert.equal(r.pids.length, n)
  await gone(r)
})

test('a stop while the turn runs cancels the session and says so; one before it starts starts nothing', async () => {
  const r = rig()
  // the recording's second prompt, the one it cancelled
  const lines = readFileSync(join(FIXTURES, 'prompt.jsonl'), 'utf8').split('\n').filter(Boolean)
  const a = lines.findIndex((l) => l.includes('"session/prompt"')), b = lines.findIndex((l) => l.includes('"end_turn"'))
  const f = join(r.work, 'cancel.jsonl')
  writeFileSync(f, [...lines.slice(0, a), ...lines.slice(b + 1)].join('\n'))
  const abort = new AbortController()
  r.play(f, [], [], (x) => { if ('prompt' in x) abort.abort() })
  assert.deepEqual(await start(r, { abort }), [{ k: 'session', id: SID }, { k: 'result', ok: false, error: 'the session was stopped' }])
  assert.equal(r.of('session/cancel').length, 1)
  const early = new AbortController(), n = r.pids.length
  early.abort()
  r.play('prompt')
  assert.deepEqual(await start(r, { abort: early }), [{ k: 'result', ok: false, error: 'the session was stopped' }])
  assert.equal(r.pids.length, n)
  await gone(r)
})

test('a run\'s permission requests are answered from its tools: out of its cwd only what its rules allow', async () => {
  const r = rig()
  mkdirSync(join(r.work, 'cwd'))
  r.play('write')
  const out = await start(r, { cwd: join(r.work, 'cwd') })
  assert.deepEqual(r.of('permission'), ['reject-once', 'reject-once', 'reject-once'])
  assert.deepEqual(out.filter((e) => e.k === 'tool').map((e) => e.k === 'tool' && `${e.name} ${JSON.parse(e.input).path.slice(r.work.length)}`),
    ['Edit \\repo\\allowed\\a.txt', 'Edit \\repo\\core.txt', 'Edit \\cwd\\rel.txt', 'Delete \\repo\\del.txt'])
  const r2 = rig((work) => ({ runTools: [`Edit(${work.replace(/\\/g, '/')}/repo/allowed/**)`] }))
  mkdirSync(join(r2.work, 'cwd'))
  r2.play('write')
  await start(r2, { cwd: join(r2.work, 'cwd') })
  assert.deepEqual(r2.of('permission'), ['allow-once', 'reject-once', 'reject-once'])
  await gone(r)
  await gone(r2)
})

test('a run\'s own tools are served to the CLI: ALLOW\'s are let through, a shell command no rule allows is not', async () => {
  const r = rig(), journal: string[][] = []
  r.play('mcp', [['probe_echo', 'journal'], ['{"text":"hi"}', '{"observed":"a","changed":"b","next":"c"}']])
  const out = await start(r, { tools: runTools(journal) })
  assert.deepEqual(r.of('permission'), ['reject-once', 'allow-once'])
  assert.deepEqual(journal, [['a', 'b', 'c']])
  assert.deepEqual((r.of('mcp')[0] as { tool: string; result: unknown }), { tool: 'journal', result: { content: [{ type: 'text', text: 'journal updated' }] } })
  assert.deepEqual(out.filter((e) => e.k === 'tool').map((e) => e.k === 'tool' && e.name), ['Shell', 'mcp__run__journal'])
  await gone(r)
})

test('the hook the CLI runs asks the console: a workspace agent writes only within its limits', async () => {
  const r = rig()
  r.play('hook', [], [{ tool_name: 'Write', tool_input: { file_path: join(r.work, 'core.txt') } }, { tool_name: 'Write', tool_input: { file_path: join(r.work, 'own', 'a.txt') } }])
  const out = await all(r.sdk.agent!({ prompt: 'Create core.txt', system: 'Be brief.', limits: { cwd: r.work, write: ['own/**'], deny: [] }, tools: [], abort: new AbortController() }))
  const [deny, pass] = r.of('hook') as Record<string, string>[]
  assert.equal(deny.permission, 'deny')
  assert.match(deny.agent_message, /core\.txt is not yours to change: only own\/\*\*/)
  assert.deepEqual(pass, {})
  assert.equal((r.of('prompt')[0] as { text: string }[])[0].text, '<instructions>\nBe brief.\n</instructions>\n\nCreate core.txt')
  assert.deepEqual(out.at(-1), { k: 'result', ok: true, t: '```\nError: core.txt is not yours\n\nAgent note: Do not suggest workarounds to the blocked tool.\n```' })
  await gone(r)
})

test('an ask\'s answer is the answer tool\'s input, checked against the schema; no valid call, no answer', async () => {
  const r = rig(), schema = z.toJSONSchema(z.object({ n: z.number() })) as Record<string, unknown>
  const ask = () => all(r.sdk.ask!({ system: 'Be brief.', prompt: 'What is 2+3?', schema, tools: [{ name: 'lookup', description: 'd', input: {}, run: async () => '' }], cwd: r.work, abort: new AbortController() }))
  const own: [string, string][] = [['"providerIdentifier":"run"', '"providerIdentifier":"ask"'], ['run-answer', 'ask-answer'], ['run: answer', 'ask: answer']]
  r.play('answer', own)
  assert.deepEqual(await ask(), [{ k: 'result', ok: true, out: { n: 5 } }])
  assert.deepEqual(r.of('permission'), ['allow-once'])
  assert.match((r.of('prompt')[0] as { text: string }[])[0].text, /^<instructions>\nBe brief\.\n<\/instructions>\n\nWhat is 2\+3\?\n\nGive your answer by calling the answer tool/)
  r.play('answer', [...own, ['{"n":5}', '{"n":"five"}']])
  assert.deepEqual(await ask(), [{ k: 'result', ok: false, error: 'the session ended without its answer' }])
  assert.equal((r.of('mcp')[0] as { result: { isError?: boolean } }).result.isError, true)
  r.play('answer')
  assert.deepEqual(await ask(), [{ k: 'result', ok: false, error: 'the session ended without its answer' }])
  assert.deepEqual(r.of('permission'), ['reject-once'])
  await gone(r)
})

test('a refused plan, a signed-out CLI and a missing one each say so', async () => {
  const r = rig()
  r.play('plan')
  const plan = (await start(r)).at(-1) as { error: string }
  assert.match(plan.error, /^cursor_plan: the Cursor account's plan refused the turn: Upgrade your plan to continue$/)
  r.play('signedout')
  assert.deepEqual(await start(r), [{ k: 'result', ok: false, error: 'signin_required: Authentication required: Cursor is signed out; sign in with agent login in a terminal' }])
  const none = cursorSdk({ gatewayUrl: 'http://127.0.0.1:1', llmToken: () => 't', runTools: [], home: r.home, cursorPath: () => join(r.work, 'nope', 'agent.cmd') })
  const out = await all(none.start({ prompt: 'p', cwd: r.work, tools: runTools(), abort: new AbortController() }))
  assert.match((out[0] as { error: string }).error, /^cursor_missing: /)
  await gone(r)
})

test('the CLI\'s session store gets a path Windows opens; a home too deep for one fails before the CLI starts', { skip: process.platform !== 'win32' && 'a Windows limit' }, async () => {
  const deep = (n: number) => { const t = tempDir('cursor-sdk-deep'), d = join(t, 'h'.repeat(n - t.length - 1)); mkdirSync(d); return d }
  const ok = rig({ home: deep(160) })
  assert.deepEqual((await start(ok)).at(-1), { k: 'result', ok: true, t: 'pong' })
  // SQLite's own limit, measured with the CLI's node: 251 characters open, 252 do not
  assert.ok(join(ok.envs[0].CURSOR_CONFIG_DIR, 'acp-sessions', SID, 'store.db').length <= 251)
  await gone(ok)
  const no = rig({ home: deep(170) })
  const out = await start(no)
  assert.equal(out.length, 1)
  assert.match((out[0] as { error: string }).error, /^cursor_path: .*251/)
  assert.deepEqual(no.pids, [])
  assert.equal(existsSync(join(no.home, 'cursor', 'runs')), false, 'no run folder is made')
})
