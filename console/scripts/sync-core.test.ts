import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hash, sync } from './sync-core.mjs'

/* sync-core.mjs against throwaway git repos under the OS temp dir: a "core" with a console/ and a "consumer"
   console dir. Git runs with autocrlf off and a local identity, so a CRLF checkout cannot change what is committed. */

const SCRIPT = fileURLToPath(new URL('./sync-core.mjs', import.meta.url))
const made: string[] = []
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }) })

const tmp = (what: string) => { const d = mkdtempSync(join(tmpdir(), `wc-sync-${what}-`)); made.push(d); return d }
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', '-c', 'user.name=Sync Test', '-c', 'user.email=sync@example.test', ...args],
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const read = (dir: string, p: string) => readFileSync(join(dir, p), 'utf8')
const put = (dir: string, p: string, body: string | Buffer) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), body) }
const lockOf = (to: string) => JSON.parse(read(to, 'core.lock.json')) as { core: string; files: Record<string, string> }

/** commits `files` (null deletes) under console/ of the core and returns the new commit */
function commit(core: string, files: Record<string, string | Buffer | null>) {
  for (const [p, body] of Object.entries(files)) {
    if (body === null) rmSync(join(core, 'console', p))
    else put(join(core, 'console'), p, body)
  }
  git(core, 'add', '-A')
  git(core, 'commit', '-q', '-m', 'core change')
  return git(core, 'rev-parse', 'HEAD')
}
const A1 = 'export const a = 1\n'
function makeCore(extra: Record<string, string | Buffer> = {}) {
  const core = tmp('core')
  git(core, 'init', '-q')
  commit(core, { 'package.json': '{}\n', 'src/a.ts': A1, 'server/b.ts': 'export const b = 1\n', 'workspaces/page.ts': 'export const WORKSPACES = []\n', ...extra })
  return core
}
const makeTo = () => join(tmp('consumer'), 'console')
const quiet = () => ({ lines: [] as string[], log(l: string) { this.lines.push(l) } })

test('a first sync writes the core files and the lock, and leaves the registries alone', () => {
  const core = makeCore(), to = makeTo(), l = quiet()
  put(to, 'workspaces/page.ts', 'mine\n')
  put(to, 'workspaces/mine/page.ts', 'mine too\n')
  const r = sync({ core, to, log: (x) => l.log(x) })
  assert.equal(r.sha, git(core, 'rev-parse', 'HEAD'))
  assert.equal(read(to, 'src/a.ts'), A1)
  assert.equal(read(to, 'server/b.ts'), 'export const b = 1\n')
  assert.equal(read(to, 'workspaces/page.ts'), 'mine\n')
  assert.equal(read(to, 'workspaces/mine/page.ts'), 'mine too\n')
  const text = read(to, 'core.lock.json')
  assert.ok(text.startsWith('{\n  "core": "') && text.endsWith('}\n'), 'two-space JSON with a trailing newline')
  const lock = lockOf(to)
  assert.equal(lock.core, r.sha)
  assert.deepEqual(Object.keys(lock.files), ['package.json', 'server/b.ts', 'src/a.ts'])
  assert.equal(lock.files['src/a.ts'], hash(Buffer.from(A1)))
  assert.deepEqual(r.written, ['package.json', 'server/b.ts', 'src/a.ts'])
  assert.deepEqual(r.deleted, [])
  assert.ok(l.lines.some((x) => /first sync.*0 existing files/.test(x)), l.lines.join('\n'))
})

test('a first sync names how many existing files it replaces, and does not refuse them', () => {
  const core = makeCore(), to = makeTo(), l = quiet()
  put(to, 'src/a.ts', 'something else\n')
  sync({ core, to, log: (x) => l.log(x) })
  assert.equal(read(to, 'src/a.ts'), A1)
  assert.ok(l.lines.some((x) => /first sync.*1 existing file\b/.test(x)), l.lines.join('\n'))
})

test('a second sync deletes what the core dropped and keeps the consumer\'s own files', () => {
  const core = makeCore(), to = makeTo()
  sync({ core, to, log() {} })
  put(to, 'workspaces/mine/page.ts', 'mine\n')
  const sha = commit(core, { 'server/b.ts': null, 'src/c.ts': 'export const c = 1\n' })
  const r = sync({ core, to, log() {} })
  assert.equal(r.sha, sha)
  assert.deepEqual(r.deleted, ['server/b.ts'])
  assert.ok(!existsSync(join(to, 'server/b.ts')) && !existsSync(join(to, 'server')), 'the file and its emptied directory are gone')
  assert.equal(read(to, 'src/c.ts'), 'export const c = 1\n')
  assert.equal(read(to, 'workspaces/mine/page.ts'), 'mine\n')
  assert.deepEqual(Object.keys(lockOf(to).files), ['package.json', 'src/a.ts', 'src/c.ts'])
})

