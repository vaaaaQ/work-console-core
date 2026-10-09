import type { Checked, Runner } from './lib.mjs'

/** the exit code of an update whose result waits on update/<sha7> for a reintegrate session */
export const EXIT_REINTEGRATE: 3
export interface FailedUpdate {
  /** the core commit the update was going to, and the one the folder is still on */
  core: string; from: string
  /** the folder's repo, the branch and worktree holding the result, the console dir inside it */
  repo: string; branch: string; worktree: string; dir: string
  /** the folder's commit before the update, and the branch's commit the update made */
  pre: string; head: string
  step: string; output: string; at: string
  /** step finish: npm ci or the build failed after the restart, branch, worktree, dir and head are '', and this log has it all */
  log?: string
}
/** <home>/update-failed.json, null when the last update did not fail */
export function failedUpdate(home: string): FailedUpdate | null
/** where update worktrees are made: <home>-updates */
export function updatesDir(home: string): string
/** drops the failed update's worktree, branch and record; false when there is none */
export function giveUp(o: { home: string; run?: Runner }): boolean
/** what update.mjs leaves in <home>/update-finish.json for the supervisor: the merged folder and its commit before */
export interface FinishUpdate { folder: string; repo: string; pre: string; sha: string }
/** npm ci and the build for the update left in finishFile(home); a failure goes back on pre and leaves update-failed.json at step finish */
export function finish(o: { home: string; run?: Runner; log?: (line: string) => void; build?: (dir: string) => { ok: boolean; output?: string } }):
  { status: 'none' | 'updated' | 'failed'; code: number; sha?: string }
export function update(o: {
  home: string
  folder: string
  core?: string
  pull?: boolean
  run?: Runner
  check?: (dir: string) => Checked
  sync?: (o: { core: string; to: string; rev: string }) => void
  build?: (dir: string) => { ok: boolean; output?: string }
  /** null = the caller restarts the console */
  restart?: ((home: string) => boolean | Promise<boolean>) | null
  /** the supervisor of the console at home, as run.json names it */
  running?: (home: string) => { port: number; finish?: boolean } | null
  /** settles once that supervisor finished the update; false when it has not yet */
  settle?: (home: string, port: number) => Promise<boolean>
  /** a console answers at home; with no supervisor that finishes, a lock change is refused while it does */
  up?: (home: string) => Promise<boolean>
  log?: (line: string) => void
}): Promise<{ status: 'current' | 'updated' | 'reintegrate' | 'refused' | 'failed'; code: number; sha?: string; branch?: string }>
