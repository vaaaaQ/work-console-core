import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { realExec, Ops } from './ops.ts'
import { AgentTrees } from './trees.ts'
import type { Exec } from './ops.ts'
import { RESTART_EXIT } from '../restart.ts'
import { EMPTY_GRANTS } from '../grants.ts'
import { tempDir } from '../testdirs.ts'

/** a consumer folder under git: w1 with its grants, the registries, a core file, tools/ and a served build */
function repo() {
  const r = tempDir('ops')
  const put = (p: string, t: string | Buffer) => { mkdirSync(dirname(join(r, p)), { recursive: true }); writeFileSync(join(r, p), t) }
  put('.gitignore', 'node_modules/\ndist/\ndist.old/\n')
  put('workspaces/w1/page.ts', 'export const A = 1\n')
  put('workspaces/w1/grants.json', '{}\n')
  put('workspaces/w2/page.ts', 'export const B = 1\n')
  put('workspaces/page.ts', 'export const WORKSPACES = []\n')
  put('workspaces/server.ts', 'export const SERVERS = []\n')
  put('server/main.ts', 'core\n')
  put('tools/core-helper.ts', 'core\n')
  put('core.lock.json', JSON.stringify({ core: 'abc', files: { 'server/main.ts': 'x', 'tools/core-helper.ts': 'y' } }))
  put('dist/index.html', 'old build\n')
  const git = (...a: string[]) => execFileSync('git', a, { cwd: r, encoding: 'utf8' }).trim()
  git('init', '-q'); git('config', 'user.name', 't'); git('config', 'user.email', 't@x'); git('config', 'core.autocrlf', 'false')
  git('add', '-A'); git('commit', '-qm', 'init')
  return { r, put, git, read: (p: string) => readFileSync(join(r, p), 'utf8') }
}

/** npm, node --test and vite faked by name, git real; fail names the steps that exit 1; tests = the files of each test run */
function fakeExec(o: { fail?: string[]; failOnce?: string[]; during?: (step: string) => void } = {}) {
  const calls: string[] = [], tests: string[][] = [], where: string[] = []
  const exec: Exec = async (cmd, args, opt) => {
    if (cmd === 'git') return realExec(cmd, args, opt)
    where.push(opt.cwd)
    const step = cmd === 'npm' ? (args[0] === 'run' ? args[1] : args[0])
      : args.includes('--test') ? 'tests' : args.includes('build') ? 'build' : `${cmd} ${args.join(' ')}`
    calls.push(step)
    if (step === 'tests') tests.push(args.slice(args.indexOf('--test') + 1))
    o.during?.(step)
    if (o.fail?.includes(step)) return { code: 1, out: `${step} went wrong\nline two`, stdout: '' }
    if (o.failOnce?.includes(step) && calls.filter((c) => c === step).length === 1) return { code: 1, out: `${step} flaked`, stdout: '' }
    if (step === 'build') {
      const out = args[args.indexOf('--outDir') + 1]
      mkdirSync(out, { recursive: true }); writeFileSync(join(out, 'index.html'), 'new build\n')
    }
    return { code: 0, out: 'fine', stdout: 'fine' }
  }
  return { exec, calls, tests, where }
}

function ops(r: string, f: ReturnType<typeof fakeExec>) {
  let restarts = 0
  const o = new Ops({ root: r, exec: f.exec, restart: () => { restarts++ } })
  return { o, restarts: () => restarts }
}

test('RESTART_EXIT is 75', () => assert.equal(RESTART_EXIT, 75))

test('apply checks, builds, commits only its own files as `<ws>: <summary>` and asks for a restart', async () => {
  const { r, put, git, read } = repo(), f = fakeExec(), { o, restarts } = ops(r, f)
  put('workspaces/w1/page.ts', 'export const A = 2\n'); put('workspaces/w1/new/x.ts', 'export const X = 1\n'); put('tools/t.ts', 'export const T = 1\n')
  put('notes.txt', 'mine, not the agent\'s\n'); put('workspaces/w2/page.ts', 'export const B = 2\n')
  const a = await o.apply('w1', 'show the counter')
  assert.ok(a.ok, JSON.stringify(a))
  assert.deepEqual(f.calls, ['typecheck', 'tests', 'build'])
  assert.equal(git('log', '-1', '--format=%B'), 'w1: show the counter')
  assert.equal(a.sha, git('rev-parse', 'HEAD'))
  assert.deepEqual(a.files.sort(), ['tools/t.ts', 'workspaces/w1/new/x.ts', 'workspaces/w1/page.ts'])
  assert.deepEqual(git('show', '--name-only', '--format=', 'HEAD').split('\n').sort(), a.files)
  assert.match(git('status', '--porcelain'), /notes\.txt/, 'what is not its own stays uncommitted')
  assert.match(git('status', '--porcelain'), /workspaces\/w2\/page\.ts/)
  assert.equal(read('dist/index.html'), 'new build\n')
  assert.equal(existsSync(join(r, 'dist.old')), false)
  assert.equal(restarts(), 1)
})

