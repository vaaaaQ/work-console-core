import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { tempDir } from '../../testdirs.ts'
import { canMcp, cliConfig, guard, permit } from './policy.ts'
import type { Mode, Policy } from './policy.ts'

const root = tempDir('cursor-policy'), cwd = join(root, 'repo'), run = join(root, 'run'), home = join(root, 'home')
for (const d of [cwd, run, home, join(cwd, 'src')]) mkdirSync(d, { recursive: true })
const pol = (mode: Mode): Policy => ({ cwd, mode, hidden: [home, run] })
const start = (runTools = ['Read', 'Glob', 'Grep'], bridge = true) => pol({ kind: 'start', runTools, bridge })
const deny = (v: object) => (v as { permission?: string }).permission === 'deny'
const g = (p: Policy, tool_name: string, tool_input: object) => deny(guard(p, { tool_name, tool_input }))

test('a run with the default tools reads and searches its folder, and changes, runs and fetches nothing', () => {
  const p = start()
  assert.equal(g(p, 'Read', { file_path: join(cwd, 'a.txt') }), false)
  assert.equal(g(p, 'Grep', { pattern: 'x', file_path: cwd }), false)
  assert.equal(g(p, 'List', {}), false)
  assert.equal(g(p, 'Write', { file_path: join(cwd, 'a.txt'), content: 'x' }), true)
  assert.equal(g(p, 'Delete', { file_path: join(cwd, 'a.txt') }), true)
  assert.equal(g(p, 'Shell', { command: 'echo hi' }), true)
  assert.equal(g(p, 'Fetch', { url: 'https://a.example/' }), true)
  assert.deepEqual(guard(p, { tool_name: 'MCP:submit_draft', tool_input: { text: 'x' } }), {}, 'MCP calls are the permission answer\'s')
})

test('the token folders, the console\'s home, the run\'s own folder and the user\'s Cursor folder are never read, in any case', () => {
  const p = start()
  for (const f of [join(homedir(), '.work-console', 'console.token'), join(homedir(), '.WORK-CONSOLE', 'console.token'), join(cwd, 'x', '.work-console', 'mcp.token'),
    join(homedir(), '.bridge', 'k'), join(homedir(), '.cursor', 'mcp.json'), join(homedir(), '.CURSOR', 'mcp.json'), join(home, 'providers.json'), join(run, 'home', '.cursor', 'hooks.json'), run.toUpperCase()]) {
    assert.equal(g(p, 'Read', { file_path: f }), true, f)
    assert.equal(g(p, 'Grep', { pattern: 'x', file_path: f }), true, f)
  }
  assert.equal(g(p, 'Read', { file_path: join(homedir(), '.cursorrules') }), false, 'a sibling that only starts the same')
})

test('a link in the folder that leads to a hidden one is the hidden one', () => {
  const link = join(cwd, 'in')
  symlinkSync(home, link, 'junction')
  assert.equal(g(start(), 'Read', { file_path: join(link, 'providers.json') }), true)
})

test('a run\'s Edit reaches its folder only, a scoped one its globs, never a token folder inside it', () => {
  const p = start(['Read', 'Edit'])
  assert.equal(g(p, 'Write', { file_path: join(cwd, 'src', 'a.ts') }), false)
  assert.equal(g(p, 'Write', { file_path: join(root, 'outside.txt') }), true)
  assert.equal(g(p, 'Write', { file_path: join(cwd, '.work-console', 'x') }), true)
  const s = start(['Edit(src/**)'])
  assert.equal(g(s, 'Write', { file_path: join(cwd, 'src', 'a.ts') }), false)
  assert.equal(g(s, 'Write', { file_path: join(cwd, 'lib', 'a.ts') }), true)
  assert.equal(g(s, 'Read', { file_path: join(cwd, 'src', 'a.ts') }), true, 'no Read rule: no reads')
})

test('shell rules: unscoped, a prefix, a wildcard and exact; a scoped one never takes a chained command; DENY wins', () => {
  assert.equal(g(start(['Bash']), 'Shell', { command: 'npm test && curl x' }), false)
  const p = start(['Bash(git status:*)', 'PowerShell(Get-ChildItem *)', 'Bash(npm test)'])
  for (const [c, ok] of [['git status', true], ['git status -s', true], ['git statusx', false], ['git status; rm -rf x', false], ['git push', false],
    ['Get-ChildItem src', true], ['npm test', true], ['npm test -- x', false]] as const) assert.equal(g(p, 'Shell', { command: c }), !ok, c)
  for (const c of ['type %USERPROFILE%\\.bridge\\k', 'cat ~/.WORK-CONSOLE/console.token', 'cat mcp.token']) assert.equal(g(start(['Bash']), 'Shell', { command: c }), true, c)
})

test('fetch by domain rule, its subdomains too', () => {
  const p = start(['WebFetch(domain:example.com)'])
  assert.equal(g(p, 'Fetch', { url: 'https://docs.example.com/x' }), false)
  assert.equal(g(p, 'Fetch', { url: 'https://example.com.evil.test/' }), true)
  assert.equal(g(start(['WebFetch']), 'Fetch', { url: 'https://any.test/' }), false)
})

