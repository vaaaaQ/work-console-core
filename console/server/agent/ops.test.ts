import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { realExec, Ops } from './ops.ts'
import type { Exec } from './ops.ts'
import { RESTART_EXIT } from '../restart.ts'
import { EMPTY_GRANTS } from '../grants.ts'
import { tempDir } from '../testdirs.ts'

/** a consumer folder under git: w1 with its grants, the registries, a core file, tools/ and a served build */
function repo() {
  const r = tempDir('ops')
  const put = (p: string, t: string) => { mkdirSync(dirname(join(r, p)), { recursive: true }); writeFileSync(join(r, p), t) }
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
  const calls: string[] = [], tests: string[][] = []
  const exec: Exec = async (cmd, args, opt) => {
    if (cmd === 'git') return realExec(cmd, args, opt)
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
  return { exec, calls, tests }
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
