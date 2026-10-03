import { execFile } from 'node:child_process'
import { lstat, mkdir, symlink, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Job } from '../../src/model/types.ts'

/* A job's own work dir: a git worktree on job/<id>, made by the console before the job's first run and
   removed when the job closes, never by the LLM. Dirs a fresh worktree lacks (node_modules) are linked
   in as junctions, so a run can build and test without installing; they are unlinked before the
   worktree goes, because git would delete through them. */

export interface WorkDir {
  /** the job's dir, made on first use; every run's cwd */
  dir(j: Job): Promise<string>
  /** the branch the dir is on, for the prompt */
  branch?(j: Job): string
  /** the job closed: remove what dir made; one line for the journal, or null when there was nothing to do */
  closed?(j: Job): Promise<string | null>
}
export type RepoSpec = { path: string; base: string; links?: string[] }

const exists = (p: string) => lstat(p).then(() => true, () => false)

/** a worktree per job from the repo its project names; root holds one dir per job id */
export function gitWorktrees(o: { repos: Record<string, RepoSpec>; root: string; git?: string }): WorkDir {
  const git = (cwd: string, ...args: string[]) => new Promise<string>((res, rej) =>
    execFile(o.git ?? 'git', ['-C', cwd, ...args], { windowsHide: true }, (e, out, err) => (e ? rej(new Error((err || e.message).trim())) : res(out.trim()))))
  const branch = (j: Job) => `job/${j.id.toLowerCase()}`
  const at = (j: Job) => join(o.root, j.id)
  const repo = (j: Job) => {
    const r = Object.hasOwn(o.repos, j.prj) ? o.repos[j.prj] : undefined
    if (!r) throw new Error(`no repo for project ${j.prj}`)
    return r
  }
  const hasBranch = (r: RepoSpec, b: string) => git(r.path, 'rev-parse', '--verify', '--quiet', `refs/heads/${b}`).then(() => true, () => false)
  const unlinkAll = async (r: RepoSpec, d: string) => {
    for (const l of r.links ?? []) { const p = join(d, l); if ((await lstat(p).catch(() => null))?.isSymbolicLink()) await unlink(p) }
  }
  const linkAll = async (r: RepoSpec, d: string) => {
    for (const l of r.links ?? []) {
      const target = join(r.path, l), p = join(d, l)
      if (!(await exists(target)) || (await exists(p))) continue
      await mkdir(dirname(p), { recursive: true })
      await symlink(target, p, 'junction')
    }
  }

  return {
    branch,
    async dir(j) {
      const r = repo(j), d = at(j), b = branch(j)
      if (!(await exists(d))) {
        await mkdir(o.root, { recursive: true })
        if (await hasBranch(r, b)) await git(r.path, 'worktree', 'add', d, b)
        else await git(r.path, 'worktree', 'add', '-b', b, d, r.base)
      }
      await linkAll(r, d)
      return d
    },
    async closed(j) {
      const r = Object.hasOwn(o.repos, j.prj) ? o.repos[j.prj] : undefined
      if (!r) return null
      const d = at(j), b = branch(j), hasDir = await exists(d), hasB = await hasBranch(r, b)
      if (!hasDir && !hasB) return null
      const done: string[] = []
      if (hasDir) {
        const dirty = await git(d, 'status', '--porcelain').catch((e: Error) => `unreadable: ${e.message}`)
        if (dirty) return `Kept the work dir ${d} and branch ${b}: it has uncommitted changes (${dirty.split('\n').length} paths).`
        await unlinkAll(r, d)
        try { await git(r.path, 'worktree', 'remove', d) } catch (e) {
          await linkAll(r, d).catch(() => {})
          return `Kept the work dir ${d} and branch ${b}: ${(e as Error).message}`
        }
        done.push(`removed the work dir ${d}`)
      }
      if (hasB) {
        // merged means into base, whatever the repo's own checkout is on; -d would ask its HEAD instead
        const merged = await git(r.path, 'merge-base', '--is-ancestor', b, r.base).then(() => true, () => false)
        if (!merged) return `${done.length ? `Removed the work dir ${d}; kept` : 'Kept'} branch ${b}: it is not merged into ${r.base}.`
        await git(r.path, 'branch', '-D', b)
        done.push(`deleted branch ${b}`)
      }
      return `Cleaned up: ${done.join(', ')}.`
    },
  }
}
