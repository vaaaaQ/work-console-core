import * as T from '../../src/model/transitions.ts'
import { PAGE_OPS, SESSION_OPS } from '../../src/model/types.ts'
import type { Cmd, Job } from '../../src/model/types.ts'
import { Bus, HttpError, downError } from '../events.ts'
import type { Via } from '../events.ts'
import { Conflict } from '../store/port.ts'
import type { Store } from '../store/port.ts'

/* Job commands: the one writer of jobs. A page command names the version it saw, so a second tab
   acting on an older copy gets 409 instead of overwriting; the runner's own commands retry on a
   conflict, because they describe something that already happened. A Claude Code session sends the
   page's commands plus returnTo and signs the journal; the console signs what it decides itself. */

export type Who = 'page' | 'runner' | 'session' | 'console' | 'run'
/** a saved command: who sent it, the job before it and the job as saved */
export type CmdEv = { who: Who; cmd: Cmd; prev: Job; job: Job }
/** a command whose transition passed but whose write failed: the job before it and the error */
export type FailEv = { who: Who; cmd: Cmd; id: string; prev: Job; error: Error & { status?: number } }
const ALLOWED: Partial<Record<Who, Set<string>>> = { page: new Set(PAGE_OPS), session: new Set([...SESSION_OPS, 'draftIn']), console: new Set(['noteAdd', 'reopen', 'stepDone', 'artifact', 'journal', 'blockerClosed', 'ppSet', 'replyIn', 'acceptDraft']), run: new Set(['start']) }
const BY: Partial<Record<Who, string>> = { session: 'Claude Code', console: 'console', run: 'LLM' }

export class Jobs {
  private store: Store; private bus: Bus; private ctx: () => T.Ctx; private gate: () => boolean; private via?: Via
  private nyf: ((j: Job) => void)[] = []
  private cmdf: ((e: CmdEv) => void)[] = []
  private failf: ((e: FailEv) => void)[] = []

  /** via = what the gate stands for, named when it is closed */
  constructor(o: { store: Store; bus: Bus; ctx: () => T.Ctx; gate: () => boolean; via?: Via }) {
    this.store = o.store; this.bus = o.bus; this.ctx = o.ctx; this.gate = o.gate; this.via = o.via
  }

  /** fires when a job starts needing you (it did not a moment ago) */
  onNeedsYou(f: (j: Job) => void) { this.nyf.push(f) }
  /** fires once per saved command; returns the unsubscribe */
  onCmd(f: (e: CmdEv) => void) {
    this.cmdf.push(f)
    return () => { this.cmdf = this.cmdf.filter((g) => g !== f) }
  }
  /** fires when a command passed its transition but its write failed (409 retries exhausted, 413, the store down);
      returns the unsubscribe */
  onFail(f: (e: FailEv) => void) {
    this.failf.push(f)
    return () => { this.failf = this.failf.filter((g) => g !== f) }
  }

  private open() { if (!this.gate()) throw downError(this.via, 'nothing was changed') }

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

  /** as = whose word it is when the runner acts for someone (an accept reply): it signs the journal;
      name = the signer in place of as's, e.g. the MCP client a session runs in */
  async cmd(id: string, c: Cmd, expectV?: number, who: Who = 'page', as?: Who, name?: string): Promise<{ job: Job; prev: Job; nx: string | null }> {
    const ok = ALLOWED[who]
    if (ok) {
      if (!c || !ok.has(c.op)) throw new HttpError(400, 'bad_args', `the ${who} cannot send ${c?.op}`)
      this.open()
    }
    for (let n = 0; ; n++) {
      const cur = await this.store.job(id)
      if (!cur) throw new HttpError(404, 'not_found', `no job ${id}`)
      if (who !== 'runner' && expectV != null && cur.v !== expectV) throw new HttpError(409, 'conflict', 'the job changed elsewhere')
      if (who === 'console' && c.op === 'acceptDraft' && T.stepOf(this.ctx(), cur, c.step)?.start !== 'auto')
        throw new HttpError(400, 'bad_state', `the console accepts a draft only on a step that starts auto`)
      // a link checks its blocker and walks the links for a cycle, so it reads the other jobs as they are now
      const links = c.op === 'ppSet' ? c.cmds : c.op === 'ppAccept' ? cur.pp?.cmds ?? [] : [c]
      const others = links.some((l) => l?.op === 'waitAdd') ? new Map((await this.store.jobs()).map((j) => [j.id, j])) : null
      let r: { job: Job; nx: string | null; same?: true }
      try { r = T.apply({ ...this.ctx(), by: name || BY[as ?? who], ...(others ? { jobOf: (i: string) => others.get(i) } : {}) }, cur, c) } catch (e) {
        if (e instanceof T.CmdError) throw new HttpError(400, e.code, e.message)
        throw e
      }
      if (r.same) return { job: cur, prev: cur, nx: null }
      try {
        const job = await this.put(cur, r.job, cur.v ?? null)
        for (const f of this.cmdf) { try { f({ who, cmd: c, prev: cur, job }) } catch (e) { console.error(`a listener of ${c.op} on ${id} failed:`, (e as Error).message) } }
        // an accepted proposal's links are mirrored as a link sent alone is
        for (const l of c.op !== 'ppAccept' ? [c] : job.pp ? [] : links)
          if (l.op === 'waitAdd' || l.op === 'waitDel') await this.mirror(l, job)
        return { job, prev: cur, nx: r.nx }
      } catch (e) {
        if ((who === 'runner' || who === 'console') && e instanceof HttpError && e.status === 409 && n < 5) continue
        for (const f of this.failf) { try { f({ who, cmd: c, id, prev: cur, error: e as FailEv['error'] }) } catch (g) { console.error(`a listener of a failed ${c.op} on ${id} failed:`, (g as Error).message) } }
        throw e
      }
    }
  }

  /** the blocker's journal says which step waits for it; best-effort, the link stands either way */
  private async mirror(c: Extract<Cmd, { op: 'waitAdd' | 'waitDel' }>, w: Job) {
    const s = T.stepOf(this.ctx(), w, c.step)?.t ?? c.step, add = c.op === 'waitAdd'
    const o = add ? `Holds ${w.id} “${w.t}”: step “${s}” waits for this job.` : `No longer holds ${w.id} “${w.t}” (step “${s}”).`
    try { await this.cmd(c.j, { op: 'journal', o, c: add ? 'that step goes on when this job closes.' : 'nothing there waits for this job now.', n: '-', a: 'console' }, undefined, 'console') }
    catch (e) { console.error(`journaling ${c.op} on ${c.j} failed:`, (e as Error).message) }
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
    // the page sends prev back, so it must not move the job into another workspace
    const back: Job = { ...structuredClone(prev), flow: structuredClone(prev.flow), ws: cur.ws }
    for (const [sid, f] of Object.entries(cur.flow)) if (back.flow[sid]) back.flow[sid].run = f.run
    return this.put(cur, back, v)
  }

  all() { return this.store.jobs() }
  get(id: string) { return this.store.job(id) }
}
