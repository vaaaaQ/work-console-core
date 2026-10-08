/* A core update that failed its checks, as the page shows it: what failed, and the run of update.mjs the page asked for. */

export type UpdateKind = 'apply' | 'give-up'
/** the steps a workspace agent can fix: the ones that run workspace code */
export const REINTEGRABLE = ['typecheck', 'tests', 'build']
/** reintegrable = a workspace agent can fix it on its branch (it failed at typecheck, tests or build) */
export interface UpdateView {
  core: string; from: string; branch: string; step: string; output: string; at: string
  reintegrable: boolean
  running: UpdateKind | null
  /** the last run's end: its exit code and the tail of its output */
  last?: { kind: UpdateKind; code: number; output: string; at: string }
}