test('realExec keeps stdout apart from what went to stderr', async () => {
  const r = await realExec(process.execPath, ['-e', "process.stdout.write('paths'); process.stderr.write('warning')"], { cwd: process.cwd() })
  assert.equal(r.stdout, 'paths')
  assert.match(r.out, /paths/); assert.match(r.out, /warning/)
})

test('a git warning on stderr (LF edits under core.autocrlf) is not read as a changed path', async () => {
  const { r, put, git } = repo(), { o } = ops(r, fakeExec())
  git('config', 'core.autocrlf', 'true')
  put('workspaces/w1/page.ts', 'export const A = 2\n')
  assert.match(spawnSync('git', ['diff', '--name-only', 'HEAD'], { cwd: r, encoding: 'utf8' }).stderr, /LF will be replaced by CRLF/)
  assert.deepEqual(await o.check('w1'), { ok: true, failures: [] })
  const a = await o.apply('w1', 'two')
  assert.ok(a.ok, JSON.stringify(a))
  assert.deepEqual(a.files, ['workspaces/w1/page.ts'])
})

test('a summary is one line: no body, so no trailers', async () => {
  const { r, put, git } = repo(), { o } = ops(r, fakeExec())
  put('tools/t.ts', 'export const T = 1\n')
  const a = await o.apply('w1', 'two\n\nCo-authored-by: someone <x@y>')
  assert.ok(a.ok)
  assert.equal(git('log', '-1', '--format=%B'), 'w1: two Co-authored-by: someone <x@y>')
  assert.equal(git('log', '-1', '--format=%(trailers)'), '')
})

test('a failed check leaves no commit, keeps the edits and builds nothing', async () => {
  const { r, put, git, read } = repo(), f = fakeExec({ fail: ['typecheck'] }), { o, restarts } = ops(r, f)
  put('workspaces/w1/page.ts', 'export const A = 2\n')
  const head = git('rev-parse', 'HEAD'), a = await o.apply('w1', 'x')
  assert.equal(a.ok, false)
  assert.ok(!a.ok && a.failures!.some((l) => l.includes('typecheck went wrong')), JSON.stringify(a))
  assert.deepEqual(f.calls, ['typecheck'])
  assert.equal(git('rev-parse', 'HEAD'), head)
  assert.equal(read('workspaces/w1/page.ts'), 'export const A = 2\n')
  assert.equal(read('dist/index.html'), 'old build\n')
  assert.equal(restarts(), 0)
})

test('a failed build leaves no commit and the served build as it was', async () => {
  const { r, put, git, read } = repo(), f = fakeExec({ fail: ['build'] }), { o, restarts } = ops(r, f)
  put('tools/t.ts', 'export const T = 1\n')
  const head = git('rev-parse', 'HEAD'), a = await o.apply('w1', 'x')
  assert.equal(a.ok, false)
  assert.ok(!a.ok && /build/.test(a.error))
  assert.equal(git('rev-parse', 'HEAD'), head)
  assert.equal(read('dist/index.html'), 'old build\n')
  assert.equal(restarts(), 0)
})

test('code the import check refuses is never run: no tests, no build', async () => {
  const { r, put, git } = repo(), f = fakeExec(), { o } = ops(r, f)
  put('workspaces/w1/evil.test.ts', "import { execSync } from 'node:child_process'\n")
  const head = git('rev-parse', 'HEAD'), a = await o.apply('w1', 'x')
  assert.equal(a.ok, false)
  assert.deepEqual(!a.ok && a.failures, ['workspaces/w1/evil.test.ts:1: imports node:child_process'])
  assert.deepEqual(f.calls, [])
  assert.equal(git('rev-parse', 'HEAD'), head)
})

test('nothing changed is an error, not an empty commit', async () => {
  const { r, git } = repo(), f = fakeExec(), { o } = ops(r, f)
  const head = git('rev-parse', 'HEAD'), a = await o.apply('w1', 'x')
  assert.deepEqual(a, { ok: false, error: 'nothing to apply: no changes under workspaces/w1 or tools' })
  assert.equal(git('rev-parse', 'HEAD'), head)
  assert.deepEqual(f.calls, [])
})

test('grants.json and core files are refused before anything runs, by check as by apply', async () => {
  for (const [p, why] of [['workspaces/w1/grants.json', /propose_grants/], ['tools/core-helper.ts', /may not change tools\/core-helper\.ts/]] as const) {
    const { r, put, git } = repo(), f = fakeExec(), { o } = ops(r, f)
    put(p, '{"packs":["x"]}\n'); put('tools/t.ts', 'export const T = 1\n')
    const c = await o.check('w1')
    assert.equal(c.ok, false, p)
    assert.match(c.failures.join('\n'), why)
    const head = git('rev-parse', 'HEAD'), a = await o.apply('w1', 'x')
    assert.equal(a.ok, false, p)
    assert.match(!a.ok ? a.error : '', why)
    assert.deepEqual(f.calls, [])
    assert.equal(git('rev-parse', 'HEAD'), head)
  }
})

