import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { alive } from './lib.mjs'
import { RESTART, backoff, requestRestart, stopConsole, supervise, supervisorOf, waitUp } from './run.mjs'

/* run.mjs with a stand-in server: a script that counts its starts in a file, exits with the codes it is given
   and then stays up until it is killed. */

const made: string[] = [], edges: number[] = []
after(() => {
  for (const pid of edges) if (alive(pid)) process.kill(pid)
  for (const d of made) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'wc-run-')); made.push(d); return d }
/** a console home whose port answers nothing, so no request reaches a real console */
const homeDir = () => { const d = tmp(); writeFileSync(join(d, 'config.json'), JSON.stringify({ loopbackPort: 1 })); return d }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(what: string, ok: () => boolean, ms = 10000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) if (ok()) return
  throw new Error(`timed out waiting for ${what}`)
}

/** a server stand-in: start n exits with codes[n], past the list it stays up */
function standIn(codes: number[]) {
  const dir = tmp(), count = join(dir, 'count')
  writeFileSync(join(dir, 'server.mjs'), `
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
const n = existsSync(${JSON.stringify(count)}) ? readFileSync(${JSON.stringify(count)}, 'utf8').split('\\n').filter(Boolean).length : 0
appendFileSync(${JSON.stringify(count)}, Date.now() + '\\n')
console.log('server start ' + n + ' home ' + process.env.WORK_CONSOLE_HOME)
const codes = ${JSON.stringify(codes)}
if (n < codes.length) process.exit(codes[n])
setInterval(() => {}, 1000)
`)
  const starts = () => (existsSync(count) ? readFileSync(count, 'utf8').split('\n').filter(Boolean).map(Number) : [])
  return { dir, cmd: [process.execPath, join(dir, 'server.mjs')], starts }
}

/** the stand-in Edge of the launcher tests on <home>/browser, up once its port file is written */
async function fakeEdge(home: string) {
  const dir = join(home, 'browser')
  mkdirSync(dir, { recursive: true })
  const c = spawn(process.execPath, [join(import.meta.dirname, '..', 'server', 'browser', 'fake-edge.mjs'), `--user-data-dir=${dir}`], { stdio: 'ignore', detached: true })
  c.unref(); edges.push(c.pid!)
  await until('the fake Edge', () => existsSync(join(dir, 'DevToolsActivePort')))
  const f = join(dir, 'fake-edge-closes.jsonl')
  return { dir, pid: c.pid!, closes: () => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').length : 0) }
}

test('backoff doubles from 1 s and stops at 60 s', () => {
  assert.deepEqual([1, 2, 3, 6, 7, 20].map(backoff), [1000, 2000, 4000, 32000, 60000, 60000])
  assert.equal(RESTART, 75)
})

test('exit 75 restarts at once; another exit waits the backoff', async () => {
  const home = homeDir(), s = standIn([RESTART, 3])
  const sup = supervise({ folder: s.dir, home, cmd: s.cmd, backoff: () => 400 })
  try {
    await until('the third start', () => s.starts().length === 3)
    const log = readFileSync(join(home, 'logs', 'console.log'), 'utf8')
    assert.match(log, /exited with 75; restarting now/)
    assert.match(log, /exited with 3; restarting in 0\.4 s/)
    // the gap from an exit to the next start, from the supervisor's own lines: node's startup time is not in it
    const lines = log.split('\n').flatMap((l) => { const m = /^\[([^\]]+)\] (.*)$/.exec(l); return m ? [{ t: Date.parse(m[1]), s: m[2] }] : [] })
    const gap = (exit: string) => { const i = lines.findIndex((l) => l.s.startsWith(exit)); return lines.slice(i).find((l) => l.s === 'starting')!.t - lines[i].t }
    assert.ok(gap('exited with 75') < 400, `75 restarted after ${gap('exited with 75')} ms`)
    assert.ok(gap('exited with 3') >= 400, `3 restarted after ${gap('exited with 3')} ms`)
  } finally { await sup.stop() }
})

