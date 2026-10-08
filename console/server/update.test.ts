import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FailedUpdate } from '../scripts/update.mjs'
import type { UpdateView } from '../src/model/update.ts'
import { realExec } from './agent/ops.ts'
import type { Exec } from './agent/ops.ts'
import { Updates } from './update.ts'

/* Updates over a throwaway repo: a folder commit, the update's "core" commit and a fix after it. git runs for real;
   update.mjs is a stand-in that does what the real one would to the record and the lock. */

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim()
const put = (root: string, p: string, body: string) => { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), body) }

function setup(o: { step?: string } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'wc-updates-')), dir = join(repo, 'console'), home = join(repo, 'home')
  mkdirSync(home)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't')
  put(dir, 'server/local.ts', 'export interface LocalOpts { needDb?: boolean }\n')
  put(dir, 'core.lock.json', '{ "core": "old" }\n')
  put(dir, 'package-lock.json', '{ "v": 1 }\n')
  put(repo, 'README.md', 'outside the console\n')
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'folder')
  const pre = git(repo, 'rev-parse', 'HEAD')
  put(dir, 'server/local.ts', 'export interface LocalOpts { db?: boolean }\n')
  put(dir, 'core.lock.json', '{ "core": "new" }\n')
  put(dir, 'package-lock.json', '{ "v": 2 }\n')
  put(repo, 'README.md', 'changed outside the console\n')
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'core eeeeeee')
  put(dir, 'workspaces/home/page.ts', 'export const db = true\n')
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'home: the fix')
  const f: FailedUpdate = { core: 'e'.repeat(40), from: 'f'.repeat(40), repo, branch: 'update/eeeeeee', worktree: repo, dir, pre, head: pre,
    step: o.step ?? 'typecheck', output: "error TS2353: 'needDb'", at: '2026-10-08T12:00:00.000Z' }
  writeFileSync(join(home, 'update-failed.json'), JSON.stringify(f))
  // the console the update runs for: its own lock, which an applied update moves on
  const root = join(repo, 'served')
  put(root, 'core.lock.json', '{ "core": "old" }\n')
  type Ran = { args: string[]; env?: Record<string, string> }
  const views: (UpdateView | null)[] = [], ran: Ran[] = [], order: string[] = []
  let idle: () => void = () => {}
  const waiting = { on: false }
  let then: (args: string[]) => { code: number; out: string } = () => {
    rmSync(join(home, 'update-failed.json')); put(root, 'core.lock.json', '{ "core": "new" }\n'); return { code: 0, out: 'updated to core eeeeeee\nthe console restarts itself' }
  }
  const exec: Exec = async (cmd, args, opt) => {
    if (cmd === 'git') return realExec(cmd, args, opt)
    ran.push({ args, env: opt.env }); order.push('exec')
    return then(args)
  }
  const u = new Updates({
    home, root, exec, emit: (v) => views.push(v),
    idle: () => (waiting.on ? new Promise((ok) => { idle = ok }) : Promise.resolve()),
    restart: () => order.push('restart'),
  })
  return {
    u, f, home, root, views, ran, order, waiting,
    release: () => idle(),
    setThen: (g: typeof then) => { then = g },
  }
}

test('the view mirrors the record; only typecheck, tests and build are reintegrable', () => {
  const x = setup()
  assert.deepEqual(x.u.view(), { core: x.f.core, from: x.f.from, branch: x.f.branch, step: 'typecheck', output: x.f.output, at: x.f.at, reintegrable: true, running: null })
  assert.equal(setup({ step: 'sync' }).u.view()?.reintegrable, false)
  rmSync(join(x.home, 'update-failed.json'))
  assert.equal(x.u.view(), null)
})

test("the diff is the update's own commit as it lands in the console: the locks, the fix after it and files outside left out", async () => {
  const x = setup()
  const d = await x.u.diff(x.f)
  assert.match(d, /server\/local\.ts/)
  assert.match(d, /-export interface LocalOpts \{ needDb\?: boolean \}/)
  assert.match(d, /\+export interface LocalOpts \{ db\?: boolean \}/)
  assert.doesNotMatch(d, /core\.lock\.json|package-lock\.json|README|workspaces\/home/)
})

test('apply runs update.mjs without a pull or its own restart, after the turns end; an update that applied is reported, then restarts', async () => {
  const x = setup()
  x.waiting.on = true
  const reported: unknown[] = []
  const p = x.u.run('apply', async (r) => { reported.push(r); x.order.push('report') })
  assert.equal(x.u.updating(), true)
  assert.equal(x.views[0]?.running, 'apply')
  await new Promise((ok) => setTimeout(ok, 10))
  assert.equal(x.ran.length, 0, 'not while a turn runs')
  x.release()
  const end = await p
  assert.deepEqual(x.ran.map((r) => r.args.slice(1)), [['--no-pull', '--no-restart']])
  assert.match(x.ran[0].args[0], /scripts[\\/]update\.mjs$/)
  assert.deepEqual(x.ran[0].env, { WORK_CONSOLE_HOME: x.home })
  assert.deepEqual([end.code, end.updated, end.failed], [0, true, null])
  assert.deepEqual(x.order, ['exec', 'report', 'restart'])
  assert.equal(reported.length, 1)
  assert.equal(x.u.updating(), false)
  assert.equal(x.views.at(-1), null, 'the record is gone')
})

test('an update that fails again keeps its record with the last run; give up runs --give-up once the turn that runs ends', async () => {
  const x = setup()
  x.setThen(() => ({ code: 3, out: 'the update to core eeeeeee failed at tests' }))
  const end = await x.u.run('apply')
  assert.deepEqual([end.code, end.updated, end.failed?.branch], [3, false, 'update/eeeeeee'])
  assert.deepEqual(x.order, ['exec'], 'no restart')
  const v = x.u.view()!
  assert.deepEqual([v.running, v.last?.kind, v.last?.code], [null, 'apply', 3])
  assert.match(v.last!.output, /failed at tests/)

  x.setThen(() => { rmSync(join(x.home, 'update-failed.json')); return { code: 0, out: 'dropped the failed update' } })
  x.waiting.on = true
  assert.equal(x.u.start('give-up')?.running, 'give-up')
  assert.throws(() => x.u.start('apply'), /runs already/)
  await new Promise((ok) => setTimeout(ok, 10))
  assert.equal(x.ran.length, 1, 'the turn runs yet')
  x.release()
  while (x.u.updating()) await new Promise((ok) => setTimeout(ok, 5))
  assert.deepEqual(x.ran.at(-1)?.args.slice(1), ['--give-up', '--no-restart'])
  assert.equal(x.u.view(), null)
  assert.throws(() => x.u.start('apply'), /no failed core update/)
})