test('a symlink or junction under its areas is refused by check and apply', async (t) => {
  const { r, put, git } = repo(), f = fakeExec(), { o } = ops(r, f)
  try { symlinkSync(join(r, 'server'), join(r, 'workspaces', 'w1', 'esc'), 'junction') } catch (e) { t.skip(`no junctions here: ${(e as Error).message}`); return }
  put('tools/t.ts', 'export const T = 1\n')
  const c = await o.check('w1')
  assert.deepEqual(c, { ok: false, failures: ['workspaces/w1/esc: a symlink or junction; the agent areas hold plain files only'] })
  const head = git('rev-parse', 'HEAD'), a = await o.apply('w1', 'x')
  assert.equal(a.ok, false)
  assert.deepEqual(f.calls, [])
  assert.equal(git('rev-parse', 'HEAD'), head)
  unlinkSync(join(r, 'workspaces', 'w1', 'esc'))
})

test('a change outside its areas while the check ran (test code writing the core) refuses the apply', async () => {
  const { r, put, git, read } = repo()
  const f = fakeExec({ during: (s) => { if (s === 'tests') writeFileSync(join(r, 'server', 'main.ts'), 'tampered\n') } }), { o, restarts } = ops(r, f)
  put('tools/t.ts', 'export const T = 1\n')
  const head = git('rev-parse', 'HEAD'), a = await o.apply('w1', 'x')
  assert.equal(a.ok, false)
  assert.match(!a.ok ? a.error : '', /changed outside workspaces\/w1 and tools while it was checked: server\/main\.ts/)
  assert.equal(git('rev-parse', 'HEAD'), head)
  assert.equal(read('dist/index.html'), 'old build\n')
  assert.equal(restarts(), 0)
})

test('check passes, or names the failing step with its output', async () => {
  const { r } = repo()
  assert.deepEqual(await ops(r, fakeExec()).o.check('w1'), { ok: true, failures: [] })
  const f = fakeExec({ fail: ['tests'] }), c = await ops(r, f).o.check('w1')
  assert.deepEqual(c, { ok: false, failures: ['the tests failed (exit 1)', 'tests went wrong', 'line two'] })
  assert.deepEqual(f.calls, ['typecheck', 'tests'], 'the tests run once')
  const t = fakeExec({ fail: ['typecheck'] })
  assert.equal((await ops(r, t).o.check('w1')).ok, false)
  assert.deepEqual(t.calls, ['typecheck'])
})

test("check runs the drift and registry tests and those of the workspace and tools/, none of the core's others", async () => {
  const { r, put } = repo()
  for (const p of ['workspaces/w1/a.test.ts', 'workspaces/w1/deep/b.test.ts', 'workspaces/w1/c.ts', 'workspaces/w2/d.test.ts', 'tools/e.test.ts', 'server/f.test.ts', 'scripts/g.test.ts', 'src/h.test.ts']) put(p, '')
  const f = fakeExec()
  assert.ok((await ops(r, f).o.check('w1')).ok)
  assert.deepEqual(f.tests, [['server/core-lock.test.ts', 'server/registry.test.ts', 'tools/e.test.ts', 'workspaces/w1/a.test.ts', 'workspaces/w1/deep/b.test.ts']])
})

test('undo reverts its own commit, builds, commits `<ws>: undo — <summary>` and restarts', async () => {
  const { r, put, git, read } = repo(), f = fakeExec(), { o, restarts } = ops(r, f)
  put('workspaces/w1/page.ts', 'export const A = 2\n'); put('tools/t.ts', 'export const T = 1\n')
  const a = await o.apply('w1', 'show the counter')
  assert.ok(a.ok)
  writeFileSync(join(r, 'dist', 'index.html'), 'still the applied build\n')
  const u = await o.undo('w1', a.sha)
  assert.ok(u.ok, JSON.stringify(u))
  assert.equal(git('log', '-1', '--format=%B'), 'w1: undo — show the counter')
  assert.equal(read('workspaces/w1/page.ts'), 'export const A = 1\n')
  assert.equal(existsSync(join(r, 'tools', 't.ts')), false)
  assert.deepEqual(u.files.sort(), ['tools/t.ts', 'workspaces/w1/page.ts'])
  assert.equal(read('dist/index.html'), 'new build\n')
  assert.equal(restarts(), 2)
  assert.equal(git('status', '--porcelain'), '')
})

