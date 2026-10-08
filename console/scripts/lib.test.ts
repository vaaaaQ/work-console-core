import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { alive, consoleHome, firstFree, gitId, isFree, npmChecks, readJson, writeJson, type Ran } from './lib.mjs'
import { tempDir } from '../server/testdirs.ts'

const tmp = () => tempDir('lib')
const ok = (stdout = ''): Ran => ({ status: 0, stdout, stderr: '' })
const bad = (stderr: string): Ran => ({ status: 1, stdout: '', stderr })

test('consoleHome is WORK_CONSOLE_HOME, else ~/.work-console', () => {
  assert.equal(consoleHome({ WORK_CONSOLE_HOME: 'X:/h' }), 'X:/h')
  assert.equal(consoleHome({}), join(homedir(), '.work-console'))
})

test('writeJson then readJson round-trips; a missing file gives the fallback', () => {
  const f = join(tmp(), 'deep', 'a.json')
  assert.deepEqual(readJson(f, { none: 1 }), { none: 1 })
  writeJson(f, { port: 7412 })
  assert.deepEqual(readJson(f, null), { port: 7412 })
})

test('readJson names the file when it is not JSON', () => {
  const f = join(tmp(), 'config.json')
  writeFileSync(f, '{ broken')
  assert.throws(() => readJson(f, {}), /config\.json/)
})

test('firstFree skips taken and busy ports', async () => {
  const busy = new Set([55433])
  assert.equal(await firstFree(55432, { taken: new Set([55432]), free: async (p) => !busy.has(p) }), 55434)
})

test('firstFree gives up after the limit', async () => {
  await assert.rejects(firstFree(7410, { free: async () => false, limit: 3 }), /7410.*7412/)
})

test('isFree sees a listening socket and its release', async () => {
  const s = createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const port = (s.address() as { port: number }).port
  assert.equal(await isFree(port), false)
  await new Promise((r) => s.close(r))
  assert.equal(await isFree(port), true)
})

test('alive is true for this process and false for nonsense', () => {
  assert.equal(alive(process.pid), true)
  assert.equal(alive(undefined), false)
  assert.equal(alive(-1), false)
})

test('gitId is empty when git has an identity, else a local one', () => {
  assert.deepEqual(gitId('.', () => ok('me@example.test\n')), [])
  assert.deepEqual(gitId('.', () => bad('')), ['-c', 'user.name=Work Console', '-c', 'user.email=work-console@localhost'])
})

test('npmChecks runs ci, typecheck, tests and the build in order', () => {
  const calls: string[] = []
  const r = npmChecks('F', { build: true, run: (c, a, o) => { calls.push(`${c} ${a.join(' ')} @${o?.cwd}`); return ok() } })
  assert.deepEqual(calls, ['npm ci @F', 'npm run typecheck @F', 'npm test @F', 'npm run build @F'])
  assert.equal(r.ok, true)
})

test('npmChecks retries the tests once', () => {
  const calls: string[] = []
  let tests = 0
  const r = npmChecks('F', { run: (_c, a) => { calls.push(a.join(' ')); return a[0] === 'test' && ++tests === 1 ? bad('flake') : ok() } })
  assert.deepEqual(calls, ['ci', 'run typecheck', 'test', 'test'])
  assert.equal(r.ok, true)
})

test('npmChecks stops at the failing step and keeps its output tail', () => {
  const calls: string[] = []
  const lines = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n')
  const r = npmChecks('F', { run: (_c, a) => { calls.push(a.join(' ')); return a[1] === 'typecheck' ? { status: 2, stdout: lines, stderr: 'TS2322 boom' } : ok() } })
  assert.deepEqual(calls, ['ci', 'run typecheck'])
  assert.equal(r.ok, false)
  assert.equal(r.step, 'typecheck')
  assert.match(r.output!, /TS2322 boom/)
  assert.doesNotMatch(r.output!, /line 0\n/)
  assert.match(r.output!, /line 299/)
})
