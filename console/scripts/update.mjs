#!/usr/bin/env node
import { existsSync, realpathSync, rmSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { consoleHome, gitId, npmChecks, readJson, run, tail, writeJson } from './lib.mjs'
import { finishFile, requestRestart, supervisorOf, waitUp } from './run.mjs'

/* Moves the console to the core's newest commit:
     node <dir>/scripts/update.mjs [--no-pull] [--core <core repo>] [--give-up] [--no-restart] [--finish]
   pull the core, then sync and check in a git worktree at <home>-updates/<sha7> on branch update/<sha7>.
   Pass: the folder fast-forwards to it, builds and restarts. Fail: the folder is untouched, the worktree stays,
   <home>/update-failed.json says what failed, exit 3; a reintegrate session commits its fix on the branch and
   runs the update again, which applies it. --give-up drops the branch and the worktree. --no-restart leaves the
   restart to the console that runs this, so it can wait for its agents' turns.
   npm ci runs only when the npm lock changed; under run.mjs it waits for the restart, after the agents' turns, and
   the supervisor runs --finish (npm ci, the build) before it starts the server again. */

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

/** npm ci when the lock changed, then the build; a failure puts the folder back on pre, so the next start runs what ran before */
function install(r, build, log, { repo, folder, pre, sha, ci: lockChanged }) {
  const ci = lockChanged ? r('npm', ['ci'], { cwd: folder }) : { status: 0 }
  const b = ci.status === 0 ? build(folder) : { ok: false, output: tail(`${ci.stdout}\n${ci.stderr}`) }
  if (b.ok) return { status: 'updated', code: 0, sha }
  git(r, repo, ['reset', '-q', '--keep', pre])
  if (lockChanged) r('npm', ['ci'], { cwd: folder })
  log(`${ci.status === 0 ? 'the build' : 'npm ci'} failed in ${folder}; it is back on its commit before the update:\n${b.output}`)
  return { status: 'failed', code: 1, sha }
}

/** the supervisor's step between the server's exit and its next start: npm ci and the build for an update left to it */
export function finish({ home, run: r = run, log = console.log, build }) {
  const rec = readJson(finishFile(home), null)
  if (!rec) return { status: 'none', code: 0 }
  try {
    const x = install(r, build ?? npmBuild(r), log, { ...rec, ci: true })
    if (x.code === 0) log(`updated to core ${rec.sha.slice(0, 7)}`)
    return x
  } finally { rmSync(finishFile(home), { force: true }) }
}

/** settles once the supervisor finished the update and the console answers; false when it did not within the time */
async function settled(home, port, { timeoutMs = 3 * 60 * 60_000 } = {}) {
  for (const end = Date.now() + timeoutMs; existsSync(finishFile(home)); await new Promise((ok) => setTimeout(ok, 1000))) {
    if (Date.now() > end || !supervisorOf(home)) return false
  }
  try { await waitUp({ port, home, timeoutMs: 120_000 }) } catch { /* reported from the folder's commit */ }
  return true
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
  const { home, pull = true, run: r = run, log = console.log, restart = requestRestart, running = supervisorOf, settle = settled } = o
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
  const sup = lockChanged ? running(home) : null
  if (sup?.finish) {
    // npm ci rewrites node_modules under a running server, so its supervisor runs it once the server has exited
    writeJson(finishFile(home), { folder, repo, pre, sha })
    drop(r, repo, { worktree, branch })
    rmSync(join(home, RECORD), { force: true })
    if (!restart) { log('the console runs npm ci and the build when it restarts'); return { status: 'updated', code: 0, sha } }
    log(`merged core ${sha7}; the console restarts once no agent turn runs, and runs npm ci and the build first`)
    if (!await restart(home)) return finish({ home, run: r, log, build })
    if (!await settle(home, sup.port)) {
      log(`the console has not finished the update yet; see ${join(home, 'logs', 'console.log')}`)
      return { status: 'updated', code: 0, sha }
    }
    if (git(r, repo, ['rev-parse', 'HEAD']) === pre) {
      log(`npm ci or the build failed in ${folder}; it is back on its commit before the update: see ${join(home, 'logs', 'console.log')}`)
      return { status: 'failed', code: 1, sha }
    }
    log(`updated to core ${sha7}`)
    return { status: 'updated', code: 0, sha }
  }
  const x = install(r, build, log, { repo, folder, pre, sha, ci: lockChanged })
  if (x.code !== 0) return x
  drop(r, repo, { worktree, branch })
  rmSync(join(home, RECORD), { force: true })
  log(`updated to core ${sha7}`)
  if (!restart) log('the console restarts itself')
  else log(await restart(home) ? 'restarting the console once no agent turn runs' : `the console is not running: node ${join(folder, 'scripts', 'run.mjs')} --detach starts it`)
  return { status: 'updated', code: 0, sha }
}

function cli(argv) {
  const o = { pull: true, core: undefined, giveUp: false, finish: false, restart: undefined }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--no-pull') o.pull = false
    else if (argv[i] === '--core') o.core = resolve(argv[++i] ?? '')
    else if (argv[i] === '--give-up') o.giveUp = true
    else if (argv[i] === '--no-restart') o.restart = null
    else if (argv[i] === '--finish') o.finish = true
    else throw new Error(`unknown argument ${argv[i]}\nusage: node scripts/update.mjs [--no-pull] [--core <core repo>] [--give-up] [--no-restart] [--finish]`)
  }
  const home = consoleHome()
  if (o.finish) return Promise.resolve(finish({ home }))
  if (o.giveUp) { console.log(giveUp({ home }) ? 'dropped the failed update' : 'no failed update'); return Promise.resolve({ code: 0 }) }
  return update({ home, folder: HERE, core: o.core, pull: o.pull, restart: o.restart })
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  cli(process.argv.slice(2)).then((r) => { process.exitCode = r.code }, (e) => { console.error(e.message); process.exitCode = 1 })
}
