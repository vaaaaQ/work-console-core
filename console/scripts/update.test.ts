import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run, type Ran, type Runner } from './lib.mjs'
import { folder } from './install.mjs'
import { TEMPLATE_FILES } from './workspaces.mjs'
import { sync } from './sync-core.mjs'
import { finishFile } from './run.mjs'
import { EXIT_REINTEGRATE, failedUpdate, finish, giveUp, update, updatesDir } from './update.mjs'
import { tempDir } from '../server/testdirs.ts'

/* update.mjs against throwaway repos: an origin core, a clone of it as the person's core, and a consumer folder
   made by install's folder(). Git runs for real; npm is a fake, and the checks are a stand-in that fails while
   the worktree has server/broken.ts and no workspaces/home/fix.ts. */

process.env.GIT_CONFIG_COUNT = '2'
process.env.GIT_CONFIG_KEY_0 = 'commit.gpgsign'
process.env.GIT_CONFIG_VALUE_0 = 'false'
process.env.GIT_CONFIG_KEY_1 = 'core.autocrlf'
process.env.GIT_CONFIG_VALUE_1 = 'false'

const tmp = (what: string) => tempDir(`update-${what}`)
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Update Test', '-c', 'user.email=update@example.test', ...args],
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const put = (dir: string, p: string, body: string) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), body) }
const read = (dir: string, p: string) => readFileSync(join(dir, p), 'utf8')
const ok = (stdout = ''): Ran => ({ status: 0, stdout, stderr: '' })
const quiet = () => {}
const CONSUMER = fileURLToPath(new URL('../consumer/', import.meta.url))

/** an origin core, the person's clone of it, and a consumer folder at the clone's HEAD */
function setup() {
  const origin = tmp('origin')
  git(origin, 'init', '-q', '-b', 'main')
  put(origin, 'console/package.json', '{ "name": "stub" }\n')
  put(origin, 'console/package-lock.json', '{ "v": 1 }\n')
  put(origin, 'console/.gitignore', 'node_modules/\ndist/\n')
  put(origin, 'console/server/a.ts', 'export const a = 1\n')
  for (const t of ['page.ts', 'server.ts', ...TEMPLATE_FILES.map((f) => `workspace-template/${f}`)]) put(origin, `console/consumer/${t}`, readFileSync(join(CONSUMER, t), 'utf8'))
  git(origin, 'add', '-A')
  git(origin, 'commit', '-q', '-m', 'core')
  const core = join(tmp('core'), 'core')
  git(dirname(core), 'clone', '-q', origin, core)
  const to = tmp('to'), home = join(tmp('home'), 'home')
  folder({ core, to, log: quiet })
  mkdirSync(home)
  writeFileSync(join(home, 'install.json'), JSON.stringify({ core, folder: to }))
  return { origin, core, to, home }
}
/** a new commit on the origin; the update pulls it */
function advance(origin: string, files: Record<string, string | null>, msg = 'next') {
  for (const [p, b] of Object.entries(files)) if (b === null) rmSync(join(origin, p)); else put(origin, p, b)
  git(origin, 'add', '-A')
  git(origin, 'commit', '-q', '-m', msg)
  return git(origin, 'rev-parse', 'HEAD')
}

function harness() {
  const npm: string[] = [], checked: string[] = [], restarts: string[] = []
  const r: Runner = (cmd, args, o) => {
    if (cmd === 'git') return run(cmd, args, o)
    npm.push(`${cmd} ${args.join(' ')} @ ${o?.cwd}`)
    return ok()
  }
  const check = (dir: string) => {
    checked.push(dir)
    return existsSync(join(dir, 'server', 'broken.ts')) && !existsSync(join(dir, 'workspaces', 'home', 'fix.ts'))
      ? { ok: false, step: 'typecheck', output: 'server/broken.ts(1,1): error TS2322' } : { ok: true }
  }
  const o = (s: ReturnType<typeof setup>, more: Record<string, unknown> = {}) => ({
    home: s.home, folder: s.to, run: r, check, log: quiet,
    sync: ({ core, to, rev }: { core: string; to: string; rev: string }) => { sync({ core, to, rev, log: quiet }) },
    restart: async (h: string) => { restarts.push(h); return true }, running: () => null, ...more,
  })
  return { npm, checked, restarts, o }
}
/** a supervisor that finishes updates, as run.json names it */
const sup = (s: ReturnType<typeof setup>) => () => ({ pid: 1, server: 2, folder: s.to, port: 1, finish: true })
const subjects = (dir: string, ref = 'HEAD') => git(dir, 'log', '--format=%s', ref).split('\n')
const branches = (dir: string) => git(dir, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean)