test('undo refuses a commit that is not its own, and one whose files changed since', async () => {
  const { r, put, git } = repo(), f = fakeExec(), { o } = ops(r, f)
  const init = git('rev-parse', 'HEAD')
  assert.match((await o.undo('w1', init) as { error: string }).error, /not a commit of w1's agent/)
  put('workspaces/w2/page.ts', 'export const B = 2\n'); git('add', '-A'); git('commit', '-qm', 'w2: theirs')
  assert.match((await o.undo('w1', git('rev-parse', 'HEAD')) as { error: string }).error, /not a commit of w1's agent/)
  assert.match((await o.undo('w1', 'nope') as { error: string }).error, /no such commit/)
  put('workspaces/w1/page.ts', 'export const A = 2\n')
  const a = await o.apply('w1', 'two')
  assert.ok(a.ok)
  put('workspaces/w1/page.ts', 'export const A = 3\n')
  const head = git('rev-parse', 'HEAD'), u = await o.undo('w1', a.sha)
  assert.match(!u.ok ? u.error : '', /uncommitted changes in workspaces\/w1\/page\.ts/)
  assert.equal(git('rev-parse', 'HEAD'), head)
})

test('an undo that conflicts with a later commit leaves the tree and HEAD as they were', async () => {
  const { r, put, git, read } = repo(), { o } = ops(r, fakeExec())
  put('workspaces/w1/page.ts', 'export const A = 2\n')
  const a = await o.apply('w1', 'two'); assert.ok(a.ok)
  put('workspaces/w1/page.ts', 'export const A = 3\n')
  const b = await o.apply('w1', 'three'); assert.ok(b.ok)
  const u = await o.undo('w1', a.sha)
  assert.equal(u.ok, false)
  assert.match(!u.ok ? u.error : '', /does not revert cleanly/)
  assert.equal(git('rev-parse', 'HEAD'), b.sha)
  assert.equal(read('workspaces/w1/page.ts'), 'export const A = 3\n')
  assert.equal(git('status', '--porcelain'), '')
})

test('an undo whose build fails puts the files back and commits nothing', async () => {
  const { r, put, git, read } = repo()
  let fail = false
  const f = fakeExec({ during: (s) => { if (s === 'build' && fail) throw new Error('vite exploded') } }), { o } = ops(r, f)
  put('workspaces/w1/page.ts', 'export const A = 2\n'); put('tools/t.ts', 'export const T = 1\n')
  const a = await o.apply('w1', 'two'); assert.ok(a.ok)
  fail = true
  const u = await o.undo('w1', a.sha)
  assert.equal(u.ok, false)
  assert.equal(git('rev-parse', 'HEAD'), a.sha)
  assert.equal(read('workspaces/w1/page.ts'), 'export const A = 2\n')
  assert.equal(read('tools/t.ts'), 'export const T = 1\n')
  assert.equal(git('status', '--porcelain'), '')
})

test('acceptGrants writes grants.json, commits `<ws>: grants — <reason>` and restarts; the same grants are no change', async () => {
  const { r, git, read } = repo(), f = fakeExec(), { o, restarts } = ops(r, f)
  const g = { ...EMPTY_GRANTS, hosts: ['api.example.com'], runTools: ['WebFetch'] }
  const a = await o.acceptGrants('w1', g, 'read the tracker')
  assert.ok(a.ok, JSON.stringify(a))
  assert.equal(git('log', '-1', '--format=%B'), 'w1: grants — read the tracker')
  assert.deepEqual(a.files, ['workspaces/w1/grants.json'])
  assert.deepEqual(JSON.parse(read('workspaces/w1/grants.json')), g)
  assert.equal(restarts(), 1)
  assert.deepEqual(f.calls, [])
  assert.deepEqual(await o.acceptGrants('w1', g, 'again'), { ok: false, error: 'the grants are already so' })
  assert.match(((await o.acceptGrants('w1', { ...g, bogus: 1 } as never, 'x')) as { error: string }).error, /bogus/)
})

test('ops run one at a time', async () => {
  const { r, put } = repo()
  let inside = 0, most = 0
  const f = fakeExec({ during: () => { inside++; most = Math.max(most, inside) } })
  const slow: Exec = async (c, a, o) => { const x = await f.exec(c, a, o); await new Promise((ok) => setTimeout(ok, 20)); if (c !== 'git') inside--; return x }
  const o = new Ops({ root: r, exec: slow })
  put('tools/t.ts', 'export const T = 1\n')
  await Promise.all([o.check('w1'), o.check('w1'), o.apply('w1', 'x')])
  assert.equal(most, 1)
})

function withHome(ws: Record<string, unknown>) {
  const home = tempDir('ops-home'), text = JSON.stringify({ lanPort: 7411, workspaces: ws }, null, 2)
  writeFileSync(join(home, 'config.json'), text)
  return { home, text, cfg: () => JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) }
}
const db = { pgUrl: 'postgres://u@127.0.0.1:55432/wc', pgPasswordPath: 'C:/x/pg.password', pgSchema: 'wc' }

test('createWorkspace renders the template, registers it, gives it empty grants and the shared database, then applies', async () => {
  const { r, git, read } = repo(), f = fakeExec(), h = withHome({ w1: { ...db, knowledgeDir: 'C:/k' } })
  let restarts = 0
  const o = new Ops({ root: r, exec: f.exec, home: h.home, restart: () => { restarts++ } })
  const a = await o.createWorkspace('w1', { id: 'my-crm', prefix: 'CRM', title: 'My CRM' }, { ids: ['w1', 'w2'], prefixes: ['W'] })
  assert.ok(a.ok, JSON.stringify(a))
  assert.equal(git('log', '-1', '--format=%B'), 'w1: create workspace my-crm — My CRM')
  assert.deepEqual(a.files.sort(), ['workspaces/my-crm/grants.json', 'workspaces/my-crm/page.ts', 'workspaces/my-crm/server.ts', 'workspaces/my-crm/ui.tsx', 'workspaces/page.ts', 'workspaces/server.ts'])
  assert.deepEqual(JSON.parse(read('workspaces/my-crm/grants.json')), EMPTY_GRANTS)
  assert.match(read('workspaces/my-crm/server.ts'), /jobPrefix: 'CRM'/)
  assert.match(read('workspaces/page.ts'), /import myCrm from '\.\/my-crm\/page\.ts'/)
  assert.match(read('workspaces/page.ts'), /\{ page: myCrm, ui: myCrmUi \}/)
  assert.match(read('workspaces/server.ts'), /SERVERS = \[myCrmServer\]/)
  assert.deepEqual(h.cfg(), { lanPort: 7411, workspaces: { w1: { ...db, knowledgeDir: 'C:/k' }, 'my-crm': db } })
  assert.deepEqual(f.calls, ['typecheck', 'tests', 'build'])
  assert.equal(restarts, 1)
  assert.equal(git('status', '--porcelain'), '')
})

test('createWorkspace refuses a taken name and a console with no database to share; a failed check leaves nothing behind', async () => {
  const { r, git } = repo(), h = withHome({ w1: db })
  const o = new Ops({ root: r, exec: fakeExec().exec, home: h.home })
  const taken = { ids: ['w1', 'w2'], prefixes: ['W'] }
  assert.match((await o.createWorkspace('w1', { id: 'w2', prefix: 'X', title: 't' }, taken) as { error: string }).error, /w2 is taken/)
  assert.match((await o.createWorkspace('w1', { id: 'x', prefix: 'W', title: 't' }, taken) as { error: string }).error, /prefix W is taken/)
  const none = new Ops({ root: r, exec: fakeExec().exec, home: withHome({ w1: {} }).home })
  assert.match((await none.createWorkspace('w1', { id: 'x', prefix: 'X', title: 't' }, taken) as { error: string }).error, /pgUrl and pgPasswordPath/)
  const fake = new Ops({ root: r, exec: fakeExec().exec, home: withHome({}).home, fake: true })
  const b = await fake.createWorkspace('w1', { id: 'y', prefix: 'Y', title: 't' }, taken)
  assert.ok(b.ok, 'fake gateways need no database')

  const head = git('rev-parse', 'HEAD'), bad = new Ops({ root: r, exec: fakeExec({ fail: ['tests'] }).exec, home: h.home })
  const c = await bad.createWorkspace('w1', { id: 'z', prefix: 'Z', title: 't' }, taken)
  assert.equal(c.ok, false)
  assert.equal(git('rev-parse', 'HEAD'), head)
  assert.equal(git('status', '--porcelain'), '')
  assert.equal(readFileSync(join(h.home, 'config.json'), 'utf8'), h.text)
})

test('remove deletes a file under its areas, which apply then commits; anything else it refuses', async () => {
  const { r, put, git } = repo(), { o } = ops(r, fakeExec())
  put('workspaces/w1/old.ts', 'export const O = 1\n'); git('add', '-A'); git('commit', '-qm', 'old')
  put('workspaces/w1/probe.txt', 'x\n'); put('workspaces/w1/sub/a.ts', '')
  assert.deepEqual(await o.remove('w1', 'workspaces/w1/probe.txt'), { ok: true, path: 'workspaces/w1/probe.txt' })
  assert.deepEqual(await o.remove('w1', join(r, 'workspaces', 'w1', 'old.ts')), { ok: true, path: 'workspaces/w1/old.ts' })
  assert.equal(existsSync(join(r, 'workspaces/w1/probe.txt')) || existsSync(join(r, 'workspaces/w1/old.ts')), false)
  for (const [p, why] of [
    ['workspaces/w1/grants.json', /not yours/], ['tools/core-helper.ts', /not yours/], ['workspaces/w2/page.ts', /not yours/],
    ['server/main.ts', /not yours/], ['workspaces/w1/../w2/page.ts', /not yours/], ['workspaces/w1/none.ts', /no such file/], ['workspaces/w1/sub', /not a file/],
  ] as const) assert.match((await o.remove('w1', p) as { error: string }).error, why, p)
  assert.ok(existsSync(join(r, 'workspaces/w1/grants.json')) && existsSync(join(r, 'workspaces/w2/page.ts')) && existsSync(join(r, 'server/main.ts')))
  const a = await o.apply('w1', 'drop old')
  assert.ok(a.ok, JSON.stringify(a))
  assert.deepEqual(a.files, ['workspaces/w1/old.ts', 'workspaces/w1/sub/a.ts'])
  assert.equal(git('status', '--porcelain'), '')
})

test('undo commits its own files only: the agent\'s other edits stay uncommitted', async () => {
  const { r, put, git } = repo(), { o } = ops(r, fakeExec())
  put('workspaces/w1/page.ts', 'export const A = 2\n')
  const a = await o.apply('w1', 'two'); assert.ok(a.ok)
  put('workspaces/w1/other.ts', 'export const O = 1\n')
  const u = await o.undo('w1', a.sha)
  assert.ok(u.ok, JSON.stringify(u))
  assert.deepEqual(git('show', '--name-only', '--format=', 'HEAD').split('\n'), ['workspaces/w1/page.ts'])
  assert.equal(git('status', '--porcelain'), '?? workspaces/w1/other.ts')
})

/* ===== the agent's worktree: it works there, and its changes reach the live folder only by a fast-forward ===== */

/** ops whose agent works in a worktree per workspace under a base of its own */
function treeOps(r: string, f: ReturnType<typeof fakeExec>) {
  let restarts = 0
  const trees = new AgentTrees({ live: r, base: join(tempDir('agents'), 'agents') })
  const o = new Ops({ root: r, exec: f.exec, restart: () => { restarts++ }, trees })
  const at = (dir: string) => ({
    git: (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim(),
    put: (p: string, t: string | Buffer) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), t) },
    bytes: (p: string) => readFileSync(join(dir, p)),
  })
  return { o, trees, at, restarts: () => restarts }
}
/** the live folder as git sees it: HEAD and every change */
const liveState = (git: (...a: string[]) => string) => ({ head: git('rev-parse', 'HEAD'), status: git('status', '--porcelain', '--untracked-files=all') })
const CRLF = Buffer.from('export const C = 1\r\nexport const D = 2\r\n')

