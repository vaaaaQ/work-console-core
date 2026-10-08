import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Job } from '../../src/model/types.ts'
import { gitWorktrees } from './worktree.ts'
import { tempDir } from '../testdirs.ts'

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, '-c', 'core.autocrlf=false', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { encoding: 'utf8' }).trim()

/** a repo on main with one commit, an ignored node_modules holding one file, and an empty root for job dirs */
function setup() {
  const top = tempDir('wt'), repo = join(top, 'repo'), root = join(top, 'jobs')
  mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true })
  git(top, 'init', '-q', '-b', 'main', repo)
  // the worktrees share this config, so their checkouts match the test's own git calls
  git(repo, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  writeFileSync(join(repo, 'node_modules', 'pkg', 'x.txt'), 'kept')
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'one')
  const wd = gitWorktrees({ repos: { main: { path: repo, base: 'main', links: ['node_modules', 'missing'] } }, root })
  const job = (id = 'AD-0001', prj = 'main') => ({ id, prj }) as unknown as Job
  return { repo, root, wd, job }
}

test('dir makes a worktree on job/<id> from base, links what exists, and is the same dir the second time', async () => {
  const { repo, root, wd, job } = setup()
  const d = await wd.dir(job())
  assert.equal(d, join(root, 'AD-0001'))
  assert.equal(git(d, 'branch', '--show-current'), 'job/ad-0001')
  assert.equal(git(d, 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'main'))
  assert.ok(lstatSync(join(d, 'node_modules')).isSymbolicLink())
  assert.equal(readFileSync(join(d, 'node_modules', 'pkg', 'x.txt'), 'utf8'), 'kept')
  assert.ok(!existsSync(join(d, 'missing')), 'a link whose target is missing is skipped')
  assert.equal(await wd.dir(job()), d)
  assert.equal(git(d, 'status', '--porcelain'), '', 'the link is ignored, so the worktree is clean')
  assert.equal(wd.branch!(job()), 'job/ad-0001')
  await assert.rejects(wd.dir(job('AD-0002', 'other')), /no repo for project other/)
})

test('a job whose branch already exists gets a worktree on it', async () => {
  const { repo, wd, job } = setup()
  git(repo, 'branch', 'job/ad-0003')
  const d = await wd.dir(job('AD-0003'))
  assert.equal(git(d, 'branch', '--show-current'), 'job/ad-0003')
})

test('closed on a clean, merged worktree removes the dir and the branch; the link target survives', async () => {
  const { repo, wd, job } = setup()
  assert.equal(await wd.closed!(job()), null, 'nothing made, nothing to say')
  const d = await wd.dir(job())
  const line = await wd.closed!(job())
  assert.match(line!, /removed the work dir .*AD-0001, deleted branch job\/ad-0001/)
  assert.ok(!existsSync(d))
  assert.equal(git(repo, 'branch', '--list', 'job/ad-0001'), '')
  assert.equal(readFileSync(join(repo, 'node_modules', 'pkg', 'x.txt'), 'utf8'), 'kept')
  assert.equal(await wd.closed!(job()), null, 'a second close has nothing to do')
})

test('closed keeps a dirty worktree with its branch, and keeps an unmerged branch after removing its dir', async () => {
  const { repo, wd, job } = setup()
  const d = await wd.dir(job())
  writeFileSync(join(d, 'b.txt'), 'b\n')
  assert.match((await wd.closed!(job()))!, /Kept the work dir .* uncommitted changes \(1 paths\)/)
  assert.ok(existsSync(d))
  assert.ok(lstatSync(join(d, 'node_modules')).isSymbolicLink(), 'a kept dir keeps its link')
  git(d, 'add', '.'); git(d, 'commit', '-q', '-m', 'two')
  assert.match((await wd.closed!(job()))!, /Removed the work dir .*; kept branch job\/ad-0001: it is not merged into main/)
  assert.ok(!existsSync(d))
  assert.notEqual(git(repo, 'branch', '--list', 'job/ad-0001'), '')
  assert.equal(readFileSync(join(repo, 'node_modules', 'pkg', 'x.txt'), 'utf8'), 'kept')
  git(repo, 'merge', '-q', '--ff-only', 'job/ad-0001')
  assert.match((await wd.closed!(job()))!, /^Cleaned up: deleted branch job\/ad-0001\.$/)
})