test('restart null: the update applies and leaves the restart to the console that ran it', async () => {
  const s = setup(), h = harness(), lines: string[] = []
  const sha = advance(s.origin, { 'console/server/a.ts': 'export const a = 2\n' })
  const r = await update(h.o(s, { restart: null, log: (l: string) => lines.push(l) }))
  assert.deepEqual([r.status, r.sha], ['updated', sha])
  assert.deepEqual(h.restarts, [])
  assert.equal(lines.at(-1), 'the console restarts itself')
})

test('refuses a dirty folder and changes nothing', async () => {
  const s = setup(), h = harness()
  advance(s.origin, { 'console/server/a.ts': 'export const a = 2\n' })
  put(s.to, 'workspaces/home/page.ts', read(s.to, 'workspaces/home/page.ts') + '// unsaved\n')
  const head = git(s.to, 'rev-parse', 'HEAD')
  const r = await update(h.o(s))
  assert.equal(r.status, 'refused')
  assert.equal(r.code, 1)
  assert.equal(git(s.to, 'rev-parse', 'HEAD'), head)
  assert.equal(h.checked.length, 0)
  assert.deepEqual(branches(s.to), ['main'])
})

test('already current: says so, touches nothing', async () => {
  const s = setup(), h = harness()
  const head = git(s.to, 'rev-parse', 'HEAD')
  const r = await update(h.o(s))
  assert.equal(r.status, 'current')
  assert.equal(r.code, 0)
  assert.equal(git(s.to, 'rev-parse', 'HEAD'), head)
  assert.deepEqual([h.checked, h.npm, h.restarts], [[], [], []])
})

test('pass: commit "core <sha7>" fast-forwards the folder, builds and asks for a restart', async () => {
  const s = setup(), h = harness()
  const sha = advance(s.origin, { 'console/server/a.ts': 'export const a = 2\n', 'console/package-lock.json': '{ "v": 2 }\n' })
  const r = await update(h.o(s))
  assert.deepEqual([r.status, r.code, r.sha], ['updated', 0, sha])
  assert.equal(subjects(s.to)[0], `core ${sha.slice(0, 7)}`)
  assert.equal(read(s.to, 'server/a.ts'), 'export const a = 2\n')
  assert.equal(JSON.parse(read(s.to, 'core.lock.json')).core, sha)
  assert.equal(git(s.to, 'status', '--porcelain'), '')
  assert.equal(h.checked.length, 1, 'checked once, in the worktree')
  assert.notEqual(h.checked[0], s.to)
  // the lock changed: npm ci, then the build, both in the folder
  assert.deepEqual(h.npm, [`npm ci @ ${s.to}`, `npm run build @ ${s.to}`])
  assert.deepEqual(h.restarts, [s.home])
  assert.deepEqual(branches(s.to), ['main'], 'the update branch is gone')
  assert.equal(existsSync(h.checked[0]), false, 'and so is the worktree')
  assert.equal(failedUpdate(s.home), null)
})

test('pass without a lock change builds without npm ci', async () => {
  const s = setup(), h = harness()
  advance(s.origin, { 'console/server/a.ts': 'export const a = 2\n' })
  assert.equal((await update(h.o(s))).status, 'updated')
  assert.deepEqual(h.npm, [`npm run build @ ${s.to}`])
})

test('a lock change from the console: the npm ci and the build are left for its supervisor, after the server is down', async () => {
  const s = setup(), h = harness(), pre = git(s.to, 'rev-parse', 'HEAD'), lines: string[] = []
  const sha = advance(s.origin, { 'console/server/a.ts': 'export const a = 2\n', 'console/package-lock.json': '{ "v": 2 }\n' })
  const r = await update(h.o(s, { restart: null, running: sup(s), log: (l: string) => lines.push(l) }))
  assert.deepEqual([r.status, r.code, r.sha], ['updated', 0, sha])
  assert.deepEqual(h.npm, [], 'nothing runs in the folder while the server holds it')
  assert.equal(lines.at(-1), 'the console runs npm ci and the build when it restarts')
  assert.deepEqual(JSON.parse(read(s.home, 'update-finish.json')), { folder: s.to, repo: s.to, pre, sha })
  assert.deepEqual(branches(s.to), ['main'])
  // what the supervisor runs before it starts the server again
  assert.deepEqual(finish({ home: s.home, run: h.o(s).run, log: quiet }), { status: 'updated', code: 0, sha })
  assert.deepEqual(h.npm, [`npm ci @ ${s.to}`, `npm run build @ ${s.to}`])
  assert.equal(existsSync(finishFile(s.home)), false)
  assert.deepEqual(finish({ home: s.home, run: h.o(s).run, log: quiet }), { status: 'none', code: 0 })
})