test('a worktree per workspace on agent/<ws>, made once, its node_modules joined to the live one; a clean one follows the live HEAD', async () => {
  const { r, put, git } = repo(), { trees, at } = treeOps(r, fakeExec())
  put('node_modules/vite/package.json', '{"name":"vite"}\n')
  const d = await trees.dir('w1')
  assert.equal(await trees.dir('w1'), d, 'made once')
  assert.notEqual(d, r)
  assert.ok(!d.startsWith(r), 'outside the live folder')
  const w = at(d)
  assert.equal(w.git('rev-parse', '--abbrev-ref', 'HEAD'), 'agent/w1')
  assert.equal(w.git('rev-parse', 'HEAD'), git('rev-parse', 'HEAD'))
  assert.equal(readFileSync(join(d, 'node_modules/vite/package.json'), 'utf8'), '{"name":"vite"}\n')
  assert.equal(w.git('status', '--porcelain'), '', 'node_modules is ignored there too')
  assert.equal(git('status', '--porcelain'), '', 'the live folder does not see the worktree')
  assert.notEqual(await trees.dir('w2'), d)
  put('server/main.ts', 'core 2\n'); git('commit', '-qam', 'core moves')
  assert.equal(await trees.sync('w1'), true)
  assert.equal(w.git('rev-parse', 'HEAD'), git('rev-parse', 'HEAD'))
  // uncommitted work stays where it is; the rebase waits for apply
  w.put('workspaces/w1/page.ts', 'export const A = 9\n')
  put('server/main.ts', 'core 3\n'); git('commit', '-qam', 'core moves again')
  assert.equal(await trees.sync('w1'), false)
  assert.notEqual(w.git('rev-parse', 'HEAD'), git('rev-parse', 'HEAD'))
  assert.deepEqual(await trees.pending('w1'), ['workspaces/w1/page.ts'])
  assert.deepEqual(await trees.pending('w2'), [])
  assert.deepEqual(await trees.pending('w3'), [], 'no worktree yet is nothing pending, and makes none')
  assert.equal(trees.has('w3'), null)
})

