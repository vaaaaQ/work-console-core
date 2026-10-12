import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { writeAreas } from './limits.ts'
import { realExec } from './ops.ts'
import type { Exec } from './ops.ts'

/* The workspace agent's own git worktree, one per workspace: <base>/<ws> on branch agent/<ws>, base being <home>-agents
   beside update.mjs's <home>-updates. The agent writes only there; its changes reach the live folder by Ops.apply's
   fast-forward and no other way, so a failed apply, a stopped turn or a crash leave the live folder as it was.
   node_modules there is a junction to the live folder's, so a worktree costs no npm ci and runs what the console runs. */

const z = (out: string) => out.split('\0').filter(Boolean)
const lit = (f: string) => `:(literal)${f}`

export type Adopted = { moved: string[] } | { skipped: string }

/** where the agents' worktrees go: beside the console's home, as update.mjs's <home>-updates */
export const agentsDir = (home: string) => `${resolve(home)}-agents`

/** whether dir is inside a git work tree */
export function inGit(dir: string): boolean {
  try { return execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim() === 'true' } catch { return false }
}

export class AgentTrees {
  private live: string
  private base: string
  private exec: Exec
  private loc: { top: string; rel: string } | null = null

  /** live = the console's folder; base = the folder the worktrees go in */
  constructor(o: { live: string; base: string; exec?: Exec }) {
    this.live = resolve(o.live)
    this.base = resolve(o.base)
    this.exec = o.exec ?? realExec
  }

  /** the live repo's top and the console folder within it, as update.mjs computes them */
  private where() {
    if (!this.loc) {
      const top = realpathSync.native(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: this.live, encoding: 'utf8', windowsHide: true }).trim())
      this.loc = { top, rel: relative(top, realpathSync.native(this.live)) }
    }
    return this.loc
  }

  private async git(cwd: string, ...args: string[]) {
    const r = await this.exec('git', args, { cwd })
    if (r.code !== 0) throw new Error(`git ${args[0]}: ${r.out.trim().split(/\r?\n/).slice(-3).join(' ')}`)
    return r.stdout
  }

  /** files under ws's areas changed against HEAD or new, relative to dir, sorted */
  private async changes(dir: string, ws: string): Promise<{ tracked: string[]; fresh: string[]; all: string[] }> {
    const areas = writeAreas(ws)
    const tracked = z(await this.git(dir, 'diff', '--name-only', '-z', '--no-renames', '--relative', 'HEAD', '--', ...areas))
    const fresh = z(await this.git(dir, 'ls-files', '-z', '--others', '--exclude-standard', '--', ...areas))
    return { tracked, fresh, all: [...new Set([...tracked, ...fresh])].sort() }
  }

  private tree(ws: string) { return join(this.base, ws) }

  /** the console folder in ws's worktree, or null while it has none */
  has(ws: string): string | null {
    const t = this.tree(ws)
    return existsSync(join(t, '.git')) ? join(t, this.where().rel) : null
  }

  /** the console folder in ws's worktree, made at the live HEAD on first use, with node_modules joined to the live one */
  async dir(ws: string): Promise<string> {
    const { top, rel } = this.where(), t = this.tree(ws)
    if (!existsSync(join(t, '.git'))) {
      // a folder left without its worktree is the console's own, under its base
      rmSync(t, { recursive: true, force: true })
      mkdirSync(this.base, { recursive: true })
      await this.git(top, 'worktree', 'prune')
      await this.git(top, 'worktree', 'add', '-q', '-B', `agent/${ws}`, t, 'HEAD')
    }
    const d = join(t, rel), nm = join(d, 'node_modules'), liveNm = join(this.live, 'node_modules')
    let has = false
    try { lstatSync(nm); has = true } catch { /* none yet */ }
    if (!has && existsSync(liveNm)) symlinkSync(liveNm, nm, 'junction')
    return d
  }

  /** a worktree with nothing uncommitted fast-forwards to the live HEAD; false = it holds work, or cannot */
  async sync(ws: string): Promise<boolean> {
    const d = this.has(ws)
    if (!d) return false
    if ((await this.git(d, 'status', '--porcelain', '--', '.')).trim()) return false
    const head = (await this.git(this.live, 'rev-parse', 'HEAD')).trim()
    return (await this.exec('git', ['merge', '-q', '--ff-only', head], { cwd: d })).code === 0
  }

  /** what the agent changed in its worktree and did not apply yet; none while it has no worktree */
  async pending(ws: string): Promise<string[]> {
    const d = this.has(ws)
    return d ? (await this.changes(d, ws)).all : []
  }

  /** what is not applied is dropped from the worktree: tracked files back to HEAD, new ones deleted; the files it dropped */
  async discard(ws: string): Promise<string[]> {
    const d = this.has(ws)
    if (!d) return []
    const c = await this.changes(d, ws)
    if (c.tracked.length) await this.git(d, 'checkout', '-q', 'HEAD', '--', ...c.tracked.map(lit))
    for (const f of c.fresh) { rmSync(join(d, f), { force: true }); prune(d, f) }
    return c.all
  }

  /** the one-time move: what an earlier console's agent left uncommitted in the live folder under ws's areas goes to
      ws's worktree, byte for byte, and the live files go back to HEAD; only into a worktree with nothing of its own */
  async adopt(ws: string): Promise<Adopted> {
    const left = await this.changes(this.live, ws)
    if (!left.all.length) return { moved: [] }
    for (const f of left.all) {
      try { if (!lstatSync(join(this.live, f)).isFile()) return { skipped: `${f} is not a plain file; the live leftovers stay` } } catch { /* deleted */ }
    }
    const d = await this.dir(ws)
    if ((await this.pending(ws)).length) return { skipped: `the worktree of ${ws} holds changes not applied; the live leftovers stay` }
    if (!await this.sync(ws) && (await this.git(d, 'rev-parse', 'HEAD')).trim() !== (await this.git(this.live, 'rev-parse', 'HEAD')).trim())
      return { skipped: `the worktree of ${ws} is not at the live HEAD; the live leftovers stay` }
    for (const f of left.all) {
      const from = join(this.live, f), to = join(d, f)
      if (existsSync(from)) { mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to) } else rmSync(to, { force: true })
    }
    if (left.tracked.length) await this.git(this.live, 'checkout', '-q', 'HEAD', '--', ...left.tracked.map(lit))
    for (const f of left.fresh) { rmSync(join(this.live, f), { force: true }); prune(this.live, f) }
    return { moved: left.all }
  }
}

/** the empty folders a deleted file leaves, up to its area */
function prune(root: string, f: string) {
  let d = dirname(join(root, f))
  const stop = resolve(root, f.split('/').slice(0, f.startsWith('workspaces/') ? 2 : 1).join(sep))
  while (d.length > stop.length && d.startsWith(stop)) {
    try { if (readdirSync(d).length) return; rmdirSync(d) } catch { return }
    d = dirname(d)
  }
}