test('a restart request ends the server and starts it again at once', async () => {
  const home = homeDir(), s = standIn([])
  const sup = supervise({ folder: s.dir, home, cmd: s.cmd, backoff: () => 60000 })
  try {
    await until('the first start', () => s.starts().length === 1 && !!supervisorOf(home)?.server)
    const first = supervisorOf(home)!.server!
    assert.equal(await requestRestart(home), true)
    await until('the second start', () => s.starts().length === 2)
    await until('the new server in run.json', () => !!supervisorOf(home)?.server && supervisorOf(home)!.server !== first)
    assert.equal(alive(first), false)
    assert.equal(existsSync(join(home, 'restart')), false, 'the request is consumed')
  } finally { await sup.stop() }
})

test('run.json names the supervisor and the server; a second supervisor refuses; stop clears it', async () => {
  const home = homeDir(), s = standIn([])
  const sup = supervise({ folder: s.dir, home, cmd: s.cmd })
  await until('the server', () => !!supervisorOf(home)?.server)
  const st = supervisorOf(home)!
  assert.equal(st.pid, process.pid)
  assert.equal(st.folder, s.dir)
  assert.equal(alive(st.server), true)
  assert.throws(() => supervise({ folder: s.dir, home, cmd: s.cmd }), /already runs/)
  await sup.stop()
  assert.equal(alive(st.server), false)
  assert.equal(supervisorOf(home), null)
  assert.equal(existsSync(join(home, 'run.json')), false)
})

test('the server gets WORK_CONSOLE_HOME, and its output and the supervisor lines go to <home>/logs/console.log', async () => {
  const home = homeDir(), s = standIn([])
  const sup = supervise({ folder: s.dir, home, cmd: s.cmd })
  try {
    await until('the output', () => existsSync(join(home, 'logs', 'console.log')) && /server start 0/.test(readFileSync(join(home, 'logs', 'console.log'), 'utf8')))
    const log = readFileSync(join(home, 'logs', 'console.log'), 'utf8')
    assert.match(log, /\] starting/)
    assert.ok(log.includes(`home ${home}`))
  } finally { await sup.stop() }
})

test('stopConsole ends a supervisor in another process and its server, then closes their Edge', async () => {
  const home = homeDir(), edge = await fakeEdge(home)
  const keep = [process.execPath, '-e', 'setInterval(() => {}, 1000)']
  const a = spawn(keep[0], keep.slice(1), { stdio: 'ignore' }), b = spawn(keep[0], keep.slice(1), { stdio: 'ignore' })
  writeFileSync(join(home, 'run.json'), JSON.stringify({ pid: a.pid, server: b.pid, folder: home, port: 1 }))
  assert.equal(await stopConsole(home), true)
  assert.ok(!alive(a.pid) && !alive(b.pid))
  assert.equal(existsSync(join(home, 'run.json')), false)
  assert.equal(edge.closes(), 1, 'the Edge was not asked to close')
  assert.equal(existsSync(join(edge.dir, 'lockfile')), false, 'stop returned while the Edge held its profile')
  assert.equal(await stopConsole(home), false)
})

test('a restart request leaves the Edge running for the next server; stopping the supervisor closes it', async () => {
  const home = homeDir(), s = standIn([]), edge = await fakeEdge(home)
  const sup = supervise({ folder: s.dir, home, cmd: s.cmd, backoff: () => 60000 })
  try {
    await until('the first start', () => s.starts().length === 1 && !!supervisorOf(home)?.server)
    assert.equal(await requestRestart(home), true)
    await until('the second start', () => s.starts().length === 2)
    assert.equal(edge.closes(), 0)
    assert.ok(alive(edge.pid))
  } finally { await sup.stop() }
  assert.equal(edge.closes(), 1)
  assert.equal(existsSync(join(edge.dir, 'lockfile')), false)
})

test('waitUp resolves once /api/state answers and names the log when nothing does', async () => {
  const srv = createServer((req, res) => { res.statusCode = req.url === '/api/state' ? 200 : 404; res.end('{}') })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const port = (srv.address() as { port: number }).port
  try { assert.equal(await waitUp({ port, home: 'H', timeoutMs: 2000 }), `http://127.0.0.1:${port}/`) } finally { srv.close() }
  await assert.rejects(waitUp({ port, home: 'H', timeoutMs: 300 }), /did not answer.*console\.log/)
})