test('a lock change from the command line: the console is asked to restart first, and the update reports what its supervisor did', async () => {
  const s = setup(), h = harness(), pre = git(s.to, 'rev-parse', 'HEAD'), seen: number[] = []
  const sha = advance(s.origin, { 'console/package-lock.json': '{ "v": 2 }\n' })
  // the running console: once its turns end it exits, and its supervisor finishes the update before it starts
  const restart = (build?: () => { ok: boolean; output: string }) => async (home: string) => {
    seen.push(h.npm.length)
    finish({ home, run: h.o(s).run, log: quiet, build })
    return true
  }
  const r = await update(h.o(s, { running: sup(s), restart: restart(), settle: async () => true }))
  assert.deepEqual([r.status, r.code, r.sha], ['updated', 0, sha])
  assert.deepEqual(seen, [0], 'npm ci ran only once the console was asked to stop')
  assert.deepEqual(h.npm, [`npm ci @ ${s.to}`, `npm run build @ ${s.to}`])
  assert.notEqual(git(s.to, 'rev-parse', 'HEAD'), pre)

  const t = setup(), g = harness(), before = git(t.to, 'rev-parse', 'HEAD')
  advance(t.origin, { 'console/package-lock.json': '{ "v": 2 }\n' })
  const bad = await update(g.o(t, { running: sup(t), settle: async () => true,
    restart: async (home: string) => { finish({ home, run: g.o(t).run, log: quiet, build: () => ({ ok: false, output: 'vite: out of memory' }) }); return true } }))
  assert.deepEqual([bad.status, bad.code], ['failed', 1])
  assert.equal(git(t.to, 'rev-parse', 'HEAD'), before, 'the supervisor put it back')
  assert.deepEqual(g.npm, [`npm ci @ ${t.to}`, `npm ci @ ${t.to}`])
})

test('a finish whose build fails puts the folder back on its commit before the update, with npm ci for it, and records it for the page', async () => {
  const s = setup(), h = harness(), pre = git(s.to, 'rev-parse', 'HEAD'), from = JSON.parse(read(s.to, 'core.lock.json')).core
  const sha = advance(s.origin, { 'console/server/a.ts': 'export const a = 2\n', 'console/package-lock.json': '{ "v": 2 }\n' })
  await update(h.o(s, { restart: null, running: sup(s) }))
  const f = finish({ home: s.home, run: h.o(s).run, log: quiet, build: () => ({ ok: false, output: 'vite: out of memory' }) })
  assert.deepEqual([f.status, f.code], ['failed', 1])
  assert.equal(git(s.to, 'rev-parse', 'HEAD'), pre)
  assert.equal(read(s.to, 'server/a.ts'), 'export const a = 1\n')
  assert.deepEqual(h.npm, [`npm ci @ ${s.to}`, `npm ci @ ${s.to}`])
  assert.equal(existsSync(finishFile(s.home)), false)
  // no branch or worktree is left by then: the record names the output and the supervisor's log
  const rec = failedUpdate(s.home)!
  assert.match(rec.at, /^\d{4}-/)
  assert.deepEqual({ ...rec, at: '' }, {
    core: sha, from, repo: s.to, branch: '', worktree: '', dir: '', pre, head: '', step: 'finish',
    output: `the build failed in ${s.to}; it is back on its commit before the update:\nvite: out of memory`,
    log: join(s.home, 'logs', 'console.log'), at: '',
  })
  // the next update that passes clears it
  const r = await update(h.o(s))
  assert.deepEqual([r.status, r.sha], ['updated', sha])
  assert.equal(failedUpdate(s.home), null)
})

