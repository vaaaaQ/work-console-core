import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Ran } from './lib.mjs'
import { containers, dockerRunner, engine, ensurePassword, envNames, pgDown, pgNames, postgres, published, type Docker } from './postgres.mjs'

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
/** a line of docker ps -a --format {{.Names}}|{{.State}}|{{.Ports}} */
const psLine = (name: string, state: string, ports = '') => `${name}|${state}|${ports}`
const ps = (...lines: string[]): Rule => [/^ps -a --format/, ok(lines.join('\n') + '\n')]
const declared = (name: string, port: number) => `/${name}|${JSON.stringify({ '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: String(port) }] })}`
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

test('published reads the host ports of docker ps, ranges and IPv6 included, exposed-only ports not', () => {
  assert.deepEqual(published('127.0.0.1:55432->5432/tcp'), [55432])
  assert.deepEqual(published('0.0.0.0:8080->80/tcp, [::]:8080->80/tcp, 5432/tcp'), [8080])
  assert.deepEqual(published('0.0.0.0:3000-3002->3000-3002/tcp'), [3000, 3001, 3002])
  assert.deepEqual(published(''), [])
})

test('containers: running ones with what they publish, stopped ones with what they declare', () => {
  const d = fake([
    ps(psLine('agents-postgres-postgres-1', 'running', '127.0.0.1:55432->5432/tcp'), psLine('old-pg', 'exited'), psLine('idle', 'created')),
    [/^inspect/, ok(declared('old-pg', 55433) + '\n/idle|null\n')],
  ])
  assert.deepEqual(containers(d), [
    { name: 'agents-postgres-postgres-1', running: true, ports: [55432] },
    { name: 'old-pg', running: false, ports: [55433] },
    { name: 'idle', running: false, ports: [] },
  ])
  assert.deepEqual(d.calls.find((c) => c.args[0] === 'inspect')!.args.slice(-2), ['old-pg', 'idle'], 'only the stopped ones are inspected')
})

test('skips 55432 when another container publishes it, says who holds it, and never touches that container', async () => {
  const lines: string[] = []
  const d = fake([ps(psLine('agents-postgres-postgres-1', 'running', '127.0.0.1:55432->5432/tcp')), select1])
  // the probe would call 55432 free: docker's own listing decides
  const r = await postgres({ home: tmp(), docker: d, free: allFree, wait: fast, log: (l) => lines.push(l) })
  assert.equal(r.port, 55433)
  assert.equal(r.url, 'postgres://work_console@127.0.0.1:55433/work_console')
  const up = upOf(d)
  assert.equal(up.env?.WORK_CONSOLE_PG_PORT, '55433')
  assert.deepEqual(up.args.slice(0, 3), ['compose', '-p', 'work-console'])
  assert.match(lines.join('\n'), /55432 is held by agents-postgres-postgres-1/)
  assert.ok(!d.calls.some((c) => c.args.includes('agents-postgres-postgres-1')), 'never touches the other container')
})

test('skips a port a stopped container declares', async () => {
  const d = fake([ps(psLine('other-postgres', 'exited')), [/^inspect/, ok(declared('other-postgres', 55432) + '\n')], select1])
  const r = await postgres({ home: tmp(), docker: d, free: allFree, wait: fast })
  assert.equal(r.port, 55433)
})

test('skips a port something on the host holds', async () => {
  const lines: string[] = []
  const d = fake([select1])
  const r = await postgres({ home: tmp(), docker: d, free: async (p) => p !== 55432, wait: fast, log: (l) => lines.push(l) })
  assert.equal(r.port, 55433)
  assert.match(lines.join('\n'), /55432 is held by another process/)
})

test('keeps the port its own running container publishes, though the probe calls it busy', async () => {
  const d = fake([ps(psLine('work-console-postgres', 'running', '127.0.0.1:55440->5432/tcp')), select1])
  const r = await postgres({ home: tmp(), docker: d, want: 55432, free: async () => false, wait: fast })
  assert.equal(r.port, 55440)
})

test('a renamed container is ours by its own name only', async () => {
  const d = fake([ps(psLine('work-console-postgres', 'running', '127.0.0.1:55432->5432/tcp')), select1])
  const r = await postgres({ home: tmp(), docker: d, names: { container: 'wc-test', volume: 'wc-pg-test' }, free: allFree, wait: fast })
  assert.equal(r.port, 55433, "the default container's port is another container's")
})

