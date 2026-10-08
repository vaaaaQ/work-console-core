#!/usr/bin/env node
import { existsSync, realpathSync, rmSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { consoleHome, gitId, npmChecks, readJson, run, tail, writeJson } from './lib.mjs'
import { requestRestart } from './run.mjs'

/* Moves the console to the core's newest commit:
     node <dir>/scripts/update.mjs [--no-pull] [--core <core repo>] [--give-up]
   pull the core, then sync and check in a git worktree at <home>-updates/<sha7> on branch update/<sha7>.
   Pass: the folder fast-forwards to it, builds and restarts. Fail: the folder is untouched, the worktree stays,
   <home>/update-failed.json says what failed, exit 3; a reintegrate session commits its fix on the branch and
   runs the update again, which applies it. --give-up drops the branch and the worktree. */

export const EXIT_REINTEGRATE = 3
const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RECORD = 'update-failed.json'

export const failedUpdate = (home) => readJson(join(home, RECORD), null)
/** beside home, not in it: the providers keep agents from reading a default home */
export const updatesDir = (home) => `${resolve(home)}-updates`

function git(r, cwd, args) {
  const g = r('git', ['-C', cwd, ...args])
  if (g.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(g.stderr || g.error?.message || '').trim()}`)
  return g.stdout.trim()
}
const tryGit = (r, cwd, args) => r('git', ['-C', cwd, ...args]).status === 0

/** the core's own sync-core.mjs, so a core that changed how it syncs syncs itself */
const coreSync = (r) => ({ core, to, rev }) => {
  const s = r(process.execPath, [join(core, 'console', 'scripts', 'sync-core.mjs'), '--to', to, '--ref', rev])
  if (s.status !== 0) throw new Error((s.stderr || s.stdout || s.error?.message || 'sync-core failed').trim())
}
const npmBuild = (r) => (dir) => {
  const b = r('npm', ['run', 'build'], { cwd: dir })
  return { ok: b.status === 0, output: tail(`${b.stdout}\n${b.stderr}`) }
}

/** the worktree and its branch go; a worktree git cannot remove (a locked file) is deleted and pruned */
function drop(r, repo, rec) {
  if (rec.worktree && existsSync(rec.worktree) && !tryGit(r, repo, ['worktree', 'remove', '--force', rec.worktree])) {
    rmSync(rec.worktree, { recursive: true, force: true })
  }
  tryGit(r, repo, ['worktree', 'prune'])
  if (rec.branch) tryGit(r, repo, ['branch', '-D', rec.branch])
}

/** a session worked on the branch: a commit past the update's own, or edits not committed yet */
const touched = (r, rec) => git(r, rec.worktree, ['rev-parse', 'HEAD']) !== rec.head || git(r, rec.worktree, ['status', '--porcelain']) !== ''

export function giveUp({ home, run: r = run }) {
  const rec = failedUpdate(home)
  if (!rec) return false
  drop(r, rec.repo, rec)
  rmSync(join(home, RECORD), { force: true })
  return true
}

export async function update(o) {
  const { home, pull = true, run: r = run, log = console.log, restart = requestRestart } = o
  const check = o.check ?? ((dir) => npmChecks(dir, { run: r, log: (l) => log(`  ${l}`), build: true }))
  const syncTo = o.sync ?? coreSync(r)
  const build = o.build ?? npmBuild(r)
  const folder = resolve(o.folder)
  const refused = (why) => { log(why); return { status: 'refused', code: 1 } }

  const core = o.core ?? readJson(join(home, 'install.json'), {}).core
  if (!core) return refused(`no core recorded in ${join(home, 'install.json')}: pass --core <core repo>`)
  const lock = readJson(join(folder, 'core.lock.json'), null)
  if (!lock?.core) return refused(`${folder} has no core.lock.json: install it first`)
  const repo = resolve(git(r, folder, ['rev-parse', '--show-toplevel']))
  const rel = relative(repo, folder)
  if (!tryGit(r, repo, ['symbolic-ref', '-q', 'HEAD'])) return refused(`${repo} is not on a branch: check one out first`)
  if (git(r, folder, ['status', '--porcelain', '--', '.'])) return refused(`${folder} has changes that are not committed: commit or drop them, then update`)

  if (pull) {
    const p = r('git', ['-C', core, 'pull', '--ff-only', '-q'])
    if (p.status !== 0) return refused(`git pull in ${core} failed: ${(p.stderr || p.error?.message || '').trim()}`)
  }
  let sha = git(r, core, ['rev-parse', 'HEAD'])
  const from = lock.core

  // an open reintegration is finished before the core moves on; one nobody touched is dropped for the newer core
  let rec = failedUpdate(home), reuse = false
  if (rec && rec.core !== from && rec.step !== 'sync' && existsSync(rec.worktree) && (rec.core === sha || touched(r, rec))) {
    if (git(r, rec.worktree, ['status', '--porcelain'])) return refused(`${rec.worktree} has changes that are not committed: commit the fix on ${rec.branch}, or run update.mjs --give-up`)
    sha = rec.core
    reuse = true
  } else if (rec) {
    drop(r, repo, rec)
    rmSync(join(home, RECORD), { force: true })
    rec = null
  }
  if (!reuse && sha === from) { log(`already at core ${sha.slice(0, 7)}`); return { status: 'current', code: 0, sha } }

  const sha7 = sha.slice(0, 7), branch = `update/${sha7}`
  const worktree = reuse ? rec.worktree : join(updatesDir(home), sha7)
  const dir = join(worktree, rel)
  const pre = reuse ? rec.pre : git(r, repo, ['rev-parse', 'HEAD'])
  const fail = (step, output) => {
    const head = git(r, worktree, ['rev-parse', 'HEAD'])
    writeJson(join(home, RECORD), { core: sha, from, repo, branch, worktree, dir, pre, head, step, output, at: new Date().toISOString() })
    log(`the update to core ${sha7} failed at ${step}; the folder is unchanged.\nThe result is on ${branch} in ${worktree}: fix it there, commit, and run the update again (or --give-up).`)
    return { status: 'reintegrate', code: EXIT_REINTEGRATE, sha, branch }
  }

  if (!reuse) {
    log(`updating from core ${from.slice(0, 7)} to ${sha7} in ${worktree}`)
    drop(r, repo, { worktree, branch })
    git(r, repo, ['worktree', 'add', '-q', '-B', branch, worktree, 'HEAD'])
    try { syncTo({ core, to: dir, rev: sha }) } catch (e) { return fail('sync', tail(e.message)) }
    git(r, dir, ['add', '-A', '--', '.'])
    git(r, dir, [...gitId(dir, r), 'commit', '-q', '--allow-empty', '-m', `core ${sha7}`])
  } else log(`checking ${branch} again in ${worktree}`)

  const c = check(dir)
  if (!c.ok) return fail(c.step ?? 'check', c.output ?? '')

  const m = r('git', ['-C', repo, 'merge', '-q', '--ff-only', branch])
  if (m.status !== 0) return refused(`${repo} moved since ${branch} was made, so it cannot fast-forward: run update.mjs --give-up, then update again`)
  const lockChanged = !tryGit(r, repo, ['diff', '--quiet', pre, 'HEAD', '--', join(rel, 'package-lock.json').replaceAll('\\', '/')])
  const ci = lockChanged ? r('npm', ['ci'], { cwd: folder }) : { status: 0 }
  const b = ci.status === 0 ? build(folder) : { ok: false, output: tail(`${ci.stdout}\n${ci.stderr}`) }
  if (!b.ok) {
    // back to the commit before the update, so the next start runs what ran before
    git(r, repo, ['reset', '-q', '--keep', pre])
    if (lockChanged) r('npm', ['ci'], { cwd: folder })
    log(`${ci.status === 0 ? 'the build' : 'npm ci'} failed in ${folder}; it is back on its commit before the update:\n${b.output}`)
    return { status: 'failed', code: 1, sha }
  }
  drop(r, repo, { worktree, branch })
  rmSync(join(home, RECORD), { force: true })
  log(`updated to core ${sha7}`)
  log(restart(home) ? 'restarting the console' : `the console is not running: node ${join(folder, 'scripts', 'run.mjs')} --detach starts it`)
  return { status: 'updated', code: 0, sha }
}

function cli(argv) {
  const o = { pull: true, core: undefined, giveUp: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--no-pull') o.pull = false
    else if (argv[i] === '--core') o.core = resolve(argv[++i] ?? '')
    else if (argv[i] === '--give-up') o.giveUp = true
    else throw new Error(`unknown argument ${argv[i]}\nusage: node scripts/update.mjs [--no-pull] [--core <core repo>] [--give-up]`)
  }
  const home = consoleHome()
  if (o.giveUp) { console.log(giveUp({ home }) ? 'dropped the failed update' : 'no failed update'); return Promise.resolve({ code: 0 }) }
  return update({ home, folder: HERE, core: o.core, pull: o.pull })
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  cli(process.argv.slice(2)).then((r) => { process.exitCode = r.code }, (e) => { console.error(e.message); process.exitCode = 1 })
}
