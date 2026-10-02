import * as T from '../../src/model/transitions.ts'
import { PAGE_OPS, SESSION_OPS } from '../../src/model/types.ts'
import type { Cmd, Job } from '../../src/model/types.ts'
import { Bus, HttpError } from '../events.ts'
import { Conflict } from '../store/port.ts'
import type { Store } from '../store/port.ts'

/* Job commands: the one writer of jobs. A page command names the version it saw, so a second tab
   acting on an older copy gets 409 instead of overwriting; the runner's own commands retry on a
   conflict, because they describe something that already happened. A Claude Code session sends the
   page's commands plus returnTo and signs the journal; the console signs what it decides itself. */

export type Who = 'page' | 'runner' | 'session' | 'console'
const ALLOWED: Partial<Record<Who, Set<string>>> = { page: new Set(PAGE_OPS), session: new Set(SESSION_OPS), console: new Set(['noteAdd', 'reopen', 'stepDone', 'artifact', 'journal']) }
const BY: Partial<Record<Who, string>> = { session: 'Claude Code', console: 'console' }

export class Jobs {
  private store: Store; private bus: Bus; private ctx: () => T.Ctx; private gate: () => boolean
  private nyf: ((j: Job) => void)[] = []

  constructor(o: { store: Store; bus: Bus; ctx: () => T.Ctx; gate: () => boolean }) {
    this.store = o.store; this.bus = o.bus; this.ctx = o.ctx; this.gate = o.gate
  }

  /** fires when a job starts needing you (it did not a moment ago) */
  onNeedsYou(f: (j: Job) => void) { this.nyf.push(f) }

  private open() { if (!this.gate()) throw new HttpError(503, 'bridge_unavailable', 'the bridge is unavailable; nothing was changed') }

  private async put(prev: Job | null, next: Job, expectV: number | null) {
    let saved: Job
    try { saved = await this.store.putJob(next, expectV) } catch (e) {
      if (e instanceof Conflict) throw new HttpError(409, 'conflict', 'the job changed elsewhere')
      throw e
    }
    this.bus.emit({ kind: 'job', job: saved })
    const x = this.ctx()
    if (!(prev && T.needsYou(x, prev)) && T.needsYou(x, saved)) this.nyf.forEach((f) => f(saved))
    return saved
  }

  async cmd(id: string, c: Cmd, expectV?: number, who: Who = 'page'): Promise<{ job: Job; prev: Job; nx: string | null }> {
    const ok = ALLOWED[who]
    if (ok) {
      if (!c || !ok.has(c.op)) throw new HttpError(400, 'bad_args', `the ${who} cannot send ${c?.op}`)
      this.open()
    }
    for (let n = 0; ; n++) {
      const cur = await this.store.job(id)
      if (!cur) throw new HttpError(404, 'not_found', `no job ${id}`)
      if (who !== 'runner' && expectV != null && cur.v !== expectV) throw new HttpError(409, 'conflict', 'the job changed elsewhere')
      let r: { job: Job; nx: string | null }
      try { r = T.apply({ ...this.ctx(), by: BY[who] }, cur, c) } catch (e) {
        if (e instanceof T.CmdError) throw new HttpError(400, e.code, e.message)
        throw e
      }
      try {
        const job = await this.put(cur, r.job, cur.v ?? null)
        return { job, prev: cur, nx: r.nx }
      } catch (e) {
        if ((who === 'runner' || who === 'console') && e instanceof HttpError && e.status === 409 && n < 5) continue
        throw e
      }
    }
  }

  async create(o: T.NewJob, who: Who = 'page'): Promise<Job> {
    this.open()
    let j: Job
    try { j = T.freshJob({ ...this.ctx(), by: BY[who] }, await this.store.nextJobId(), o) } catch (e) {
      if (e instanceof T.CmdError) throw new HttpError(400, e.code, e.message)
      throw e
    }
    const saved = await this.put(null, j, null)
    if (o.mail) await this.store.putMark(o.mail, { done: true, job: saved.id })
    return saved
  }

  /** puts back the copy a command replaced, only if nothing changed since that command */
  async undo(id: string, v: number, prev: Job): Promise<Job> {
    this.open()
    if (!prev || prev.id !== id) throw new HttpError(400, 'bad_args', 'prev is not this job')
    const cur = await this.store.job(id)
    if (!cur) throw new HttpError(404, 'not_found', `no job ${id}`)
    if (cur.v !== v) throw new HttpError(409, 'conflict', 'the job changed since; nothing undone')
    // a run the page cannot see from prev must not vanish: the runner owns run state
    const back: Job = { ...structuredClone(prev), flow: structuredClone(prev.flow) }
    for (const [sid, f] of Object.entries(cur.flow)) if (back.flow[sid]) back.flow[sid].run = f.run
    return this.put(cur, back, v)
  }

  all() { return this.store.jobs() }
  get(id: string) { return this.store.job(id) }
}