test('an ask session reads, changes, runs and fetches nothing; it calls only its own tools', () => {
  const p = pol({ kind: 'ask', own: ['knowledge_read', 'answer'] })
  for (const [t, i] of [['Read', { file_path: join(cwd, 'a') }], ['Grep', {}], ['List', {}], ['Write', { file_path: join(cwd, 'a') }], ['Shell', { command: 'echo' }], ['Fetch', { url: 'https://a.test' }]] as const) assert.equal(g(p, t, i), true, t)
  assert.equal(canMcp(p, 'ask', 'answer'), true)
  assert.equal(canMcp(p, 'ask', 'other'), false)
  assert.equal(canMcp(p, 'run', 'submit_draft'), false)
})

test('a workspace agent reads anywhere but hidden folders, changes only within its limits, runs nothing', () => {
  const limits = { cwd, write: ['workspaces/x/**', 'tools/**'], deny: ['workspaces/x/grants.json'], fold: true }
  const p = pol({ kind: 'agent', limits, own: ['commit'] })
  assert.equal(g(p, 'Read', { file_path: join(root, 'elsewhere.txt') }), false)
  assert.equal(g(p, 'Read', { file_path: join(home, 'providers.json') }), true)
  assert.equal(g(p, 'Write', { file_path: join(cwd, 'workspaces', 'x', 'page.ts') }), false)
  assert.equal(g(p, 'Write', { file_path: join(cwd, 'WORKSPACES', 'x', 'page.ts') }), false, 'folded where the disk ignores case')
  const v = guard(p, { tool_name: 'Write', tool_input: { file_path: join(cwd, 'workspaces', 'x', 'grants.json') } }) as { user_message: string }
  assert.match(v.user_message, /not yours to change: only workspaces\/x\/\*\*, tools\/\*\*, less workspaces\/x\/grants\.json/)
  assert.equal(g(p, 'Delete', { file_path: join(cwd, 'server', 'a.ts') }), true)
  assert.equal(g(p, 'Shell', { command: 'git status' }), true)
  assert.equal(g(p, 'SomeNewEdit', { file_path: join(cwd, 'server', 'a.ts') }), true, 'an unknown tool with a path is held to the write rule')
  assert.equal(canMcp(p, 'agent', 'commit'), true)
})

test('permission requests as the CLI sends them: shell, an out-of-folder write, a delete, MCP by its title', () => {
  const p = start(['Read', 'Bash(echo:*)', 'Edit', 'mcp__ado'])
  assert.equal(permit(p, { title: '`echo hi`', kind: 'execute' }), true)
  assert.equal(permit(p, { title: '`node -p "os.homedir()"`', kind: 'execute', rawInput: { command: 'node -p "os.homedir()"' } }), false)
  assert.equal(permit(p, { title: `Write ${join(root, 'x.txt')}`, kind: 'edit', content: [{ type: 'diff', path: join(root, 'x.txt'), oldText: null, newText: 'x' }] }), false)
  assert.equal(permit(p, { title: `Write ${join(cwd, 'x.txt')}`, kind: 'edit', content: [{ type: 'diff', path: join(cwd, 'x.txt') }] }), true)
  assert.equal(permit(p, { title: `Delete \`${join(cwd, 'del.txt')}\``, kind: 'edit' }), true)
  assert.equal(permit(p, { title: `Delete \`${join(home, 'providers.json')}\``, kind: 'edit' }), false)
  assert.equal(permit(p, { title: 'run-submit_draft: submit_draft', kind: 'other' }), true)
  assert.equal(permit(p, { title: 'run-probe_echo: probe_echo', kind: 'other' }), false)
  assert.equal(permit(p, { title: 'ado-get_item: get_item', kind: 'other' }), true, 'a whole server in runTools')
  assert.equal(permit(p, { title: 'work-console-list_jobs: list_jobs', kind: 'other' }), false, 'DENY, with a dash in the server name')
  assert.equal(permit(p, { title: 'x', kind: 'other', rawInput: { providerIdentifier: 'bridge', toolName: 'bridge_act' } }), false)
  assert.equal(permit(p, { title: 'x', kind: 'other', rawInput: { providerIdentifier: 'bridge', toolName: 'bridge_get' } }), true)
  assert.equal(permit(start(['Read'], false), { title: 'bridge-bridge_get: bridge_get', kind: 'other' }), false, 'no gateway, no bridge')
  assert.equal(permit(p, { title: 'Something new', kind: 'think' }), false)
})

test('the CLI config: allowlist mode, no allow rule, the MCP denies, the hidden folders, the wide denies by grant, no model', () => {
  const c = cliConfig(start())
  assert.equal(c.approvalMode, 'allowlist')
  assert.deepEqual(c.permissions.allow, [])
  for (const d of ['Mcp(bridge:bridge_act)', 'Mcp(work-console:*)', 'Write(*)', 'Shell(*)']) assert.ok(c.permissions.deny.includes(d), d)
  assert.ok(!c.permissions.deny.includes('Read(*)'))
  assert.ok(c.permissions.deny.some((d) => d.startsWith('Read(') && d.includes('/.work-console')))
  assert.ok(!('model' in c))
  const a = cliConfig(pol({ kind: 'ask', own: ['answer'] })).permissions.deny
  for (const d of ['Read(*)', 'Write(*)', 'Shell(*)']) assert.ok(a.includes(d), d)
  const e = cliConfig(start(['Read', 'Edit', 'Bash'])).permissions.deny
  assert.ok(!e.includes('Write(*)') && !e.includes('Shell(*)'))
})