test('a failed apply leaves the live folder’s git status and HEAD as they were, and every change in the worktree byte for byte', async () => {
  const { r, put, git, read } = repo(), f = fakeExec({ fail: ['tests'] }), { o, trees, at, restarts } = treeOps(r, f)
  put('workspaces/w1/old.ts', 'export const O = 1\n'); git('add', '-A'); git('commit', '-qm', 'old')
  put('notes.txt', 'the person’s own, not the agent’s\n')
  const before = liveState(git), d = await trees.dir('w1'), w = at(d)
  w.put('workspaces/w1/page.ts', 'export const A = 2\n'); w.put('workspaces/w1/new/x.ts', 'export const X = 1\n')
  unlinkSync(join(d, 'workspaces/w1/old.ts')); w.put('tools/crlf.ts', CRLF)
  const a = await o.apply('w1', 'show the counter')
  assert.equal(a.ok, false, JSON.stringify(a))
  assert.deepEqual(liveState(git), before)
  assert.equal(read('dist/index.html'), 'old build\n')
  assert.equal(restarts(), 0)
  assert.equal(w.bytes('workspaces/w1/page.ts').toString(), 'export const A = 2\n')
  assert.equal(w.bytes('workspaces/w1/new/x.ts').toString(), 'export const X = 1\n')
  assert.ok(!existsSync(join(d, 'workspaces/w1/old.ts')))
  assert.deepEqual(w.bytes('tools/crlf.ts'), CRLF)
  assert.equal(w.git('rev-parse', 'HEAD'), before.head, 'its commit is taken back')
  assert.deepEqual(await trees.pending('w1'), ['tools/crlf.ts', 'workspaces/w1/new/x.ts', 'workspaces/w1/old.ts', 'workspaces/w1/page.ts'])
  assert.ok(f.where.length)
  for (const c of f.where) assert.equal(c, d, 'the check ran in the worktree')
})

