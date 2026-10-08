import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { drift, hash, inside, isCoreLayout, prune, sync } from './sync-core.mjs'

/* sync-core.mjs against throwaway git repos under the OS temp dir: a "core" with a console/ and a "consumer"
   console dir. Git runs with autocrlf off and a local identity, so a CRLF checkout cannot change what is committed. */

const SCRIPT = fileURLToPath(new URL('./sync-core.mjs', import.meta.url))
const made: string[] = []
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }) })

const tmp = (what: string) => { const d = mkdtempSync(join(tmpdir(), `wc-sync-${what}-`)); made.push(d); return d }
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', '-c', 'user.name=Sync Test', '-c', 'user.email=sync@example.test', ...args],
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const plumb = (cwd: string, args: string[], input: string) => execFileSync('git', ['-C', cwd, ...args], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
const read = (dir: string, p: string) => readFileSync(join(dir, p), 'utf8')
const put = (dir: string, p: string, body: string | Buffer) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), body) }
const lockOf = (to: string) => JSON.parse(read(to, 'core.lock.json')) as { core: string; files: Record<string, string> }
const keysOf = (to: string) => Object.keys(lockOf(to).files)

/** commits `files` (null deletes) under console/ of the core and returns the new commit */
function commit(core: string, files: Record<string, string | Buffer | null>) {
  for (const [p, body] of Object.entries(files)) {
    if (body === null) {
      git(core, 'rm', '-q', '--cached', '--', `console/${p}`)
      rmSync(join(core, 'console', p))
      // an emptied directory must go too: on a case-insensitive disk it would keep its old spelling
      try { for (let d = dirname(join(core, 'console', p)); d !== join(core, 'console'); d = dirname(d)) rmdirSync(d) } catch { /* not empty */ }
    }
    else put(join(core, 'console'), p, body)
  }
  git(core, 'add', '-A')
  git(core, 'commit', '-q', '-m', 'core change')
  return git(core, 'rev-parse', 'HEAD')
}
const A1 = 'export const a = 1\n'
const ACME = 'export const acme = 1\n'
function makeCore(extra: Record<string, string | Buffer> = {}) {
  const core = tmp('core')
  git(core, 'init', '-q')
  commit(core, {
    'package.json': '{}\n', 'src/a.ts': A1, 'server/b.ts': 'export const b = 1\n',
    'workspaces/page.ts': 'export const WORKSPACES = []\n', 'workspaces/server.ts': 'export const SERVERS = []\n',
    'workspaces/acme/page.ts': ACME, 'tools/x.ts': 'export const x = 1\n', ...extra,
  })
  return core
}
/** a consumer console dir as the docs say to prepare it: both registries written before the first sync */
function makeTo() {
  const to = join(tmp('consumer'), 'console')
  put(to, 'workspaces/page.ts', 'export const WORKSPACES = [mine]\n')
  put(to, 'workspaces/server.ts', 'export const SERVERS = [mine]\n')
  return to
}
/** a consumer that is a git repo and has been synced once, for the drift checks */
function vendored(extra: Record<string, string | Buffer> = {}) {
  const core = makeCore(extra), to = makeTo()
  git(dirname(to), 'init', '-q')
  sync({ core, to, log() {} })
  return { core, to }
}
const quiet = () => ({ lines: [] as string[], log(l: string) { this.lines.push(l) } })

type Node = { [name: string]: string | Node }
/** a tree built with plumbing, so it may hold names `git add` would refuse */
function treeOf(core: string, node: Node): string {
  const recs = Object.entries(node).map(([name, v]) => typeof v === 'string'
    ? `100644 blob ${plumb(core, ['hash-object', '-w', '--stdin'], v)}\t${name}\0`
    : `040000 tree ${treeOf(core, v)}\t${name}\0`)
  return plumb(core, ['mktree', '-z'], recs.join(''))
}
const hostile = (core: string, consoleTree: Node) => git(core, 'commit-tree', '-m', 'hostile', treeOf(core, { console: consoleTree }))

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
  assert.deepEqual(Object.keys(lock.files), ['package.json', 'server/b.ts', 'src/a.ts', 'workspaces/acme/page.ts'])
  assert.equal(lock.files['src/a.ts'], hash(Buffer.from(A1)))
  assert.deepEqual(r.written, ['package.json', 'server/b.ts', 'src/a.ts', 'workspaces/acme/page.ts'])
  assert.deepEqual(r.deleted, [])
  assert.ok(l.lines.some((x) => /first sync.*0 existing files/.test(x)), l.lines.join('\n'))
})