test('takes the recorded port when it is free and no other container has it', async () => {
  const r = await postgres({ home: tmp(), docker: fake([select1]), want: 55450, free: allFree, wait: fast })
  assert.equal(r.port, 55450)
  const taken = await postgres({ home: tmp(), docker: fake([ps(psLine('x', 'running', '127.0.0.1:55450->5432/tcp')), select1]), want: 55450, free: allFree, wait: fast })
  assert.equal(taken.port, 55432)
})

test('pgNames: a renamed container gets its own compose project; container and volume are renamed together', () => {
  assert.equal(pgNames().project, 'work-console')
  const t = pgNames({ container: 'work-console-postgres-test', volume: 'work-console-pg-test' })
  assert.equal(t.project, 'work-console-postgres-test')
  assert.equal(pgNames({ container: 'c', volume: 'v', project: 'p' }).project, 'p')
  assert.throws(() => pgNames({ container: 'c-test' }), /together/)
  assert.throws(() => pgNames({ volume: 'v-test' }), /together/)
})

test('envNames reads WORK_CONSOLE_PG_CONTAINER and WORK_CONSOLE_PG_VOLUME', () => {
  assert.deepEqual(envNames({}), {})
  assert.deepEqual(envNames({ WORK_CONSOLE_PG_CONTAINER: 'c-test', WORK_CONSOLE_PG_VOLUME: 'v-test' }), { container: 'c-test', volume: 'v-test' })
})

test('pgDown removes only a renamed project', () => {
  const d = fake([])
  assert.throws(() => pgDown({ docker: d }), /default/)
  assert.equal(d.calls.length, 0)
  pgDown({ docker: d, names: { container: 'c-test', volume: 'v-test' } })
  assert.deepEqual(d.calls[0].args.slice(0, 3), ['compose', '-p', 'c-test'])
  assert.equal(d.calls[0].env?.WORK_CONSOLE_PG_VOLUME, 'v-test')
})

test('compose gets the password file, container and volume through env, never argv', async () => {
  const home = tmp()
  const d = fake([select1])
  const r = await postgres({ home, docker: d, names: { container: 'c-test', volume: 'v-test' }, free: allFree, wait: fast })
  const up = upOf(d)
  assert.equal(up.env?.WORK_CONSOLE_PG_PASSWORD_FILE, r.passwordPath)
  assert.equal(up.env?.WORK_CONSOLE_PG_CONTAINER, 'c-test')
  assert.equal(up.env?.WORK_CONSOLE_PG_VOLUME, 'v-test')
  assert.deepEqual(up.args.slice(0, 3), ['compose', '-p', 'c-test'])
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

test('live: a -test container comes up on a port no other container publishes, keeps it, and goes away with its volume', { skip: process.env.WORK_CONSOLE_LIVE_DOCKER !== '1' && 'set WORK_CONSOLE_LIVE_DOCKER=1 to start a real container' }, async () => {
  const docker = dockerRunner()
  const names = { container: 'work-console-postgres-test', volume: 'work-console-pg-test' }
  const others = containers(docker).filter((c) => c.name !== names.container).flatMap((c) => c.ports)
  const home = tmp()
  const lines: string[] = []
  try {
    const r = await postgres({ home, docker, names, log: (l) => lines.push(l) })
    assert.ok(r.port >= 55432 && !others.includes(r.port), `port ${r.port} is no other container's`)
    const mine = containers(docker).find((c) => c.name === names.container)
    assert.deepEqual(mine?.ports, [r.port], 'docker ps says the container publishes it')
    const again = await postgres({ home, docker, names, log: (l) => lines.push(l) })
    assert.equal(again.port, r.port, 'a second run keeps the port')
    console.log(lines.join('\n'))
  } finally {
    pgDown({ docker, names, passwordPath: join(home, 'postgres.password') })
  }
  assert.equal(docker(['ps', '-aq', '--filter', `name=^${names.container}$`]).stdout.trim(), '', 'the container is gone')
  assert.equal(docker(['volume', 'ls', '-q', '--filter', `name=^${names.volume}$`]).stdout.trim(), '', 'the volume is gone')
})