test('a core file edited in the consumer stops the sync, which names it and writes nothing', () => {
  const core = makeCore(), to = makeTo()
  sync({ core, to, log() {} })
  commit(core, { 'src/c.ts': 'export const c = 1\n' })
  put(to, 'src/a.ts', 'export const a = 2\n')
  assert.throws(() => sync({ core, to, log() {} }), (e: Error) =>
    e.message === 'core-owned files differ from core.lock.json; change them in the core (or pass --force): src/a.ts')
  assert.equal(read(to, 'src/a.ts'), 'export const a = 2\n')
  assert.ok(!existsSync(join(to, 'src/c.ts')), 'a refused sync writes no file')
})

test('the same file rewritten with CRLF only is not an edit', () => {
  const core = makeCore({ 'src/multi.ts': 'one\ntwo\nthree\n' }), to = makeTo()
  sync({ core, to, log() {} })
  put(to, 'src/multi.ts', 'one\r\ntwo\r\nthree\r\n')
  const sha = commit(core, { 'src/c.ts': 'export const c = 1\n' })
  assert.equal(sync({ core, to, log() {} }).sha, sha)
  assert.equal(lockOf(to).files['src/multi.ts'], hash(Buffer.from('one\ntwo\nthree\n')))
})

test('a consumer file the sync would overwrite but the lock does not list stops it', () => {
  const core = makeCore(), to = makeTo()
  sync({ core, to, log() {} })
  commit(core, { 'src/new.ts': 'from the core\n' })
  put(to, 'src/new.ts', 'from the consumer\n')
  assert.throws(() => sync({ core, to, log() {} }), (e: Error) => e.message.endsWith(': src/new.ts'))
  put(to, 'src/new.ts', 'from the core\n')
  sync({ core, to, log() {} })   // already what the core has: nothing to lose
  assert.ok('src/new.ts' in lockOf(to).files)
})

test('--force overwrites an edited file and a file the lock does not list', () => {
  const core = makeCore(), to = makeTo()
  sync({ core, to, log() {} })
  commit(core, { 'src/new.ts': 'from the core\n' })
  put(to, 'src/a.ts', 'edited\n')
  put(to, 'src/new.ts', 'from the consumer\n')
  sync({ core, to, force: true, log() {} })
  assert.equal(read(to, 'src/a.ts'), A1)
  assert.equal(read(to, 'src/new.ts'), 'from the core\n')
})

test('--ref syncs that commit of the core, not its working tree', () => {
  const core = makeCore(), first = git(core, 'rev-parse', 'HEAD'), to = makeTo()
  commit(core, { 'src/a.ts': 'export const a = 2\n' })
  put(core, 'console/src/a.ts', 'uncommitted\n')
  sync({ core, to, rev: first, log() {} })
  assert.equal(read(to, 'src/a.ts'), A1)
  assert.equal(lockOf(to).core, first)
  sync({ core, to, log() {} })
  assert.equal(read(to, 'src/a.ts'), 'export const a = 2\n')
})

test('bytes survive intact: binary, newlines inside, an empty file, a name with spaces', () => {
  const bin = Buffer.from([0, 255, 10, 13, 10, 10, 0x41, 13, 0, 128])
  const core = makeCore({ 'public/x.bin': bin, 'public/empty.txt': '', 'public/with space.txt': 'a\n\nb\n' }), to = makeTo()
  sync({ core, to, log() {} })
  assert.ok(readFileSync(join(to, 'public/x.bin')).equals(bin))
  assert.equal(read(to, 'public/empty.txt'), '')
  assert.equal(read(to, 'public/with space.txt'), 'a\n\nb\n')
})

test('the core itself is not a place to sync into', () => {
  const core = makeCore()
  assert.throws(() => sync({ core, to: join(core, 'console'), log() {} }), /core itself/)
  assert.ok(!existsSync(join(core, 'console/core.lock.json')))
})

test('hash ignores a CRLF but not a lone CR', () => {
  assert.equal(hash(Buffer.from('a\r\nb')), hash(Buffer.from('a\nb')))
  assert.equal(hash(Buffer.from('a\r\n\r\nb\r\n')), hash(Buffer.from('a\n\nb\n')))
  assert.notEqual(hash(Buffer.from('a\rb')), hash(Buffer.from('a\nb')))
  assert.equal(hash(Buffer.from('')), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
})

test('the command line syncs, refuses with a message and exit 1, and takes --force', () => {
  const core = tmp('cli-core')
  git(core, 'init', '-q')
  commit(core, { 'src/a.ts': A1, 'scripts/sync-core.mjs': readFileSync(SCRIPT) })
  const to = makeTo(), run = (...args: string[]) => spawnSync(process.execPath, [join(core, 'console/scripts/sync-core.mjs'), ...args], { encoding: 'utf8' })
  const ok = run('--to', to)
  assert.equal(ok.status, 0, ok.stderr)
  assert.equal(read(to, 'src/a.ts'), A1)
  put(to, 'src/a.ts', 'edited\n')
  const refused = run('--to', to)
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /core-owned files differ from core\.lock\.json.*src\/a\.ts/)
  assert.equal(run('--to', to, '--force').status, 0)
  assert.equal(read(to, 'src/a.ts'), A1)
  const usage = run()
  assert.equal(usage.status, 1)
  assert.match(usage.stderr, /--to/)
})