test('a passing apply commits in the worktree and fast-forwards the live folder to it, then swaps the build and restarts', async () => {
  const { r, git, read, put } = repo(), f = fakeExec(), { o, trees, at, restarts } = treeOps(r, f)
  put('notes.txt', 'mine\n')
  const d = await trees.dir('w1'), w = at(d)
  w.put('workspaces/w1/page.ts', 'export const A = 2\n'); w.put('tools/crlf.ts', CRLF)
  const a = await o.apply('w1', 'show the counter')
  assert.ok(a.ok, JSON.stringify(a))
  assert.deepEqual(f.calls, ['typecheck', 'tests', 'build'])
  assert.equal(git('rev-parse', 'HEAD'), a.sha)
  assert.equal(git('log', '-1', '--format=%B'), 'w1: show the counter')
  assert.deepEqual(a.files.sort(), ['tools/crlf.ts', 'workspaces/w1/page.ts'])
  assert.equal(read('workspaces/w1/page.ts'), 'export const A = 2\n')
  assert.deepEqual(readFileSync(join(r, 'tools/crlf.ts')), CRLF)
  assert.equal(git('status', '--porcelain'), '?? notes.txt')
  assert.equal(w.git('rev-parse', 'HEAD'), a.sha); assert.equal(w.git('status', '--porcelain'), '')
  assert.equal(read('dist/index.html'), 'new build\n')
  assert.equal(restarts(), 1)
  assert.deepEqual(await trees.pending('w1'), [])
})

test('the live HEAD moved during the turn (a grants commit): apply rebases onto it and lands on top', async () => {
  const { r, git } = repo(), { o, trees, at } = treeOps(r, fakeExec())
  const d = await trees.dir('w1'), w = at(d)
  w.put('workspaces/w1/page.ts', 'export const A = 2\n')
  const g = await o.acceptGrants('w1', { ...EMPTY_GRANTS, runTools: ['Bash(git status)'] } as never, 'git status')
  assert.ok(g.ok, JSON.stringify(g))
  const a = await o.apply('w1', 'two')
  assert.ok(a.ok, JSON.stringify(a))
  assert.equal(git('rev-parse', 'HEAD~1'), g.sha)
  assert.equal(git('rev-parse', 'HEAD'), a.sha)
  assert.equal(git('status', '--porcelain'), '')
})

test('a rebase conflict in a shared tools/ file fails the apply, leaves the live folder alone and the files in the worktree', async () => {
  const { r, put, git } = repo(), f = fakeExec(), { o, trees, at } = treeOps(r, f)
  const d = await trees.dir('w1'), w = at(d)
  w.put('tools/shared.ts', 'mine\n'); w.put('workspaces/w1/page.ts', 'export const A = 2\n')
  // another workspace's agent landed the same new file first
  put('tools/shared.ts', 'theirs\n'); git('add', '-A'); git('commit', '-qm', 'w2: theirs')
  const before = liveState(git)
  const a = await o.apply('w1', 'mine')
  assert.equal(a.ok, false)
  assert.match((a as { error: string }).error, /conflicts.*tools\/shared\.ts/)
  assert.deepEqual(f.calls, [], 'nothing was checked')
  assert.deepEqual(liveState(git), before)
  assert.equal(w.bytes('tools/shared.ts').toString(), 'mine\n')
  assert.equal(w.bytes('workspaces/w1/page.ts').toString(), 'export const A = 2\n')
  assert.ok(!existsSync(w.git('rev-parse', '--path-format=absolute', '--git-path', 'rebase-merge')), 'no rebase left open')
  assert.ok(!existsSync(w.git('rev-parse', '--path-format=absolute', '--git-path', 'rebase-apply')), 'no rebase left open')
  assert.deepEqual(await trees.pending('w1'), ['tools/shared.ts', 'workspaces/w1/page.ts'])
})

test('the live HEAD moving between the check and the landing refuses the fast-forward; the build stays and the files stay in the worktree', async () => {
  const { r, put, git, read } = repo()
  let once = true
  const f = fakeExec({ during: (s) => { if (s === 'build' && once) { once = false; put('server/main.ts', 'core 2\n'); git('commit', '-qam', 'core moved') } } })
  const { o, trees, at, restarts } = treeOps(r, f), d = await trees.dir('w1'), w = at(d)
  w.put('workspaces/w1/page.ts', 'export const A = 2\n')
  const a = await o.apply('w1', 'two')
  assert.equal(a.ok, false)
  assert.match((a as { error: string }).error, /moved while it was checked; apply again/)
  assert.equal(git('log', '-1', '--format=%s'), 'core moved')
  assert.equal(read('dist/index.html'), 'old build\n'); assert.equal(restarts(), 0)
  assert.equal(w.bytes('workspaces/w1/page.ts').toString(), 'export const A = 2\n')
  assert.deepEqual(await trees.pending('w1'), ['workspaces/w1/page.ts'])
  // applied again, it lands on the new HEAD
  const b = await o.apply('w1', 'two')
  assert.ok(b.ok, JSON.stringify(b))
  assert.equal(git('log', '-2', '--format=%s'), 'w1: two\ncore moved')
})

