import * as T from '../../src/model/transitions.ts'
import { PP_OPS } from '../../src/model/types.ts'
import type { Cmd, Job } from '../../src/model/types.ts'
import { HttpError } from '../events.ts'
import type { Jobs } from '../jobs/jobs.ts'
import type { Push } from '../spaces.ts'

/* An agent's changes reach a job only as a proposal through here: tried on a copy, kept under the store's cap,
   set by the console and pushed once. The person accepts or rejects it on the page. */

export const PP_MAX = 250_000
const PP_CMDS = 30
const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + '…' : t)

export class Proposer {
  private o: { jobs: Pick<Jobs, 'get' | 'all' | 'cmd'>; ctx: () => T.Ctx; push: Push }
  private busy = new Set<string>()

  constructor(o: { jobs: Pick<Jobs, 'get' | 'all' | 'cmd'>; ctx: () => T.Ctx; push: Push }) { this.o = o }

  /** while a ppSet of this job is being written: the generic needs-you push stays quiet */
  handling(id: string) { return this.busy.has(id) }

  /** dry run, size guard, then ppSet by the console and the push; '' = set, else why not */
  async propose(id: string, say: string, cmds: Cmd[], by: string): Promise<string> {
    const j = await this.o.jobs.get(id)
    if (!j) return `Not proposed: there is no job ${id} in this workspace.`
    if (T.isClosed(j)) return `Not proposed: ${id} is ${j.st}; a closed job takes no proposal.`
    const s = String(say ?? '').trim()
    if (!s) return 'Not proposed: say what the proposal does.'
    if (!Array.isArray(cmds) || !cmds.length || cmds.length > PP_CMDS) return `Not proposed: a proposal holds 1–${PP_CMDS} commands.`
    const bad = cmds.findIndex((c) => !(PP_OPS as readonly string[]).includes(c?.op))
    if (bad >= 0) return `Not proposed: ${bad + 1}. ${cmds[bad]?.op ?? 'a command without op'} cannot be proposed.`
    let after: Job
    try {
      // a link checks its blocker and walks the links for a cycle, as the accept will
      const others = cmds.some((c) => c.op === 'waitAdd') ? new Map((await this.o.jobs.all()).map((o) => [o.id, o])) : null
      after = T.runAll({ ...this.o.ctx(), ...(others ? { jobOf: (i: string) => others.get(i) } : {}) }, j, cmds).job
    } catch (e) {
      if (e instanceof T.CmdError) return `Not proposed: ${e.message}`
      throw e
    }
    if (JSON.stringify(after).length > PP_MAX) return 'Not proposed: the job would grow past 250 KB; propose fewer or shorter changes.'
    this.busy.add(id)
    try { await this.o.jobs.cmd(id, { op: 'ppSet', say: s, cmds, by }, undefined, 'console') } catch (e) {
      if (e instanceof HttpError && e.status < 500) return `Not proposed: ${e.message}`
      throw e
    } finally { this.busy.delete(id) }
    await this.o.push(`${id}: proposal`, clip(s, 200), `/?job=${id}`).catch((e) => console.error(`pushing the proposal for ${id}:`, (e as Error).message))
    return ''
  }
}
