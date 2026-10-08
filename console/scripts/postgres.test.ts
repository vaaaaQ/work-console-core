import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Ran } from './lib.mjs'
import { dockerRunner, engine, ensurePassword, pgDown, postgres, type Docker } from './postgres.mjs'

/* postgres.mjs against a scripted docker: each rule answers the first call whose argv, joined by spaces, matches it.
   The live test at the end starts a real -test container and needs WORK_CONSOLE_LIVE_DOCKER=1. */

const made: string[] = []
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }) })
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'wc-pg-')); made.push(d); return d }
const ok = (stdout = ''): Ran => ({ status: 0, stdout, stderr: '' })
const bad = (stderr: string, status = 1): Ran => ({ status, stdout: '', stderr })

type Call = { args: string[]; env?: NodeJS.ProcessEnv; input?: string }
type Rule = [RegExp, Ran | ((c: Call) => Ran)]
const engineUp: Rule[] = [[/^version/, ok('27.3.1\n')]]
function fake(rules: Rule[]): Docker & { calls: Call[] } {
  const calls: Call[] = []
  const d = (args: string[], o?: { env?: NodeJS.ProcessEnv; input?: string }) => {
    const c = { args, env: o?.env, input: o?.input }
    calls.push(c)
    const line = args.join(' ')
    for (const [re, r] of [...rules, ...engineUp]) if (re.test(line)) return typeof r === 'function' ? r(c) : r
    return ok()
  }
  return Object.assign(d, { calls })
}
const binding = (name: string, running: boolean, port: number) =>
  `/${name}|${running}|${JSON.stringify({ '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: String(port) }] })}`
const select1: Rule = [/^exec .* select 1$/, ok('1\n')]
const fast = { tries: 3, ms: 0 }
const allFree = async () => true
const upOf = (d: { calls: Call[] }) => d.calls.find((c) => c.args.includes('up'))!

test('engine down is reported though exit code is 0', () => {
  const r = engine(fake([[/^version/, { status: 0, stdout: '', stderr: 'error during connect: the engine is not running' }]]))
  assert.equal(r.ok, false)
  assert.match(r.why!, /error during connect/)
})

test('engine up needs a server version, a container query and compose', () => {
  assert.deepEqual(engine(fake([[/^version/, ok('27.3.1\n')]])), { ok: true, version: '27.3.1' })
  const noPs = engine(fake([[/^version/, ok('27.3.1\n')], [/^ps/, bad('permission denied')]]))
  assert.equal(noPs.ok, false)
  assert.match(noPs.why!, /permission denied/)
  const noCompose = engine(fake([[/^version/, ok('27.3.1\n')], [/^compose version/, bad('unknown command')]]))
  assert.equal(noCompose.ok, false)
  assert.match(noCompose.why!, /compose/)
})

test('engine says when docker is not installed', () => {
  const missing = Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' })
  const r = engine(fake([[/^version/, { status: null, stdout: '', stderr: '', error: missing }]]))
  assert.equal(r.ok, false)
  assert.match(r.why!, /not installed/)
})

test('ensurePassword creates the file once and never rewrites it', () => {
  const home = tmp()
  const f = ensurePassword(home)
  const first = readFileSync(f, 'utf8')
  assert.ok(first.trim().length >= 32)
  assert.equal(ensurePassword(home), f)
  assert.equal(readFileSync(f, 'utf8'), first)
})

test('picks the next port when 55432 is declared by another container, even a stopped one', async () => {
  const d = fake([[/^ps -aq/, ok('abc\n')], [/^inspect/, ok(binding('other-postgres', false, 55432) + '\n')], select1])
  const r = await postgres({ home: tmp(), docker: d, free: allFree, wait: fast })
  assert.equal(r.port, 55433)
  assert.equal(r.url, 'postgres://work_console@127.0.0.1:55433/work_console')
  const up = upOf(d)
  assert.equal(up.env?.WORK_CONSOLE_PG_PORT, '55433')
  assert.deepEqual(up.args.slice(0, 3), ['compose', '-p', 'work-console'])
  assert.ok(!d.calls.some((c) => c.args.includes('other-postgres')), 'never touches the other container')
})

