import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir } from '../../testdirs.ts'
import { GUARD, PRELOAD, findInstall, hookCommand, killTree, sessionEnv } from './cli.ts'
import { serveSession } from './serve.ts'

const NODE = process.platform === 'win32' ? 'node.exe' : 'node'
function install(root: string, versions: Record<string, boolean>) {
  for (const [v, whole] of Object.entries(versions)) {
    const d = join(root, 'versions', v)
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'index.js'), '')
    if (whole) writeFileSync(join(d, NODE), '')
  }
  writeFileSync(join(root, 'agent.cmd'), '')
}

test('the newest whole version, by its date and build time; a launcher or a version\'s own file in the setting', () => {
  const root = tempDir('cursor-install')
  install(root, { '2026.9.30-abc1': true, '2026.10.01-e373342': true, '2026.10.01-12-00-00-def2': true, '2026.10.02-fff': false, 'junk': true })
  const v = (s: string) => join(root, 'versions', s)
  assert.deepEqual(findInstall(undefined, root), { node: join(v('2026.10.01-12-00-00-def2'), NODE), index: join(v('2026.10.01-12-00-00-def2'), 'index.js') })
  assert.equal(findInstall(join(root, 'agent.cmd'), '/nowhere').index, join(v('2026.10.01-12-00-00-def2'), 'index.js'))
  assert.equal(findInstall(join(v('2026.9.30-abc1'), 'index.js'), '/nowhere').index, join(v('2026.9.30-abc1'), 'index.js'))
  assert.throws(() => findInstall(join(root, 'nope', 'agent.cmd'), root), /^Error: cursor_missing: .*nope/)
  assert.throws(() => findInstall(undefined, join(root, 'none')), /^Error: cursor_missing: no Cursor agent CLI in /)
})

test('a Windows session keeps a short environment, matched whatever its case; elsewhere the whole one; both get their own folders', () => {
  const d = { config: '/r/config', data: '/r/data', home: '/r/home', tmp: '/r/tmp' }
  const env = { Path: 'C:\\bin', SYSTEMROOT: 'C:\\Windows', MSYSTEM: 'MINGW64', SHELL: '/usr/bin/bash', SOME_TOKEN: 's', TEMP: 'C:\\t' }
  assert.deepEqual(sessionEnv(d, env, 'win32'), { SystemRoot: 'C:\\Windows', PATH: 'C:\\bin', CURSOR_CONFIG_DIR: '/r/config', CURSOR_DATA_DIR: '/r/data', WC_CURSOR_HOME: '/r/home', NO_OPEN_BROWSER: '1', CURSOR_INVOKED_AS: 'agent', TEMP: '/r/tmp', TMP: '/r/tmp' })
  const posix = sessionEnv(d, { PATH: '/bin', HOME: '/home/u' }, 'linux')
  assert.equal(posix.HOME, '/home/u')
  assert.equal(posix.TMPDIR, '/r/tmp')
  assert.equal(posix.WC_CURSOR_HOME, '/r/home')
})

test('the hook command quotes for PowerShell on Windows and for sh elsewhere', () => {
  assert.equal(hookCommand(['C:\\n o\\node.exe', "it's", 'x'], 'win32'), "& 'C:\\n o\\node.exe' 'it''s' 'x'")
  assert.equal(hookCommand(['/n o/node', "it's"], 'linux'), "'/n o/node' 'it'\\''s'")
})

test('the preload gives the CLI the session\'s home and nothing else', () => {
  const home = tempDir('cursor-home')
  const out = execFileSync(process.execPath, ['-r', PRELOAD, '-p', 'require("os").homedir() + "|" + process.env.USERPROFILE + process.env.HOME'], { env: { ...process.env, WC_CURSOR_HOME: home } }).toString()
  assert.equal(out.split('|')[0], home)
  assert.ok(!out.split('|')[1].includes(home))
})

test('the guard hook sends only the tool\'s name and paths, prints the verdict, and denies when the console does not answer', async () => {
  const seen: unknown[] = []
  const s = await serveSession({ name: 'run', tools: [], guard: (x) => { seen.push(x); return { permission: 'deny', user_message: 'no', agent_message: 'no' } } })
  const hook = (guard: string, token: string, input: string) => new Promise<string>((ok) => {
    const p = spawn(process.execPath, [GUARD, new URL(guard).port, token], { stdio: ['pipe', 'pipe', 'ignore'] })
    let o = ''
    p.stdout.on('data', (b) => { o += b })
    p.on('close', () => ok(o))
    p.stdin.end(input)
  })
  try {
    const payload = { tool_name: 'Read', tool_input: { file_path: 'C:\\x', limit: 5 }, user_email: 'someone@example.test', conversation_id: 'c' }
    assert.deepEqual(JSON.parse(await hook(s.guard, s.token, '\uFEFF' + JSON.stringify(payload))), { permission: 'deny', user_message: 'no', agent_message: 'no' })
    assert.deepEqual(seen, [{ tool_name: 'Read', tool_input: { file_path: 'C:\\x' } }])
    assert.equal(JSON.parse(await hook(s.guard, 'wrong', JSON.stringify(payload))).permission, 'deny')
    assert.equal(JSON.parse(await hook(s.guard, s.token, 'not json')).permission, 'deny')
  } finally { await s.close() }
  assert.match(JSON.parse(await hook(s.guard, s.token, '{"tool_name":"Read"}')).user_message, /could not decide/)
})

test('killing a session ends the processes it started too', async () => {
  const p = spawn(process.execPath, ['-e', 'const c = require("child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); console.log(c.pid); setInterval(() => {}, 1000)'],
    { stdio: ['ignore', 'pipe', 'ignore'], detached: process.platform !== 'win32' })
  const child = Number(await new Promise<string>((ok) => p.stdout.once('data', (b) => ok(String(b).trim()))))
  const closed = new Promise((ok) => p.on('close', ok))
  killTree(p.pid)
  await closed
  const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
  for (let i = 0; i < 40 && alive(child); i++) await new Promise((r) => setTimeout(r, 50))
  assert.equal(alive(child), false)
})
