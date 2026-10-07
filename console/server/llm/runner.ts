import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as T from '../../src/model/transitions.ts'
import { thread } from '../../src/model/thread.ts'
import { INTENTS } from '../../src/model/types.ts'
import type { Cmd, Job, RunIntent, RunRec, Ws } from '../../src/model/types.ts'
import { HttpError } from '../events.ts'
import type { Bus } from '../events.ts'
import type { Jobs } from '../jobs/jobs.ts'
import type { Notes } from '../knowledge/notes.ts'
import type { Store } from '../store/port.ts'
import type { PromptImage, RunContext } from './context.ts'
import { buildPrompt, contextText, redoText, replyPrompt, RESUME_ASK_PROMPT, RESUME_PROMPT } from './prompt.ts'
import type { PromptIn } from './prompt.ts'
import type { KnowledgeIn, Sdk } from './sdk.ts'
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
/** the most of an ask reply's answer a record keeps */
const ANSWER_MAX = 4000
/** started: the record says running; until then cancel and interruptAll leave settling to run() */
type Live = { ac: AbortController; why: 'cancelled' | 'interrupted' | null; reason?: string; drafted: boolean; started: boolean; blocked?: string }

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
  private context: (j: Job) => Promise<RunContext>; private me?: string; private bridge?: boolean; private workDir?: WorkDir
  private screenshot?: (o: Shot & { out: string; fileRoot?: string }) => Promise<unknown>
  private jobTools?: JobTools
  private notes?: Notes
  private autoResume: boolean
  /** reply = the reply's text has not reached its session yet */
  private queue: { id: string; resume?: string; reply?: boolean }[] = []
  private live = new Map<string, Live>()
  private feeds = new Map<string, string[]>()
  private settled: ((r: RunRec) => void)[] = []

  /** context = reads the job's context items and their pictures for a run's prompt and its context tool; me = what prompts call the user (unset or empty: "the user");
      bridge false = the workspace has no gateway, so prompts do not point at the bridge tools;
      workDir = each job's own dir, in place of cwd */
  constructor(o: {
    store: Store; jobs: Jobs; bus: Bus; sdk: Sdk; cwd: string; max?: number; gate: () => boolean; artifactsDir: string; ctx: () => T.Ctx
    context?: (j: Job) => Promise<RunContext>; me?: string; bridge?: boolean; workDir?: WorkDir
    /** takes a png of a page into out; none = runs get no screenshot tool */
    screenshot?: (o: Shot & { out: string; fileRoot?: string }) => Promise<unknown>
    /** runs may create jobs in this workspace and start its jobs; none = no job tools */
    jobTools?: JobTools
    /** the workspace's knowledge notes; none = no knowledge tools */
    notes?: Notes
    /** an interrupted run resumes by itself once, at resumeDue() after the comeback */
    autoResume?: boolean
  }) {
    this.store = o.store; this.jobs = o.jobs; this.bus = o.bus; this.sdk = o.sdk; this.cwd = o.cwd
    this.max = o.max ?? 3; this.gate = o.gate; this.artifactsDir = o.artifactsDir; this.ctx = o.ctx; this.context = o.context ?? (async () => ({ ctx: [], images: [] })); this.me = o.me; this.bridge = o.bridge; this.workDir = o.workDir; this.screenshot = o.screenshot; this.jobTools = o.jobTools; this.notes = o.notes
    this.autoResume = !!o.autoResume
  }

  /** draft ready, answered, failed or interrupted: the moments worth a push */
  onSettled(f: (r: RunRec) => void) { this.settled.push(f) }
  feed(id: string) { return [...(this.feeds.get(id) || [])] }
  all() { return this.store.runs() }
  async get(id: string) { return (await this.store.runs()).find((r) => r.id === id) || null }

  private async save(r: RunRec, notify = true) {
    await this.store.putRun(r)
    this.bus.emit({ kind: 'run', run: { ...r } })
    if (notify && (r.state === 'draft' || r.state === 'answered' || r.state === 'failed' || r.state === 'interrupted')) for (const f of this.settled) { try { f({ ...r }) } catch { /* a notifier never breaks a run */ } }
  }

  /** as = whose word it is (an accept reply's); false when it was not saved */
  private async jobCmd(r: RunRec, c: Cmd, as?: 'page' | 'session') {
    try { await this.jobs.cmd(r.job, c, undefined, 'runner', as); return true } catch (e) { console.error(`run ${r.id}: ${c.op} on ${r.job} failed`, (e as Error).message); return false }
  }

  private async hasRun(job: string, step: string): Promise<Job> {
    const j = await this.jobs.get(job)
    if (!j) throw new HttpError(404, 'not_found', `no job ${job}`)
    if (!j.flow[step]) throw new HttpError(400, 'bad_step', `${job} has no step ${step}`)
    if (j.flow[step].run) throw new HttpError(409, 'run_exists', 'this step already has an LLM run')
    return j
  }

  /** auto = the console asks by itself, and the journal says so; via = who asked when not the user */
  async ask(job: string, step: string, q: string, o: { auto?: boolean; via?: 'session' } = {}): Promise<RunRec> {
    if (!this.gate()) throw new HttpError(503, 'bridge_unavailable', 'the bridge is unavailable; no run was started')
    if (!q || !q.trim()) throw new HttpError(400, 'bad_args', 'the instruction is empty')
    await this.hasRun(job, step)
    const r: RunRec = { id: `r-${randomBytes(6).toString('hex')}`, job, step, q: q.trim(), state: 'queued', at: new Date().toISOString(), ...(o.via ? { via: o.via } : {}) }
    await this.jobs.cmd(job, { op: 'runStart', step, q: r.q, id: r.id, ...(o.auto ? { auto: true } : {}) }, undefined, 'runner', o.via)
    await this.save(r)
    this.queue.push({ id: r.id })
    this.pump()
    return r
  }

  /** the step's thread: its newest run, and the newest session in it, which a reply continues */
  private async chain(job: string, step: string) {
    const t = thread(await this.store.runs(), job, step)
    return { head: t.at(-1), session: t.findLast((r) => r.session)?.session }
  }

  /** a reply to the step's draft in its own session; via = who replied when not the user */
  async reply(job: string, step: string, t: string, intent: RunIntent, o: { via?: 'session' } = {}): Promise<RunRec> {
    if (!this.gate()) throw new HttpError(503, 'bridge_unavailable', 'the bridge is unavailable; the reply was not sent')
    if (!t || !t.trim()) throw new HttpError(400, 'bad_args', 'the reply is empty')
    if (!INTENTS.includes(intent)) throw new HttpError(400, 'bad_args', `intent is one of ${INTENTS.join(', ')}`)
    const j = await this.jobs.get(job)
    if (!j) throw new HttpError(404, 'not_found', `no job ${job}`)
    const f = j.flow[step]
    if (!f) throw new HttpError(400, 'bad_step', `${job} has no step ${step}`)
    if (T.isClosed(j)) throw new HttpError(409, 'bad_state', `${job} is closed`)
    if (f.run) throw new HttpError(409, 'busy', 'this step already has an LLM run')
    if (!f.dr) throw new HttpError(409, 'no_draft', 'this step has no draft to reply to')
    const c = await this.chain(job, step)
    if (!c.head || !c.session) throw new HttpError(409, 'no_session', 'this draft has no LLM session to continue; ask again instead')
    // a run that has submitted its draft can still be winding its session down
    if (this.live.has(c.head.id)) throw new HttpError(409, 'busy', 'the LLM is still finishing its last turn; send it again in a moment')
    const r: RunRec = { id: `r-${randomBytes(6).toString('hex')}`, job, step, q: t.trim(), state: 'queued', at: new Date().toISOString(), parent: c.head.id, intent, ...(o.via ? { via: o.via } : {}) }
    await this.jobs.cmd(job, { op: 'runReply', step, q: r.q, id: r.id, intent }, undefined, 'runner', o.via)
    await this.save(r)
    this.queue.push({ id: r.id, resume: c.session, reply: true })
    this.pump()
    return r
  }

  /** after a rejectDraft with a reason: the step again in a fresh session, told the draft and why. Never throws:
      the draft is rejected either way, and redo says why no run started */
  async redoRejected(prev: Job, c: Cmd, via?: 'session'): Promise<{ run?: RunRec; redo?: string }> {
    if (c.op !== 'rejectDraft' || !c.why?.trim()) return {}
    const dr = prev.flow[c.step]?.dr, s = T.stepOf(this.ctx(), prev, c.step)
    if (!dr || !s) return {}
    try { return { run: await this.ask(prev.id, c.step, redoText(T.askText(s), dr.t, c.why), { via }) } } catch (e) { return { redo: (e as Error).message } }
  }

  /** the run once it has ended, or as it is after ms */
  async settle(id: string, ms: number): Promise<RunRec> {
    const t0 = Date.now()
    for (;;) {
      const r = await this.get(id)
      if (!r) throw new HttpError(404, 'not_found', `no run ${id}`)
      const left = ms - (Date.now() - t0)
      if (r.ended || left <= 0) return r
      await new Promise((res) => setTimeout(res, Math.min(250, left)))
    }
  }

  async resume(id: string): Promise<RunRec> {
    const r = await this.get(id)
    if (!r) throw new HttpError(404, 'not_found', `no run ${id}`)
    if (r.state !== 'interrupted' && r.state !== 'failed') throw new HttpError(409, 'bad_state', `a ${r.state} run cannot be resumed`)
    if (!r.session && !r.parent) throw new HttpError(409, 'no_session', 'this run never started a session; ask again instead')
    return this.requeue(r, false)
  }

  /** the same record queued again: its session continues, or without one it starts afresh on the same instruction;
      a reply that never reached its session goes again in the session it replies to */
  private async requeue(r: RunRec, auto: boolean): Promise<RunRec> {
    if (!this.gate()) throw new HttpError(503, 'bridge_unavailable', 'the bridge is unavailable; the run was not resumed')
    await this.hasRun(r.job, r.step)
    const fresh = !!r.parent && !r.session, resume = fresh ? (await this.chain(r.job, r.step)).session : r.session
    if (r.parent && !resume) throw new HttpError(409, 'no_session', 'the draft this replies to has no session any more')
    const as = auto ? 'console' : r.via
    await this.jobs.cmd(r.job, r.parent
      ? { op: 'runReply', step: r.step, q: r.q, id: r.id, intent: r.intent ?? 'revise', ...(fresh ? {} : { resumed: true }) }
      : { op: 'runStart', step: r.step, q: r.q, id: r.id, ...(r.session ? { resumed: true } : {}), ...(auto ? { auto: true } : {}) }, undefined, 'runner', as)
    const next: RunRec = { ...r, state: 'queued', reason: undefined, ended: undefined }
    await this.save(next)
    this.queue.push({ id: r.id, ...(resume ? { resume } : {}), ...(fresh ? { reply: true } : {}) })
    this.pump()
    return next
  }

  /** after a comeback each due run goes again, once; one whose step moved on, or got a newer run, is only used up */
  async resumeDue() {
    if (!this.autoResume || !this.gate()) return
    const all = await this.store.runs()
    for (const r of all) {
      if (r.state !== 'interrupted' || r.ar !== 'due') continue
      try {
        const used: RunRec = { ...r, ar: 'used' }
        await this.save(used, false)
        const j = await this.jobs.get(r.job), f = j?.flow[r.step]
        // a reply goes on over its draft; an ask only on a step still without one
        const idle = r.parent ? !!f?.dr && !f.run : !!f && f.s === 'cur' && !f.run && !f.dr
        if (!j || T.isClosed(j) || !f || !idle) continue
        if (all.some((x) => x.job === r.job && x.step === r.step && x.at > r.at)) continue
        await this.requeue(used, true)
      } catch (e) { console.error(`run ${r.id} did not resume by itself:`, (e as Error).message) }
    }
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

  /** A went away: stop every session and the queue; they resume by hand, or with autoResume once by
      themselves. The sessions are aborted first, whatever the store does; a write that fails is left for recover() */
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
    // a run that already resumed by itself once waits for the user
    const due = state === 'interrupted' && this.autoResume && r.ar !== 'used'
    const next: RunRec = { ...r, state, reason, ended: new Date().toISOString(), ...(due ? { ar: 'due' as const } : {}) }
    await this.jobCmd(r, { op: 'runEnd', step: r.step, why: state, detail: state === 'cancelled' ? undefined : reason, ...(due ? { due: true } : {}) })
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
      void this.run(x.id, x.resume, l, !!x.reply).catch((e) => console.error(`run ${x.id} did not settle:`, (e as Error).message))
        // a resume can start the same id again before this one settles; that slot is not ours to free
        .finally(() => { if (this.live.get(x.id) === l) { this.live.delete(x.id); this.feeds.delete(x.id) } this.pump() })
    }
  }

  private line(id: string, t: string, tool?: string) {
    const f = this.feeds.get(id)
    if (!f) return
    f.push(tool ? `→ ${tool} ${t}` : t)
    if (f.length > FEED_MAX) f.splice(0, f.length - FEED_MAX)
    this.bus.emit({ kind: 'feed', run: id, t, tool })
  }

  /** reply = the session gets the reply's text; else a resumed session is told to go on */
  private async run(id: string, resume: string | undefined, l: Live, reply = false) {
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
    const shot = this.screenshot, jt = this.jobTools, kn = this.notes
    const wd = this.workDir ? { workDir: cwd, branch: this.workDir.branch?.(job) } : {}
    /** the prompt's input for the job as it is now, and the pictures its context names */
    const input = async (j: Job): Promise<{ o: PromptIn; images: PromptImage[] }> => {
      const c = await this.context(j)
      return { o: { ctx: c.ctx, images: c.images.length, pbNotes: kn ? await kn.forPlaybook(j.pb) : [], me: this.me, bridge: this.bridge, knowledge: !!kn, ...wd }, images: c.images }
    }
    let made = 0
    const tools = {
      submitDraft: async (t: string) => {
        if (l.drafted) throw new Error('a draft was already submitted for this run')
        await this.jobs.cmd(rec.job, { op: 'runDraft', step: rec.step, t }, undefined, 'runner')
        l.drafted = true
        r = { ...r!, state: 'draft' }
        // an accept turn accepts at once, before anyone can act on the draft; it pushes only if that fails
        const accepted = rec.intent === 'accept' && await this.jobCmd(rec, { op: 'acceptDraft', step: rec.step, said: true }, rec.via ?? 'page')
        await this.save(r, !accepted)
      },
      addArtifact: (n: string, content: string) => keep(safeName(n), (f) => writeFile(f, content, 'utf8')),
      addArtifactFile: async (p: string, n?: string) => {
        const real = await within(p), s = await stat(real)
        if (!s.isFile()) throw new Error(`${p} is not a file`)
        if (s.size > FILE_MAX) throw new Error(`${p} is over 20 MB`)
        await keep(safeName(n || basename(real)), (f) => copyFile(real, f))
      },
      journal: async (o: string, c: string, n: string) => { await this.jobs.cmd(rec.job, { op: 'journal', o, c, n, a: 'LLM' }, undefined, 'runner') },
      context: async () => {
        const j = (await this.jobs.get(rec.job)) ?? job, x = await input(j)
        return { text: contextText(this.ctx(), j, rec.step, rec.q, x.o), images: x.images }
      },
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
      ...(kn ? {
        knowledgeSearch: (q: string, tags?: string[]) => kn.search(q, tags),
        knowledgeRead: (nid: string) => kn.read(nid),
        knowledgePropose: async (p: KnowledgeIn) => (await kn.propose({ ...p, by: `run ${rec.job}/${rec.step}` })).id,
      } : {}),
      ...(rec.parent ? {
        openBlocker: async (say: string) => {
          if (l.blocked != null) throw new Error('the blocker builder was already opened')
          if (l.drafted) throw new Error('a draft was already submitted; the blocker builder cannot open')
          await this.jobs.cmd(rec.job, { op: 'runBlocker', step: rec.step, say }, undefined, 'runner')
          l.blocked = say
        },
      } : {}),
    }
    let error: string | undefined, said = ''
    try {
      // a resumed session already has its context
      const first = resume ? null : await input(job)
      const prompt = first ? buildPrompt(this.ctx(), job, rec.step, rec.q, first.o)
        : reply ? replyPrompt(rec.q, rec.intent ?? 'revise', this.me, true)
        : rec.intent === 'ask' ? RESUME_ASK_PROMPT : RESUME_PROMPT
      for await (const e of this.sdk.start({ prompt, ...(first?.images.length ? { images: first.images } : {}), resume, cwd, tools, abort: l.ac })) {
        if (l.why) break
        if (e.k === 'session') { if (r!.session !== e.id) { r = { ...r!, session: e.id }; await this.save(r) } }
        else if (e.k === 'text') { this.line(id, e.t); said = e.t }
        else if (e.k === 'tool') this.line(id, e.input, e.name)
        else if (e.k === 'result') { if (!e.ok) error = e.error || 'the session failed'; else if (e.t) said = e.t }
      }
    } catch (e) {
      if (!l.why) error = (e as Error).message || String(e)
    }
    if (l.why) return // cancel / interruptAll already settled the record
    const now = () => new Date().toISOString()
    if (l.blocked != null) {
      await this.save({ ...r!, state: 'answered', a: `Opened the blocker builder: ${l.blocked}`.slice(0, ANSWER_MAX), ended: now() })
      return
    }
    if (l.drafted) {
      await this.save({ ...r!, state: 'draft', ended: now() }, false)
      return
    }
    // a reply that only asks back (which step? whom?) answers; the draft stays
    if ((rec.intent === 'ask' || rec.parent) && !error) {
      const a = said.trim().slice(0, ANSWER_MAX)
      if (a) {
        await this.jobCmd(rec, { op: 'runAnswer', step: rec.step, a })
        await this.save({ ...r!, state: 'answered', a, ended: now() })
        return
      }
      error = 'the session ended without an answer'
    }
    await this.end(r!, 'failed', error || 'the session ended without a draft')
  }
}
