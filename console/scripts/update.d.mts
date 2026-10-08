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
}
/** <home>/update-failed.json, null when the last update did not fail */
export function failedUpdate(home: string): FailedUpdate | null
/** drops the failed update's worktree, branch and record; false when there is none */
export function giveUp(o: { home: string; run?: Runner }): boolean
export function update(o: {
  home: string
  folder: string
  core?: string
  pull?: boolean
  run?: Runner
  check?: (dir: string) => Checked
  sync?: (o: { core: string; to: string; rev: string }) => void
  build?: (dir: string) => { ok: boolean; output?: string }
  restart?: (home: string) => boolean
  log?: (line: string) => void
}): Promise<{ status: 'current' | 'updated' | 'reintegrate' | 'refused' | 'failed'; code: number; sha?: string; branch?: string }>