test('the ownership boundary: tools/ and both registries stay the consumer\'s, an example workspace ships', () => {
  const core = makeCore(), to = makeTo()
  const r = sync({ core, to, log() {} })
  assert.ok(!existsSync(join(to, 'tools/x.ts')), 'tools/ is not written')
  assert.equal(read(to, 'workspaces/server.ts'), 'export const SERVERS = [mine]\n')
  assert.equal(read(to, 'workspaces/page.ts'), 'export const WORKSPACES = [mine]\n')
  const keys = keysOf(to)
  for (const own of ['tools/x.ts', 'workspaces/server.ts', 'workspaces/page.ts']) {
    assert.ok(!keys.includes(own) && !r.written.includes(own), `${own} is not locked or written`)
  }
  assert.equal(read(to, 'workspaces/acme/page.ts'), ACME, 'an example workspace is core-owned and ships')
  assert.ok(keys.includes('workspaces/acme/page.ts') && r.written.includes('workspaces/acme/page.ts'))
})

test('a consumer-only workspace and tools/ file survive a sync whose old lock did not list them, and --force', () => {
  const core = makeCore(), to = makeTo()
  sync({ core, to, log() {} })
  put(to, 'workspaces/own/page.ts', 'own\n')
  put(to, 'tools/own.ts', 'own\n')
  commit(core, { 'src/c.ts': 'export const c = 1\n' })
  sync({ core, to, log() {} })
  assert.equal(read(to, 'workspaces/own/page.ts'), 'own\n')
  assert.equal(read(to, 'tools/own.ts'), 'own\n')
  commit(core, { 'src/d.ts': 'export const d = 1\n' })
  sync({ core, to, force: true, log() {} })
  assert.equal(read(to, 'workspaces/own/page.ts'), 'own\n')
  assert.equal(read(to, 'tools/own.ts'), 'own\n')
  assert.ok(!keysOf(to).includes('workspaces/own/page.ts'))
})

test('an old lock that lists a registry or tools/ never makes the sync delete or refuse them', () => {
  const core = makeCore(), to = makeTo()
  sync({ core, to, log() {} })
  put(to, 'tools/x.ts', 'mine\n')
  const withOwn = () => writeFileSync(join(to, 'core.lock.json'), JSON.stringify({ core: 'old', files: { ...lockOf(to).files, 'workspaces/page.ts': 'ab', 'workspaces/server.ts': 'cd', 'tools/x.ts': 'ef' } }))
  for (const force of [false, true]) {
    withOwn()
    const r = sync({ core, to, force, log() {} })
    assert.deepEqual(r.deleted, [])
    assert.equal(read(to, 'tools/x.ts'), 'mine\n')
    assert.equal(read(to, 'workspaces/page.ts'), 'export const WORKSPACES = [mine]\n')
    assert.equal(read(to, 'workspaces/server.ts'), 'export const SERVERS = [mine]\n')
    assert.ok(!keysOf(to).some((k) => k.startsWith('tools/') || k === 'workspaces/page.ts' || k === 'workspaces/server.ts'))
  }
})

test('a first sync counts only the existing files that differ from the core, and does not refuse them', () => {
  const core = makeCore(), to = makeTo(), l = quiet()
  put(to, 'src/a.ts', 'something else\n')
  put(to, 'package.json', '{}\n')   // the same as the core's: nothing is replaced
  sync({ core, to, log: (x) => l.log(x) })
  assert.equal(read(to, 'src/a.ts'), A1)
  assert.ok(l.lines.some((x) => /first sync.*\b1 existing file\b/.test(x)), l.lines.join('\n'))
})