test('uncommitted changes in the live folder under the agent’s areas refuse the landing', async () => {
  const { r, put, git } = repo(), { o, trees, at, restarts } = treeOps(r, fakeExec())
  const w = at(await trees.dir('w1'))
  w.put('workspaces/w1/page.ts', 'export const A = 2\n')
  put('workspaces/w1/page.ts', 'export const A = 7\n')
  const before = liveState(git), a = await o.apply('w1', 'two')
  assert.equal(a.ok, false)
  assert.match((a as { error: string }).error, /uncommitted changes in the live folder: workspaces\/w1\/page\.ts/)
  assert.deepEqual(liveState(git), before); assert.equal(restarts(), 0)
  assert.deepEqual(await trees.pending('w1'), ['workspaces/w1/page.ts'])
})

test('check and remove act in the worktree; discard drops what is not applied there and nothing in the live folder', async () => {
  const { r, put, git } = repo(), f = fakeExec(), { o, trees, at } = treeOps(r, f)
  put('workspaces/w1/old.ts', 'export const O = 1\n'); git('add', '-A'); git('commit', '-qm', 'old')
  const d = await trees.dir('w1'), w = at(d)
  w.put('workspaces/w1/page.ts', 'export const A = 2\n')
  assert.deepEqual(await o.check('w1'), { ok: true, failures: [] })
  assert.ok(f.where.length && f.where.every((c) => c === d))
  assert.deepEqual(await o.remove('w1', 'workspaces/w1/old.ts'), { ok: true, path: 'workspaces/w1/old.ts' })
  assert.ok(existsSync(join(r, 'workspaces/w1/old.ts')), 'the live file stays')
  assert.ok(!existsSync(join(d, 'workspaces/w1/old.ts')))
  w.put('tools/new.ts', 'x\n')
  assert.deepEqual(await o.unapplied('w1'), ['tools/new.ts', 'workspaces/w1/old.ts', 'workspaces/w1/page.ts'])
  assert.deepEqual(await o.discard('w1'), ['tools/new.ts', 'workspaces/w1/old.ts', 'workspaces/w1/page.ts'])
  assert.deepEqual(await o.unapplied('w1'), [])
  assert.equal(w.git('status', '--porcelain'), '')
  assert.equal(git('status', '--porcelain'), '')
})

test('the one-time move takes the live leftovers of a workspace into its clean worktree and leaves the live folder clean', async () => {
  const { r, put, git } = repo(), { trees, at } = treeOps(r, fakeExec())
  put('workspaces/w1/old.ts', 'export const O = 1\n'); git('add', '-A'); git('commit', '-qm', 'old')
  const head = git('rev-parse', 'HEAD')
  // as on 2026-10-09: an apply that failed left the agent's files in the live folder
  put('workspaces/w1/page.ts', 'export const A = 2\n'); put('workspaces/w1/knowledge/n.md', '# n\n'); put('tools/crlf.ts', CRLF)
  unlinkSync(join(r, 'workspaces/w1/old.ts')); put('notes.txt', 'the person’s own\n'); put('workspaces/w2/page.ts', 'export const B = 2\n')
  const m = await trees.adopt('w1')
  assert.deepEqual(m, { moved: ['tools/crlf.ts', 'workspaces/w1/knowledge/n.md', 'workspaces/w1/old.ts', 'workspaces/w1/page.ts'] })
  assert.equal(git('rev-parse', 'HEAD'), head)
  assert.equal(git('status', '--porcelain', '--untracked-files=all'), 'M workspaces/w2/page.ts\n?? notes.txt', 'only what is not its own stays')
  const d = await trees.dir('w1'), w = at(d)
  assert.equal(w.bytes('workspaces/w1/page.ts').toString(), 'export const A = 2\n')
  assert.equal(w.bytes('workspaces/w1/knowledge/n.md').toString(), '# n\n')
  assert.deepEqual(w.bytes('tools/crlf.ts'), CRLF)
  assert.ok(!existsSync(join(d, 'workspaces/w1/old.ts')))
  assert.deepEqual(await trees.adopt('w1'), { moved: [] }, 'nothing left to move')
  // a worktree that holds work of its own is left alone, and so are the live files
  put('workspaces/w1/page.ts', 'export const A = 3\n')
  const s = await trees.adopt('w1')
  assert.ok('skipped' in s && /not applied/.test(s.skipped), JSON.stringify(s))
  assert.equal(readFileSync(join(r, 'workspaces/w1/page.ts'), 'utf8'), 'export const A = 3\n')
  assert.equal(w.bytes('workspaces/w1/page.ts').toString(), 'export const A = 2\n')
})
