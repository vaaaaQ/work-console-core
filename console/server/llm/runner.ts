import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type * as T from '../../src/model/transitions.ts'
import type { Resolved } from '../../src/model/context.ts'
import type { Job, RunRec, Ws } from '../../src/model/types.ts'
import { HttpError } from '../events.ts'
import type { Bus } from '../events.ts'
import type { Jobs } from '../jobs/jobs.ts'
import type { Store } from '../store/port.ts'
import { buildPrompt, RESUME_PROMPT } from './prompt.ts'
import type { Sdk } from './sdk.ts'
import { checkUrl } from './shot.ts'
import type { Shot } from './shot.ts'
import type { WorkDir } from './worktree.ts'

/* One Claude Code session per ask, at most `max` at a time; the rest wait in order. The run record
   is the durable half (state, session id); the feed lives in memory while the session runs. */

const FEED_MAX = 200
/** the biggest file a run may keep as an artifact */
const FILE_MAX = 20 << 20
/** the most jobs one run may create */
const JOBS_MAX = 5
/** started: the record says running; until then cancel and interruptAll leave settling to run() */
type Live = { ac: AbortController; why: 'cancelled' | 'interrupted' | null; reason?: string; drafted: boolean; started: boolean }

/** an artifact name that stays inside its job folder */
export function safeName(n: string) {
  const s = (String(n).split(/[\\/]/).pop() || '').replace(/[:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').trim().slice(0, 120)
  if (!s) throw new Error('an artifact needs a name')
  return s
}

/** where a run's new jobs go: its workspace, the default playbook and the projects (the first is the default), and the
    prefix of the jobs it may start */
export type JobTools = { ws: Ws; pb: string; prj: string[]; prefix: string }

export class Runner {
  private store: Store; private jobs: Jobs; private bus: Bus; private sdk: Sdk; private cwd: string
  private max: number; private gate: () => boolean; private artifactsDir: string; private ctx: () => T.Ctx
  private context: (j: Job) => Promise<Resolved[]>; private me?: string; private bridge?: boolean; private workDir?: WorkDir
  private screenshot?: (o: Shot & { out: string; fileRoot?: string }) => Promise<unknown>
  private jobTools?: JobTools
  private queue: { id: string; resume?: string }[] = []
  private live = new Map<string, Live>()
  private feeds = new Map<string, string[]>()
  private settled: ((r: RunRec) => void)[] = []

  /** context = reads the job's context items for a new run's prompt; me = what prompts call the user (unset or empty: "the user");
      bridge false = the workspace has no gateway, so prompts do not point at the bridge tools;
      workDir = each job's own dir, in place of cwd */
  constructor(o: {
    store: Store; jobs: Jobs; bus: Bus; sdk: Sdk; cwd: string; max?: number; gate: () => boolean; artifactsDir: string; ctx: () => T.Ctx
    context?: (j: Job) => Promise<Resolved[]>; me?: string; bridge?: boolean; workDir?: WorkDir
    /** takes a png of a page into out; none = runs get no screenshot tool */
    screenshot?: (o: Shot & { out: string; fileRoot?: string }) => Promise<unknown>
    /** runs may create jobs in this workspace and start its jobs; none = no job tools */
    jobTools?: JobTools
  }) {
    this.store = o.store; this.jobs = o.jobs; this.bus = o.bus; this.sdk = o.sdk; this.cwd = o.cwd
    this.max = o.max ?? 3; this.gate = o.gate; this.artifactsDir = o.artifactsDir; this.ctx = o.ctx; this.context = o.context ?? (async () => []); this.me = o.me; this.bridge = o.bridge; this.workDir = o.workDir; this.screenshot = o.screenshot; this.jobTools = o.jobTools
  }

  /** draft ready, failed or interrupted: the moments worth a push */
  onSettled(f: (r: RunRec) => void) { this.settled.push(f) }
  feed(id: string) { return [...(this.feeds.get(id) || [])] }
  all() { return this.store.runs() }
  async get(id: string) { return (await this.store.runs()).find((r) => r.id === id) || null }

  private async save(r: RunRec, notify = true) {
    await this.store.putRun(r)
    this.bus.emit({ kind: 'run', run: { ...r } })
    if (notify && (r.state === 'draft' || r.state === 'failed' || r.state === 'interrupted')) for (const f of this.settled) { try { f({ ...r }) } catch { /* a notifier never breaks a run */ } }
  }

  private async jobCmd(r: RunRec, c: Parameters<Jobs['cmd']>[1]) {
    try { await this.jobs.cmd(r.job, c, undefined, 'runner') } catch (e) { console.error(`run ${r.id}: ${c.op} on ${r.job} failed`, (e as Error).message) }
  }

  private async hasRun(job: string, step: string): Promise<Job> {
    const j = await this.jobs.get(job)
    if (!j) throw new HttpError(404, 'not_found', `no job ${job}`)
    if (!j.flow[step]) throw new HttpError(400, 'bad_step', `${job} has no step ${step}`)
    if (j.flow[step].run) throw new HttpError(409, 'run_exists', 'this step already has an LLM run')
    return j
  }

  async ask(job: string, step: string, q: string): Promise<RunRec> {
    if (!this.gate()) throw new HttpError(503, 'bridge_unavailable', 'the bridge is unavailable; no run was started')
    if (!q || !q.trim()) throw new HttpError(400, 'bad_args', 'the instruction is empty')
    await this.hasRun(job, step)
    const r: RunRec = { id: `r-${randomBytes(6).toString('hex')}`, job, step, q: q.trim(), state: 'queued', at: new Date().toISOString() }
    await this.jobs.cmd(job, { op: 'runStart', step, q: r.q, id: r.id }, undefined, 'runner')
    await this.save(r)
    this.queue.push({ id: r.id })
    this.pump()
    return r
  }

  async resume(id: string): Promise<RunRec> {
    const r = await this.get(id)
    if (!r) throw new HttpError(404, 'not_found', `no run ${id}`)
    if (r.state !== 'interrupted' && r.state !== 'failed') throw new HttpError(409, 'bad_state', `a ${r.state} run cannot be resumed`)
    if (!r.session) throw new HttpError(409, 'no_session', 'this run never started a session; ask again instead')
    if (!this.gate()) throw new HttpError(503, 'bridge_unavailable', 'the bridge is unavailable; the run was not resumed')
    await this.hasRun(r.job, r.step)
    await this.jobs.cmd(r.job, { op: 'runStart', step: r.step, q: r.q, id: r.id, resumed: true }, undefined, 'runner')
    const next: RunRec = { ...r, state: 'queued', reason: undefined, ended: undefined }
    await this.save(next)
    this.queue.push({ id: r.id, resume: r.session })
    this.pump()
    return next
  }

  async cancel(id: string): Promise<RunRec> {
    const r = await this.get(id)
    if (!r) throw new HttpError(404, 'not_found', `no run ${id}`)
    const qi = this.queue.findIndex((x) => x.id === id)
    if (qi >= 0) {
      this.queue.splice(qi, 1)
      return this.end(r, 'cancelled', 'cancelled before it started')
    }
    const l = this.live.get(id)
    if (!l || l.why) throw new HttpError(409, 'bad_state', `a ${r.state} run cannot be cancelled`)
    l.why = 'cancelled'; l.reason = 'cancelled'
    l.ac.abort()
    if (!l.started) return { ...r, state: 'cancelled', reason: 'cancelled' }
    return this.end(r, 'cancelled', 'cancelled')
  }

  /** nothing runs that this process does not hold: after a restart that is every run, after the
      bridge comes back it is the ones interruptAll could not write */
  async recover(reason = 'the console restarted') {
    for (const r of await this.store.runs())
      if ((r.state === 'running' || r.state === 'queued') && !this.live.has(r.id) && !this.queue.some((x) => x.id === r.id)) await this.end(r, 'interrupted', reason)
  }

  /** A went away: stop every session and the queue; they resume only by hand. The sessions are
      aborted first, whatever the store does; a write that fails is left for recover() */
  async interruptAll(reason: string) {
    const q = this.queue.splice(0), started: string[] = []
    for (const [id, l] of this.live) {
      if (l.why) continue
      l.why = 'interrupted'; l.reason = reason; l.ac.abort()
      if (l.started) started.push(id)
    }
    const failed: string[] = []
    for (const id of [...q.map((x) => x.id), ...started]) {
      try {
        const r = await this.get(id)
        if (r && (r.state === 'queued' || r.state === 'running')) await this.end(r, 'interrupted', reason)
      } catch (e) { failed.push(`${id}: ${(e as Error).message}`) }
    }
    if (failed.length) console.error(`${failed.length} run(s) not marked interrupted:`, failed.join('; '))
  }

  private async end(r: RunRec, state: 'cancelled' | 'failed' | 'interrupted', reason: string): Promise<RunRec> {
    const next: RunRec = { ...r, state, reason, ended: new Date().toISOString() }
    await this.jobCmd(r, { op: 'runEnd', step: r.step, why: state, detail: state === 'cancelled' ? undefined : reason })
    await this.save(next)
    return next
  }

  private pump() {
    while (this.live.size < this.max && this.queue.length) {
      const x = this.queue.shift()!
      const l: Live = { ac: new AbortController(), why: null, drafted: false, started: false }
      this.live.set(x.id, l)
      this.feeds.set(x.id, [])
      // a store write can fail while the workplace is away; the run is swept by recover() later
      void this.run(x.id, x.resume, l).catch((e) => console.error(`run ${x.id} did not settle:`, (e as Error).message))
        .finally(() => { this.live.delete(x.id); this.feeds.delete(x.id); this.pump() })
    }
  }

  private line(id: string, t: string, tool?: string) {
    const f = this.feeds.get(id)
    if (!f) return
    f.push(tool ? `→ ${tool} ${t}` : t)
    if (f.length > FEED_MAX) f.splice(0, f.length - FEED_MAX)
    this.bus.emit({ kind: 'feed', run: id, t, tool })
  }

  private async run(id: string, resume: string | undefined, l: Live) {
    let r = await this.get(id)
    if (!r) return
    if (l.why) { await this.end(r, l.why, l.reason || l.why); return }
    r = { ...r, state: 'running' }
    await this.save(r)
    l.started = true
    if (l.why) { await this.end(r, l.why, l.reason || l.why); return }
    const job = await this.jobs.get(r.job)
    if (!job) { await this.end(r, 'failed', 'the job is gone'); return }
    // a resumed session is found by its dir, so it must get the same one
    let cwd = this.cwd
    if (this.workDir) {
      try { cwd = await this.workDir.dir(job) } catch (e) { if (!l.why) await this.end(r, 'failed', `no work dir: ${(e as Error).message}`); return }
      if (l.why) return // cancel / interruptAll settled it while the dir was made
    }
    const rec = r
    /** a file in the job's artifact folder, then the step's link to it */
    const keep = async (name: string, write: (f: string) => Promise<void>) => {
      const dir = join(this.artifactsDir, rec.job)
      await mkdir(dir, { recursive: true })
      await write(join(dir, name))
      await this.jobs.cmd(rec.job, { op: 'artifact', step: rec.step, n: name, link: `/api/artifacts/${encodeURIComponent(rec.job)}/${encodeURIComponent(name)}` }, undefined, 'runner')
    }
    /** a path under the run's own dir, links resolved, so a run cannot publish the console's files */
    const within = async (p: string) => {
      const real = await realpath(resolve(cwd, p)).catch(() => { throw new Error(`no such file: ${p}`) })
      const rel = relative(await realpath(cwd), real)
      if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error(`${p} is outside the work dir`)
      return real
    }
    const shot = this.screenshot, jt = this.jobTools
    let made = 0
    const tools = {
      submitDraft: async (t: string) => {
        if (l.drafted) throw new Error('a draft was already submitted for this run')
        await this.jobs.cmd(rec.job, { op: 'runDraft', step: rec.step, t }, undefined, 'runner')
        l.drafted = true
        r = { ...r!, state: 'draft' }
        await this.save(r)
      },
      addArtifact: (n: string, content: string) => keep(safeName(n), (f) => writeFile(f, content, 'utf8')),
      addArtifactFile: async (p: string, n?: string) => {
        const real = await within(p), s = await stat(real)
        if (!s.isFile()) throw new Error(`${p} is not a file`)
        if (s.size > FILE_MAX) throw new Error(`${p} is over 20 MB`)
        await keep(safeName(n || basename(real)), (f) => copyFile(real, f))
      },
      journal: async (o: string, c: string, n: string) => { await this.jobs.cmd(rec.job, { op: 'journal', o, c, n, a: 'LLM' }, undefined, 'runner') },
      ...(shot ? {
        screenshot: async (o: Shot & { name: string }) => {
          const u = checkUrl(o.url)
          if (u.protocol === 'file:') await within(fileURLToPath(u))
          const name = safeName(o.name).replace(/\.[a-z0-9]{1,5}$/i, '') + '.png'
          await keep(name, (f) => shot({ url: u.href, width: o.width, height: o.height, fullPage: o.fullPage, out: f, fileRoot: cwd }).then(() => {}))
        },
      } : {}),
      ...(jt ? {
        createJob: async (o: { title: string; playbook?: string; key?: string; project?: string; start?: boolean }) => {
          const prj = o.project ?? jt.prj[0] ?? ''
          if (jt.prj.length && !jt.prj.includes(prj)) throw new Error(`unknown project ${prj}; one of ${jt.prj.join(', ')}`)
          if (made >= JOBS_MAX) throw new Error(`this run already created ${JOBS_MAX} jobs`)
          made++
          let id: string
          try { id = (await this.jobs.create({ t: o.title, key: o.key ?? '', pb: o.playbook ?? jt.pb, prj, ws: jt.ws, src: rec.job }, 'run')).id } catch (e) { made--; throw e }
          if (o.start) await this.jobs.cmd(id, { op: 'start' }, undefined, 'run')
          return id
        },
        startJob: async (id: string) => {
          if (!id.startsWith(jt.prefix + '-')) throw new Error(`${id} is not a job of this workspace`)
          await this.jobs.cmd(id, { op: 'start' }, undefined, 'run')
        },
      } : {}),
    }
    let error: string | undefined
    try {
      // a resumed session already has its context
      const prompt = resume ? RESUME_PROMPT : buildPrompt(this.ctx(), job, rec.step, rec.q, await this.context(job), this.me,
        { bridge: this.bridge, ...(this.workDir ? { workDir: cwd, branch: this.workDir.branch?.(job) } : {}) })
      for await (const e of this.sdk.start({ prompt, resume, cwd, tools, abort: l.ac })) {
        if (l.why) break
        if (e.k === 'session') { if (r!.session !== e.id) { r = { ...r!, session: e.id }; await this.save(r) } }
        else if (e.k === 'text') this.line(id, e.t)
        else if (e.k === 'tool') this.line(id, e.input, e.name)
        else if (e.k === 'result' && !e.ok) error = e.error || 'the session failed'
      }
    } catch (e) {
      if (!l.why) error = (e as Error).message || String(e)
    }
    if (l.why) return // cancel / interruptAll already settled the record
    if (l.drafted) { await this.save({ ...r!, state: 'draft', ended: new Date().toISOString() }, false); return }
    await this.end(r!, 'failed', error || 'the session ended without a draft')
  }
}