test('a first sync into a dir without both registries is refused and writes nothing', () => {
  const core = makeCore(), msg = (to: string) => `${to} is not a consumer console dir: write workspaces/page.ts and workspaces/server.ts first`
  const none = join(tmp('consumer'), 'console')
  assert.throws(() => sync({ core, to: none, log() {} }), (e: Error) => e.message === msg(none))
  assert.ok(!existsSync(none), 'not even the dir is created')
  const onlyPage = join(tmp('consumer'), 'console')
  put(onlyPage, 'workspaces/page.ts', 'mine\n')
  assert.throws(() => sync({ core, to: onlyPage, log() {} }), (e: Error) => e.message === msg(onlyPage))
  assert.deepEqual(readdirSync(onlyPage), ['workspaces'])
  assert.deepEqual(readdirSync(join(onlyPage, 'workspaces')), ['page.ts'])
  const onlyServer = join(tmp('consumer'), 'console')
  put(onlyServer, 'workspaces/server.ts', 'mine\n')
  assert.throws(() => sync({ core, to: onlyServer, log() {} }), (e: Error) => e.message === msg(onlyServer))
})

test('a registry that disappears stops the next sync too, lock or not', () => {
  const core = makeCore(), to = makeTo()
  sync({ core, to, log() {} })
  rmSync(join(to, 'workspaces/server.ts'))
  commit(core, { 'src/c.ts': 'export const c = 1\n' })
  assert.throws(() => sync({ core, to, log() {} }), /is not a consumer console dir/)
  assert.throws(() => sync({ core, to, force: true, log() {} }), /is not a consumer console dir/)
  assert.ok(!existsSync(join(to, 'src/c.ts')))
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
  assert.deepEqual(keysOf(to), ['package.json', 'src/a.ts', 'src/c.ts', 'workspaces/acme/page.ts'])
})

for (const [what, before, after] of [['with the same content', 'same\n', 'same\n'], ['with new content', 'old\n', 'new\n']] as const) {
  test(`a core file renamed only in case, ${what}, is rewritten, not deleted or refused`, () => {
    const core = makeCore({ 'src/Foo.ts': before }), to = makeTo()
    sync({ core, to, log() {} })
    const sha = commit(core, { 'src/Foo.ts': null, 'src/foo.ts': after })
    assert.deepEqual(git(core, 'ls-tree', '-r', '--name-only', sha, 'console/src').split('\n'), ['console/src/a.ts', 'console/src/foo.ts'], 'the core really renamed it')
    const r = sync({ core, to, log() {} })
    assert.equal(r.sha, sha)
    assert.deepEqual(readdirSync(join(to, 'src')).sort(), ['a.ts', 'foo.ts'])
    assert.equal(read(to, 'src/foo.ts'), after)
    assert.ok(keysOf(to).includes('src/foo.ts') && !keysOf(to).includes('src/Foo.ts'), keysOf(to).join())
  })
}