test('skips a port something on the host holds', async () => {
  const d = fake([select1])
  const r = await postgres({ home: tmp(), docker: d, free: async (p) => p !== 55432, wait: fast })
  assert.equal(r.port, 55433)
})

test('keeps the port of its own running container', async () => {
  const d = fake([[/^ps -aq/, ok('abc\n')], [/^inspect/, ok(binding('work-console-postgres', true, 55440) + '\n')], select1])
  const r = await postgres({ home: tmp(), docker: d, free: async () => false, wait: fast })
  assert.equal(r.port, 55440)
})

test('takes the recorded port when it is free and undeclared', async () => {
  const r = await postgres({ home: tmp(), docker: fake([select1]), want: 55450, free: allFree, wait: fast })
  assert.equal(r.port, 55450)
})

test('compose gets the password file, container and volume through env, never argv', async () => {
  const home = tmp()
  const d = fake([select1])
  const r = await postgres({ home, docker: d, names: { project: 'p-test', container: 'c-test', volume: 'v-test' }, free: allFree, wait: fast })
  const up = upOf(d)
  assert.equal(up.env?.WORK_CONSOLE_PG_PASSWORD_FILE, r.passwordPath)
  assert.equal(up.env?.WORK_CONSOLE_PG_CONTAINER, 'c-test')
  assert.equal(up.env?.WORK_CONSOLE_PG_VOLUME, 'v-test')
  assert.deepEqual(up.args.slice(0, 3), ['compose', '-p', 'p-test'])
  const pw = readFileSync(r.passwordPath, 'utf8').trim()
  for (const c of d.calls) assert.ok(!c.args.some((a) => a.includes(pw)), `password in argv of ${c.args.join(' ')}`)
  const probe = d.calls.find((c) => c.args.at(-1) === 'select 1')!
  assert.equal(probe.env?.PGPASSWORD, pw)
  assert.ok(probe.args.includes('c-test'))
})

test('resets the role password after compose up when auth fails', async () => {
  let probes = 0
  const d = fake([[/^exec .* select 1$/, () => ++probes === 1 ? bad('psql: error: FATAL:  password authentication failed for user "work_console"', 2) : ok('1\n')]])
  const r = await postgres({ home: tmp(), docker: d, free: allFree, wait: fast })
  const alter = d.calls.find((c) => /ALTER ROLE/.test(c.input ?? ''))!
  assert.ok(alter, 'an ALTER ROLE went in on stdin')
  assert.ok(!alter.args.includes('-h'), 'through the local socket')
  assert.ok(alter.input!.includes(readFileSync(r.passwordPath, 'utf8').trim()))
  assert.equal(probes, 2)
})

test('gives up with the last error once the wait runs out', async () => {
  const d = fake([[/^exec .* select 1$/, bad('connection refused')]])
  await assert.rejects(postgres({ home: tmp(), docker: d, free: allFree, wait: fast }), /did not answer.*connection refused/s)
})

test('a failing compose up stops with its output', async () => {
  const d = fake([[/ up -d$/, bad('Bind for 127.0.0.1:55432 failed: port is already allocated')]])
  await assert.rejects(postgres({ home: tmp(), docker: d, free: allFree, wait: fast }), /already allocated/)
})

test('engine down stops before anything else', async () => {
  const d = fake([[/^version/, bad('error during connect')]])
  await assert.rejects(postgres({ home: tmp(), docker: d, free: allFree, wait: fast }), /error during connect/)
  assert.equal(d.calls.length, 1)
})

test('live: a -test container comes up on a free port and answers', { skip: process.env.WORK_CONSOLE_LIVE_DOCKER !== '1' && 'set WORK_CONSOLE_LIVE_DOCKER=1 to start a real container' }, async () => {
  const docker = dockerRunner()
  const names = { project: 'work-console-test', container: 'work-console-postgres-test', volume: 'work-console-pg-test' }
  const home = tmp()
  try {
    const r = await postgres({ home, docker, names, log: () => {} })
    assert.ok(r.port >= 55432)
    const again = await postgres({ home, docker, names, log: () => {} })
    assert.equal(again.port, r.port, 'a second run keeps the port')
  } finally {
    pgDown({ docker, names, passwordPath: join(home, 'postgres.password') })
  }
})