test('a finish whose npm ci fails is recorded the same way, and give up dismisses the record', async () => {
  const s = setup(), h = harness(), pre = git(s.to, 'rev-parse', 'HEAD')
  advance(s.origin, { 'console/package-lock.json': '{ "v": 2 }\n' })
  await update(h.o(s, { restart: null, running: sup(s) }))
  let n = 0
  const r: Runner = (cmd, args, o) => (cmd === 'npm' && args[0] === 'ci' && n++ === 0 ? { status: 1, stdout: '', stderr: 'npm ERR! ERESOLVE' } : h.o(s).run(cmd, args, o))
  assert.equal(finish({ home: s.home, run: r, log: quiet }).code, 1)
  assert.equal(git(s.to, 'rev-parse', 'HEAD'), pre)
  const rec = failedUpdate(s.home)!
  assert.equal(rec.step, 'finish')
  assert.equal(rec.output, `npm ci failed in ${s.to}; it is back on its commit before the update:\nnpm ERR! ERESOLVE`)
  assert.equal(giveUp({ home: s.home, run: h.o(s).run }), true)
  assert.equal(failedUpdate(s.home), null)
  assert.deepEqual(branches(s.to), ['main'])
  assert.equal(git(s.to, 'rev-parse', 'HEAD'), pre)
})

test('with no console, or one whose supervisor finishes nothing, npm ci and the build run in place', async () => {
  for (const running of [() => null, () => ({ pid: 1, server: 2, folder: 'x', port: 1 })]) {
    const s = setup(), h = harness()
    advance(s.origin, { 'console/package-lock.json': '{ "v": 2 }\n' })
    assert.equal((await update(h.o(s, { running }))).status, 'updated')
    assert.deepEqual(h.npm, [`npm ci @ ${s.to}`, `npm run build @ ${s.to}`])
    assert.deepEqual(h.restarts, [s.home])
    assert.equal(existsSync(finishFile(s.home)), false)
  }
})

test('fail: the result sits on update/<sha7>, the folder stays on its commit, update-failed.json has the output, exit 3', async () => {
  const s = setup(), h = harness()
  const from = JSON.parse(read(s.to, 'core.lock.json')).core
  const head = git(s.to, 'rev-parse', 'HEAD')
  const sha = advance(s.origin, { 'console/server/broken.ts': 'export const b: number = "x"\n' })
  const r = await update(h.o(s))
  const branch = `update/${sha.slice(0, 7)}`
  assert.deepEqual([r.status, r.code, r.branch], ['reintegrate', EXIT_REINTEGRATE, branch])
  assert.equal(EXIT_REINTEGRATE, 3)
  assert.equal(git(s.to, 'rev-parse', 'HEAD'), head)
  assert.equal(existsSync(join(s.to, 'server', 'broken.ts')), false)
  assert.equal(subjects(s.to, branch)[0], `core ${sha.slice(0, 7)}`)
  const f = failedUpdate(s.home)!
  assert.equal(f.core, sha)
  assert.equal(f.from, from)
  assert.equal(f.pre, head)
  assert.equal(f.branch, branch)
  assert.equal(f.step, 'typecheck')
  assert.match(f.output, /TS2322/)
  assert.equal(existsSync(join(f.worktree, 'server', 'broken.ts')), true, 'the worktree is kept for the session')
  assert.equal(f.worktree, join(updatesDir(s.home), sha.slice(0, 7)), 'beside home, so an agent may read it')
  assert.equal(updatesDir(s.home), `${s.home}-updates`)
  assert.deepEqual([h.npm, h.restarts], [[], []])
})

test('a sync conflict lands on the reintegrate path with step sync', async () => {
  const s = setup(), h = harness()
  // a core file edited in the folder and committed: the next sync refuses it
  put(s.to, 'server/a.ts', 'export const a = 99\n')
  git(s.to, 'commit', '-q', '-am', 'edit a core file')
  advance(s.origin, { 'console/server/a.ts': 'export const a = 2\n' })
  const r = await update(h.o(s))
  assert.equal(r.status, 'reintegrate')
  const f = failedUpdate(s.home)!
  assert.equal(f.step, 'sync')
  assert.match(f.output, /server\/a\.ts/)
  assert.equal(h.checked.length, 0)
  assert.equal(read(s.to, 'server/a.ts'), 'export const a = 99\n')
})

test('a fix committed on update/<sha7> is applied by the next run', async () => {
  const s = setup(), h = harness()
  const sha = advance(s.origin, { 'console/server/broken.ts': 'broken\n' })
  assert.equal((await update(h.o(s))).status, 'reintegrate')
  const f = failedUpdate(s.home)!
  // what a reintegrate session does: a workspace change, committed on the branch
  put(f.worktree, 'workspaces/home/fix.ts', 'export {}\n')
  git(f.worktree, 'add', '-A')
  git(f.worktree, 'commit', '-q', '-m', 'home: follow the core')
  const r = await update(h.o(s, { pull: false }))
  assert.deepEqual([r.status, r.sha], ['updated', sha])
  assert.deepEqual(subjects(s.to).slice(0, 2), ['home: follow the core', `core ${sha.slice(0, 7)}`])
  assert.equal(existsSync(join(s.to, 'workspaces', 'home', 'fix.ts')), true)
  assert.equal(failedUpdate(s.home), null)
  assert.equal(existsSync(f.worktree), false)
  assert.deepEqual(h.restarts, [s.home])
})