test('a directory renamed only in case keeps all its files', () => {
  const core = makeCore({ 'Lib/one.ts': '1\n', 'Lib/two.ts': '2\n' }), to = makeTo()
  sync({ core, to, log() {} })
  const sha = commit(core, { 'Lib/one.ts': null, 'Lib/two.ts': null, 'lib/one.ts': '1\n', 'lib/two.ts': '22\n' })
  assert.deepEqual(git(core, 'ls-tree', '-r', '--name-only', sha, 'console/lib', 'console/Lib').split('\n'), ['console/lib/one.ts', 'console/lib/two.ts'], 'the core really renamed it')
  sync({ core, to, log() {} })
  assert.equal(read(to, 'lib/one.ts'), '1\n')
  assert.equal(read(to, 'lib/two.ts'), '22\n')
  assert.deepEqual(readdirSync(to).filter((d) => d.toLowerCase() === 'lib'), ['lib'])
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

test("the core's packs/ and schemas/ come along into the consumer's own packs/ and schemas/, locked like any core file", () => {
  const core = makeCore(), to = makeTo()
  put(core, 'packs/p/pack.json', '{"name":"p"}\n')
  put(core, 'packs/q/q.js', 'q\n')
  put(core, 'schemas/x.item.schema.json', '{}\n')
  git(core, 'add', '-A'); git(core, 'commit', '-q', '-m', 'packs')
  sync({ core, to, log: () => {} })
  assert.equal(read(to, 'packs/p/pack.json'), '{"name":"p"}\n')
  assert.equal(read(to, 'schemas/x.item.schema.json'), '{}\n')
  assert.ok(['packs/p/pack.json', 'packs/q/q.js', 'schemas/x.item.schema.json'].every((p) => keysOf(to).includes(p)))
  git(core, 'rm', '-q', '-r', 'packs/q'); git(core, 'commit', '-q', '-m', 'drop q')
  sync({ core, to, log: () => {} })
  assert.equal(existsSync(join(to, 'packs', 'q')), false, 'a pack the core dropped goes')
  assert.equal(read(to, 'src/a.ts'), A1)
})

test('a core whose console/ also has a packs/ or schemas/ file of the same path is refused', () => {
  const core = makeCore({ 'packs/p/pack.json': 'inner\n' }), to = makeTo()
  put(core, 'packs/p/pack.json', 'outer\n')
  git(core, 'add', '-A'); git(core, 'commit', '-q', '-m', 'both')
  assert.throws(() => sync({ core, to, log: () => {} }), /packs\/p\/pack\.json/)
  assert.equal(existsSync(join(to, 'core.lock.json')), false)
})

test("console/CLAUDE.md and console/AGENTS.md are core files: synced, locked, and an edit to them stops the sync", () => {
  const core = makeCore({ 'CLAUDE.md': 'read EXTENDING.md\n', 'AGENTS.md': 'read EXTENDING.md\n', 'EXTENDING.md': 'where things go\n' }), to = makeTo()
  sync({ core, to, log: () => {} })
  for (const p of ['CLAUDE.md', 'AGENTS.md', 'EXTENDING.md']) assert.ok(keysOf(to).includes(p), p)
  writeFileSync(join(to, 'CLAUDE.md'), 'my own rules\n')
  assert.throws(() => sync({ core, to, log: () => {} }), /CLAUDE\.md/)
})

test('inside accepts plain relative paths and rejects every way out', () => {
  const dest = resolve(tmp('inside'), 'console')
  for (const p of ['a.ts', 'src/a.ts', 'workspaces/acme/page.ts', 'public/with space.txt', 'a/b/c.d.e']) assert.ok(inside(dest, p), p)
  for (const p of ['', '.', '..', '../x', 'a/../b', 'a/..', 'a/./b', './a', '/abs', '//host/share/x', 'C:/x', 'C:x', 'a\\b', '..\\x', 'a//b', 'a/', 'src/a:stream']) assert.ok(!inside(dest, p), JSON.stringify(p))
  assert.ok(!inside(dest, '../console2/x') && !inside(dest, '../consolex'))
})

test('a lock key that leaves the console dir stops the sync before anything is touched', () => {
  const core = makeCore(), to = makeTo(), outside = join(dirname(to), 'outside.txt')
  put(dirname(to), 'outside.txt', 'keep me\n')
  for (const key of ['../outside.txt', '/etc/x', 'a/../../outside.txt']) {
    // the hash matches the file, so only the path check can stop the delete
    writeFileSync(join(to, 'core.lock.json'), JSON.stringify({ core: 'old', files: { [key]: hash(Buffer.from('keep me\n')) } }))
    for (const force of [false, true]) {
      assert.throws(() => sync({ core, to, force, log() {} }), (e: Error) => e.message.includes(key), `${key} force=${force}`)
      assert.equal(readFileSync(outside, 'utf8'), 'keep me\n')
      assert.ok(!existsSync(join(to, 'src/a.ts')), 'nothing is written')
    }
  }
})

test('a core tree with a path that leaves the console dir stops the whole sync, naming it', () => {
  const core = makeCore(), to = makeTo(), base = dirname(to)
  const cases: Array<[string, Node]> = [
    ['../escape.txt', { '..': { 'escape.txt': 'pwned\n' }, 'ok.txt': 'ok\n' }],
    ['..\\escape.txt', { '..\\escape.txt': 'pwned\n', 'ok.txt': 'ok\n' }],
    ['a:b.txt', { 'a:b.txt': 'stream\n', 'ok.txt': 'ok\n' }],
  ]
  for (const [path, tree] of cases) {
    const sha = hostile(core, tree)
    assert.throws(() => sync({ core, to, rev: sha, log() {} }), (e: Error) => e.message.endsWith(`: ${path}`), path)
    assert.ok(!existsSync(join(base, 'escape.txt')) && !existsSync(join(to, 'ok.txt')) && !existsSync(join(to, 'core.lock.json')), `${path}: nothing written`)
  }
})

test('prune stops at the console dir and never climbs into a sibling that shares its prefix', () => {
  const base = tmp('prune'), stop = join(base, 'console')
  mkdirSync(join(base, 'console-old/a/b'), { recursive: true })
  mkdirSync(join(stop, 'x/y'), { recursive: true })
  prune(join(base, 'console-old/a/b'), stop)
  assert.ok(existsSync(join(base, 'console-old/a/b')), 'a dir outside stop is left alone')
  prune(join(stop, 'x/y'), stop)
  assert.ok(existsSync(stop) && !existsSync(join(stop, 'x')), 'empty dirs under stop go, stop stays')
})

test('the core itself is not a place to sync into, however it is spelled', () => {
  const core = makeCore()
  assert.throws(() => sync({ core, to: join(core, 'console'), log() {} }), /core itself/)
  assert.throws(() => sync({ core, to: join(core, 'CONSOLE'), log() {} }), /core itself/)
  const link = join(tmp('link'), 'c')
  symlinkSync(join(core, 'console'), link, 'junction')
  assert.throws(() => sync({ core, to: link, log() {} }), /core itself/)
  assert.ok(!existsSync(join(core, 'console/core.lock.json')))
})

test('hash ignores a CRLF but not a lone CR', () => {
  assert.equal(hash(Buffer.from('a\r\nb')), hash(Buffer.from('a\nb')))
  assert.equal(hash(Buffer.from('a\r\n\r\nb\r\n')), hash(Buffer.from('a\n\nb\n')))
  assert.notEqual(hash(Buffer.from('a\rb')), hash(Buffer.from('a\nb')))
  assert.equal(hash(Buffer.from('')), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
})

test('drift is empty for a freshly synced repo that has its own files', () => {
  const { to } = vendored()
  put(to, 'workspaces/own/page.ts', 'own\n')
  put(to, 'tools/own.ts', 'own\n')
  put(to, 'dist/index.html', 'built\n')
  assert.deepEqual(drift(to), [])
})

test('drift names a missing lock, an edited, a missing and a stray file, and lets CRLF through', () => {
  const { to } = vendored({ 'src/multi.ts': 'one\ntwo\n' })
  put(to, 'src/multi.ts', 'one\r\ntwo\r\n')
  assert.deepEqual(drift(to), [], 'CRLF only')
  put(to, 'src/a.ts', 'edited\n')
  rmSync(join(to, 'server/b.ts'))
  put(to, 'src/stray.ts', 'stray\n')
  const problems = drift(to)
  assert.equal(problems.length, 3, problems.join('\n'))
  assert.ok(problems.some((x) => /differs.*src\/a\.ts.*change it in the core, then sync/.test(x)), problems.join('\n'))
  assert.ok(problems.some((x) => /missing.*server\/b\.ts/.test(x)), problems.join('\n'))
  assert.ok(problems.some((x) => /not from the core.*src\/stray\.ts/.test(x)), problems.join('\n'))
  rmSync(join(to, 'core.lock.json'))
  assert.deepEqual(drift(to), ['no core.lock.json: run sync-core'])
})

test('isCoreLayout means schemas/ and packs/ directories beside console/', () => {
  const root = tmp('layout'), c = join(root, 'console')
  mkdirSync(c)
  assert.equal(isCoreLayout(c), false)
  mkdirSync(join(root, 'schemas'))
  assert.equal(isCoreLayout(c), false)
  writeFileSync(join(root, 'packs'), 'a file, not a directory')
  assert.equal(isCoreLayout(c), false)
  rmSync(join(root, 'packs'))
  mkdirSync(join(root, 'packs'))
  assert.equal(isCoreLayout(c), true)
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
  const bare = run('--to', join(tmp('consumer'), 'console'))
  assert.equal(bare.status, 1)
  assert.match(bare.stderr, /is not a consumer console dir/)
  const usage = run()
  assert.equal(usage.status, 1)
  assert.match(usage.stderr, /--to/)
})
