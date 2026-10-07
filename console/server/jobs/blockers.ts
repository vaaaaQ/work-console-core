import { openOf } from '../../src/model/blockers.ts'
import * as T from '../../src/model/transitions.ts'
import type { Job } from '../../src/model/types.ts'
import type { Jobs } from './jobs.ts'

/* A step that waits for a job goes on when that job closes. The close only wakes this; each blockerClosed is
   decided from the blocker as stored now, so a repeat, or a close missed while the console was off, ends the same.
   One per workspace; the work runs one change at a time. */

type Push = (title: string, body: string, url: string) => Promise<void>
const url = (id: string) => `/?job=${encodeURIComponent(id)}`
const first = (t: string) => t.split('\n').map((s) => s.trim()).find(Boolean) ?? ''

/** a closed job's outcome: the out of its last step that has one, else its close note, else empty */
export function outcomeOf(x: T.Ctx, b: Job): string {
  const outs = T.steps(x, b.pb).map((s) => b.flow[s.id]?.out).filter((o): o is string => !!o)
  if (outs.length) return outs.at(-1)!
  const e = b.jr.find((e) => e.o === 'Closed the job as done.' || e.o === 'Cancelled the job.')
  return e && e.c !== 'no note.' ? e.c : ''
}

export class Blockers {
  private jobs: Jobs; private ctx: () => T.Ctx; private push: Push
  private chain: Promise<void> = Promise.resolve(); private busy = new Set<string>(); private off: () => void

  constructor(o: { jobs: Jobs; ctx: () => T.Ctx; push: Push }) {
    this.jobs = o.jobs; this.ctx = o.ctx; this.push = o.push
    this.off = o.jobs.onCmd(({ cmd, job }) => {
      if (cmd.op === 'close') void this.run(() => this.sweep({ blocker: job.id }))
      else if (cmd.op === 'reopen') void this.run(async () => { await this.reopened(job); await this.sweep({ waiter: job.id }) })
    })
  }

  stop() { this.off() }
  /** a job this is waking: its generic needs-you push would say the same thing again */
  handling(id: string) { return this.busy.has(id) }
  /** every open link of every open job against its blocker as stored now */
  reconcile() { return this.run(() => this.sweep({})) }

  private run(f: () => Promise<void>) {
    const p = this.chain.then(f).catch((e) => console.error('blockers:', (e as Error).message))
    this.chain = p
    return p
  }

  /** decides the open links of live steps of open jobs: all, those of one waiter, or those to one blocker */
  private async sweep(o: { blocker?: string; waiter?: string }) {
    const all = await this.jobs.all(), byId = new Map(all.map((j) => [j.id, j])), x = this.ctx()
    for (const w of all) {
      if (T.isClosed(w) || (o.waiter && w.id !== o.waiter)) continue
      for (const [step, f] of Object.entries(w.flow)) {
        if (!T.isLive(f)) continue
        for (const l of openOf(f)) {
          if (o.blocker && l.j !== o.blocker) continue
          const b = byId.get(l.j)
          if (b && !T.isClosed(b)) continue
          await this.wake(w, step, l.j, b ? (b.st as 'done' | 'cancelled') : 'cancelled', b ? outcomeOf(x, b) : 'blocker not found')
        }
      }
    }
  }

  private async wake(w: Job, step: string, bid: string, st: 'done' | 'cancelled', out: string) {
    this.busy.add(w.id)
    try {
      const r = await this.jobs.cmd(w.id, { op: 'blockerClosed', step, j: bid, st, ...(out ? { out } : {}) }, undefined, 'console')
      if (st === 'cancelled') await this.push(`${w.id} ${w.t}: blocker ${bid} cancelled`, first(out) || 'remove it or link another', url(w.id))
      else if (r.job.flow[step]?.s === 'cur') await this.push(`${w.id} goes on`, `${bid} done${first(out) ? `: ${first(out).slice(0, 160)}` : ''}`, url(w.id))
    } catch (e) {
      console.error(`waking ${w.id} for ${bid} failed:`, (e as Error).message)
    } finally { this.busy.delete(w.id) }
  }

  /** a blocker reopened after its waiters went on or turned bad: a journal line on each, nothing else */
  private async reopened(b: Job) {
    for (const w of await this.jobs.all()) {
      if (T.isClosed(w)) continue
      const ls = Object.values(w.flow).flatMap((f) => (f.w || []).filter((l) => l.j === b.id && l.st !== 'open'))
      if (!ls.length) continue
      const c = ls.some((l) => l.st === 'cancelled')
        ? 'this job took its cancelled outcome as a failure; nothing changed here.'
        : 'this job already went on with its outcome; nothing changed here.'
      await this.jobs.cmd(w.id, { op: 'journal', o: `Blocker ${b.id} “${b.t}” was reopened.`, c, n: '-', a: 'console' }, undefined, 'console')
    }
  }
}