test('an uncommitted fix in the worktree is refused, not applied', async () => {
  const s = setup(), h = harness()
  advance(s.origin, { 'console/server/broken.ts': 'broken\n' })
  await update(h.o(s))
  const f = failedUpdate(s.home)!
  put(f.worktree, 'workspaces/home/fix.ts', 'export {}\n')
  const r = await update(h.o(s))
  assert.equal(r.status, 'refused')
  assert.equal(existsSync(f.worktree), true)
  assert.deepEqual(failedUpdate(s.home), f)
})

test('a later passing update clears update-failed.json and the stale worktree', async () => {
  const s = setup(), h = harness()
  const bad = advance(s.origin, { 'console/server/broken.ts': 'broken\n' })
  await update(h.o(s))
  const stale = failedUpdate(s.home)!
  const good = advance(s.origin, { 'console/server/broken.ts': null }, 'unbreak')
  assert.notEqual(good, bad)
  const r = await update(h.o(s))
  assert.deepEqual([r.status, r.sha], ['updated', good])
  assert.equal(failedUpdate(s.home), null)
  assert.equal(existsSync(stale.worktree), false)
  assert.deepEqual(branches(s.to), ['main'])
  assert.equal(existsSync(join(s.to, 'server', 'broken.ts')), false)
})

test('giveUp drops the worktree, the branch and the record; the folder is as before', async () => {
  const s = setup(), h = harness()
  const head = git(s.to, 'rev-parse', 'HEAD')
  advance(s.origin, { 'console/server/broken.ts': 'broken\n' })
  await update(h.o(s))
  const f = failedUpdate(s.home)!
  assert.equal(giveUp({ home: s.home, run: h.o(s).run }), true)
  assert.equal(failedUpdate(s.home), null)
  assert.equal(existsSync(f.worktree), false)
  assert.deepEqual(branches(s.to), ['main'])
  assert.equal(git(s.to, 'rev-parse', 'HEAD'), head)
  assert.equal(giveUp({ home: s.home, run: h.o(s).run }), false)
})

test('a build that fails in the folder puts it back on its commit and does not restart', async () => {
  const s = setup(), h = harness()
  const head = git(s.to, 'rev-parse', 'HEAD')
  advance(s.origin, { 'console/server/a.ts': 'export const a = 2\n' })
  const r = await update(h.o(s, { build: () => ({ ok: false, output: 'vite: out of memory' }) }))
  assert.deepEqual([r.status, r.code], ['failed', 1])
  assert.equal(git(s.to, 'rev-parse', 'HEAD'), head)
  assert.equal(read(s.to, 'server/a.ts'), 'export const a = 1\n')
  assert.deepEqual(h.restarts, [])
  // the next run starts over cleanly
  assert.equal((await update(h.o(s))).status, 'updated')
  assert.deepEqual(branches(s.to), ['main'])
})

test('a console dir inside a larger repo updates the same way', async () => {
  const s = setup(), h = harness()
  // the folder moved under services/console of a repo that holds more than the console
  const outer = tmp('outer'), inner = join(outer, 'services', 'console')
  mkdirSync(dirname(inner), { recursive: true })
  cpSync(s.to, inner, { recursive: true, filter: (src) => !src.split(/[\\/]/).includes('.git') })
  put(outer, 'README.md', 'more than the console\n')
  git(outer, 'init', '-q', '-b', 'main')
  git(outer, 'add', '-A')
  git(outer, 'commit', '-q', '-m', 'outer')
  put(outer, 'notes.txt', 'outside the console, not committed\n')
  const sha = advance(s.origin, { 'console/server/a.ts': 'export const a = 2\n' })
  const r = await update(h.o(s, { folder: inner }))
  assert.deepEqual([r.status, r.sha], ['updated', sha])
  assert.equal(read(inner, 'server/a.ts'), 'export const a = 2\n')
  assert.equal(git(outer, 'show', '--name-only', '--format=', 'HEAD').split('\n').every((p) => p.startsWith('services/console/')), true)
  assert.equal(read(outer, 'notes.txt'), 'outside the console, not committed\n')
})
