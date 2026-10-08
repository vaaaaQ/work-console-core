import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { FailedUpdate } from '../../scripts/update.mjs'
import type { AgentCommit, AgentRec, AgentReintegrate, AgentWho, Grants } from '../../src/model/agent.ts'
import { REINTEGRABLE } from '../../src/model/update.ts'
import type { UpdateKind } from '../../src/model/update.ts'
import { HttpError } from '../events.ts'
import type { Bus } from '../events.ts'
import { CONSOLE } from '../config.ts'
import { EMPTY_GRANTS, grantsDiff, grantsOf } from '../grants.ts'
import { PROVIDERS, isProvider, pickOf } from '../llm/providers.ts'
import type { SdkPick } from '../llm/providers.ts'
import type { Sdk } from '../llm/sdk.ts'
import { agentLimits } from './limits.ts'
import type { Ops } from './ops.ts'
import { agentSystem, reintegrateAgain, reintegratePrompt, reintegrateSystem } from './prompt.ts'
import type { AgentRecords } from './records.ts'
import { agentTools, reintegrateTools } from './tools.ts'

/* One managed workspace's agent: one conversation at a time and one turn at a time. A turn holds the console's
   restart until it ends; what the person decides or undoes meanwhile reaches the agent with its next prompt.
   A reintegration is a conversation rooted at a failed core update's worktree; update.mjs runs once its turn ends. */

export type SessionOps = Pick<Ops, 'check' | 'apply' | 'undo' | 'createWorkspace' | 'acceptGrants'>
/** how a run of update.mjs ended: updated = the folder is on the new core; failed = the record it left */
export interface UpdateEnd { code: number; output: string; updated: boolean; failed: FailedUpdate | null }
/** the console's failed core update, for reintegrate conversations */
export interface Reintegration {
  failed(): FailedUpdate | null
  /** the core's changes as they land in the folder */
  diff(f: FailedUpdate): Promise<string>
  /** ops rooted at the update's worktree, with no restart */
  opsAt(dir: string): Pick<Ops, 'check' | 'apply'>
  /** update.mjs runs now */
  updating(): boolean
  /** runs update.mjs once no turn runs; report hears its end before the console restarts */
  run(kind: UpdateKind, report: (r: UpdateEnd) => Promise<void>): Promise<UpdateEnd>
}
export interface SessionOpts {
  ws: string; title: string; records: AgentRecords; sdk: Sdk | SdkPick; ops: SessionOps; bus: Bus
  /** marks a turn running; the release lets a restart asked for meanwhile go */
  hold(): () => void
  /** every registered workspace's id and job prefix */
  taken(): { ids: string[]; prefixes: string[] }
  /** the console's folder; default the one this code runs from */
  root?: string
  turnMs?: number
  reintegration?: Reintegration
}

const TURN_MS = 60 * 60_000
const MAX_TURNS = 400
const short = (sha: string) => sha.slice(0, 8)
const iso = () => new Date().toISOString()
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
const clone = (r: AgentRec) => structuredClone(r)

export class AgentSession {
  private o: SessionOpts
  private root: string
  private recs: AgentRec[] | null = null
  private loading: Promise<AgentRec[]> | null = null
  private saving: Promise<unknown> = Promise.resolve()
  private abort: AbortController | null = null
  private stopped = false
  private wake = false
  private turn: Promise<void> | null = null

  constructor(o: SessionOpts) { this.o = o; this.root = o.root ?? CONSOLE }

  /** the conversation the page shows: the newest */
  async current(): Promise<AgentRec | null> { return clone0((await this.load()).at(-1)) }

  /** the person's message as a new turn; done settles when the turn ends */
  async send(text: string): Promise<{ rec: AgentRec; done: Promise<void> }> {
    const t = text.trim()
    if (!t) throw new HttpError(400, 'bad_args', 'say something to the agent')
    return this.begin(t, true)
  }

  stop() {
    if (!this.abort) throw new HttpError(409, 'idle', 'the agent is not answering')
    this.stopped = true
    this.abort.abort()
  }

  /** the console is closing: a turn still running is stopped */
  close() { if (this.abort) { this.stopped = true; this.abort.abort() } }

  /** a new conversation; a waiting grants change and unheard lines move to it */
  async fresh(): Promise<AgentRec> {
    if (this.turn) throw busy()
    const rec = this.next(await this.load())
    await this.persist(rec)
    return clone(rec)
  }

  /** a new conversation that fixes the failed core update on its branch; it starts with the failing output and the core's diff */
  async reintegrate(): Promise<{ rec: AgentRec; done: Promise<void> }> {
    const ri = this.o.reintegration, f = ri?.failed()
    if (!ri || !f) throw new HttpError(409, 'no_update', 'no core update waits to be reintegrated')
    if (this.turn) throw busy()
    if (!REINTEGRABLE.includes(f.step)) throw new HttpError(409, 'not_reintegrable', `the update failed at ${f.step}, before any workspace code ran: apply it again, or give it up`)
    if (!existsSync(f.dir)) throw new HttpError(409, 'update_closed', `the update's worktree ${f.dir} is gone: give it up and update again`)
    const diff = await ri.diff(f)
    if (this.turn) throw busy()
    const rec = this.next(await this.load())
    rec.reintegrate = { core: f.core, from: f.from, branch: f.branch, step: f.step }
    this.note(rec, `Reintegrating core ${f.core.slice(0, 7)}: the update failed at ${f.step}. The agent works on ${f.branch}.`)
    return this.begin(reintegratePrompt({ ws: this.o.ws, core: f.core, from: f.from, step: f.step, output: f.output, diff }), false)
  }

  /** the person takes back one of the agent's commits from the page */
  async undo(sha: string): Promise<AgentRec> {
    if (this.turn) throw busy()
    const xs = await this.load(), c = xs.flatMap((x) => x.commits).find((x) => x.sha === sha)
    if (!c) throw new HttpError(404, 'not_found', `${short(sha)} is not one of the agent's commits`)
    if (c.undoneBy) throw new HttpError(409, 'undone', `${short(c.sha)} is already undone by ${short(c.undoneBy)}`)
    if (c.kind === 'grants' || c.kind === 'undo' || c.kind === 'reintegrate') {
      const what = c.kind === 'grants' ? 'a grants change' : c.kind === 'undo' ? 'an undo' : 'a fix for a core update'
      throw new HttpError(409, 'not_undoable', `${short(c.sha)} is ${what}; it cannot be undone here`)
    }
    const r = await this.o.ops.undo(this.o.ws, c.sha)
    if (!r.ok) throw new HttpError(409, 'undo_failed', [r.error, ...(r.failures ?? [])].join('\n'))
    const rec = await this.last()
    this.committed(rec, { sha: r.sha, summary: r.summary, files: r.files, at: iso(), kind: 'undo' }, c.sha)
    this.note(rec, `You undid ${short(c.sha)} (${c.summary}) with ${short(r.sha)}. The console restarts.`)
    this.tell(rec, `The person undid your commit ${short(c.sha)} "${c.summary}" with ${short(r.sha)}.`)
    await this.persist(rec)
    return clone(rec)
  }

  /** the person's answer to the waiting grants change: accepted, it is committed and the console restarts;
      rejected, the reason goes back to the agent at once, or after its turn */
  async decide(accept: boolean, reason: string): Promise<AgentRec> {
    const rec = await this.last(), p = rec.pending
    if (!p) throw new HttpError(409, 'no_pending', 'no grants change waits')
    if (accept) {
      const r = await this.o.ops.acceptGrants(this.o.ws, p.change, p.reason)
      if (!r.ok) throw new HttpError(409, 'grants_failed', [r.error, ...(r.failures ?? [])].join('\n'))
      delete rec.pending
      rec.commits.push({ sha: r.sha, summary: r.summary, files: r.files, at: iso(), kind: 'grants' })
      this.note(rec, `Grants accepted (${short(r.sha)}): ${p.reason}. The console restarts to apply them.`)
      this.tell(rec, `The person accepted your grants change "${p.reason}" (${short(r.sha)}); the console restarted with them.`)
      await this.persist(rec)
      return clone(rec)
    }
    const why = oneLine(reason)
    if (!why) throw new HttpError(400, 'bad_args', 'say why the change is rejected')
    delete rec.pending
    this.note(rec, `Grants change rejected: ${why}`)
    this.tell(rec, `The person rejected your grants change "${p.reason}". Their reason: ${why}`)
    await this.persist(rec)
    if (this.turn) { this.wake = true; return clone(rec) }
    try { return (await this.begin('', false)).rec } catch (e) {
      console.error(`agent ${this.o.ws}: telling it the rejection failed:`, (e as Error).message)
      return clone(rec)
    }
  }

  /** the records, read once; a turn the console stopped in is failed */
  private load(): Promise<AgentRec[]> {
    if (this.recs) return Promise.resolve(this.recs)
    this.loading ??= (async () => {
      const xs = (await this.o.records.all()).filter((x) => x.ws === this.o.ws).sort((a, b) => a.created.localeCompare(b.created))
      for (const x of xs) if (x.status === 'running') { x.status = 'failed'; x.error = 'the console stopped during the turn'; this.put(x) }
      this.recs = xs
      return xs
    })().finally(() => { this.loading = null })
    return this.loading
  }

  /** the newest conversation, made when there is none; the first of a workspace with empty grants is an interview */
  private async last(): Promise<AgentRec> {
    const xs = await this.load()
    let rec = xs.at(-1)
    if (!rec) { rec = this.make(JSON.stringify(this.grants()) === JSON.stringify(EMPTY_GRANTS)); xs.push(rec) }
    return rec
  }

  /** a new conversation pushed after the newest, which hands it its waiting grants change and unheard lines */
  private next(xs: AgentRec[]): AgentRec {
    const last = xs.at(-1), rec = this.make(false)
    if (last?.pending) { rec.pending = last.pending; delete last.pending }
    if (last?.inbox?.length) { rec.inbox = last.inbox; delete last.inbox }
    if (last) this.put(last)
    xs.push(rec)
    return rec
  }

  /** why a reintegrate conversation can take no more turns: its update was applied, given up or replaced */
  private closed(ri: AgentReintegrate): FailedUpdate | string {
    const f = this.o.reintegration?.failed()
    if (f && f.core === ri.core && f.branch === ri.branch && existsSync(f.dir)) return f
    return `this conversation reintegrated core ${ri.core.slice(0, 7)}, and that update is over: start a new conversation`
  }

  private make(interview: boolean): AgentRec {
    const at = iso()
    return { id: randomUUID(), ws: this.o.ws, provider: pickOf(this.o.sdk).auto(), turns: [], commits: [], status: 'idle', ...(interview ? { interview } : {}), created: at, updated: at }
  }

  private grants(): Grants { return grantsOf(this.o.ws, this.root) ?? EMPTY_GRANTS }

  /** a turn on the newest conversation: its prompt is the unheard lines, then the text */
  private async begin(text: string, own: boolean): Promise<{ rec: AgentRec; done: Promise<void> }> {
    if (this.turn) throw busy()
    const rec = await this.last()
    if (this.turn) throw busy()
    if (this.o.reintegration?.updating()) throw new HttpError(409, 'updating', 'the console is updating: wait until it restarts')
    const f = rec.reintegrate ? this.closed(rec.reintegrate) : null
    if (typeof f === 'string') throw new HttpError(409, 'update_closed', f)
    const pick = pickOf(this.o.sdk)
    // a conversation the provider has not seen yet takes the auto provider now; one it has, stays with it
    if (!rec.session) rec.provider = pick.auto()
    const id = isProvider(rec.provider) ? rec.provider : pick.auto()
    let sdk: Sdk
    try { sdk = pick.get(id) } catch (e) { throw new HttpError(503, 'provider_unavailable', (e as Error).message) }
    if (!sdk.agent) throw new HttpError(501, 'no_agent', `${PROVIDERS[id].label} cannot be a workspace agent`)
    const prompt = [...(rec.inbox ?? []), text].filter(Boolean).join('\n\n')
    if (!prompt) throw new HttpError(400, 'bad_args', 'nothing to say to the agent')
    delete rec.inbox
    if (own) this.say(rec, 'you', text)
    if (rec.reintegrate) delete rec.reintegrate.end
    rec.status = 'running'; delete rec.error
    const release = this.o.hold(), abort = new AbortController()
    this.abort = abort; this.stopped = false
    const done = this.run(rec, sdk, prompt, abort, release, f)
    this.turn = done
    void this.persist(rec)
    return { rec: clone(rec), done }
  }

  /** f = the update a reintegrate turn works on; its worktree is the turn's root */
  private async run(rec: AgentRec, sdk: Sdk, prompt: string, abort: AbortController, release: () => void, f: FailedUpdate | null) {
    const timer = setTimeout(() => abort.abort(), this.o.turnMs ?? TURN_MS)
    let error = '', ok = false
    try {
      const ri = rec.reintegrate
      const tools = f && ri ? reintegrateTools({
        ws: this.o.ws, branch: ri.branch, ops: this.o.reintegration!.opsAt(f.dir),
        committed: (c) => { this.committed(rec, c); void this.persist(rec) },
        end: (kind, reason) => {
          ri.end = kind
          if (kind === 'give-up') this.note(rec, `The agent gives the update up${reason ? `: ${reason}` : ''}.`)
          void this.persist(rec)
        },
      }) : agentTools({ ws: this.o.ws, ops: this.o.ops, hooks: {
        grants: () => this.grants(),
        commits: () => (this.recs ?? []).flatMap((x) => x.commits),
        taken: () => this.o.taken(),
        committed: (c, undoes) => { this.committed(rec, c, undoes); void this.persist(rec) },
        propose: (change, reason) => {
          rec.pending = { id: randomUUID(), change, reason, at: iso(), diff: grantsDiff(this.grants(), change) }
          void this.persist(rec)
        },
      } })
      const system = f && ri ? reintegrateSystem({ ws: this.o.ws, title: this.o.title, core: ri.core, from: ri.from, branch: ri.branch })
        : agentSystem({ ws: this.o.ws, title: this.o.title, interview: rec.interview === true, grants: this.grants() })
      const limits = agentLimits(f ? f.dir : this.root, this.o.ws)
      const events = sdk.agent!({ prompt, resume: rec.session, limits, tools, system, abort })
      for await (const e of events) {
        if (e.k === 'session') { rec.session = e.id; continue }
        if (e.k === 'text') this.say(rec, 'agent', e.t)
        else if (e.k === 'tool') this.say(rec, 'tool', `${e.name} ${e.input}`.slice(0, 200))
        else if (e.ok) {
          ok = true
          const t = e.t?.trim()
          if (t && rec.turns.at(-1)?.t.trim() !== t) this.say(rec, 'agent', t)
        } else error = e.error || 'the turn failed'
        void this.persist(rec)
      }
    } catch (e) { error = (e as Error).message || String(e) }
    clearTimeout(timer)
    const cut = this.stopped || abort.signal.aborted || !!error || !ok
    if (this.stopped) { rec.status = 'idle'; this.note(rec, 'Stopped.') }
    else if (abort.signal.aborted) { rec.status = 'failed'; rec.error = `the turn ran past ${Math.round((this.o.turnMs ?? TURN_MS) / 60_000)} min` }
    else if (error || !ok) { rec.status = 'failed'; rec.error = error || 'the turn ended without an answer' }
    else rec.status = 'idle'
    this.abort = null; this.turn = null
    // a reintegration's update runs only after a turn that finished; a later turn on it starts without its end
    const end = rec.reintegrate?.end
    if (end && cut) {
      delete rec.reintegrate!.end
      this.note(rec, `The update was not run, since the turn did not finish: ${end === 'apply' ? 'Apply' : 'Give up'} on the banner runs it.`)
    }
    await this.persist(rec).catch(() => {})
    // a rejection that came in during the turn is answered before a restart this turn asked for
    if (this.wake && rec.inbox?.length) {
      this.wake = false
      await this.begin('', false).catch((e) => console.error(`agent ${this.o.ws}: telling it the rejection failed:`, (e as Error).message))
    }
    release()
    if (end && !cut) await this.finish(rec, end)
  }

  /** update.mjs as the agent closed the reintegration; its end is noted, and a new failure goes to the agent */
  private async finish(rec: AgentRec, end: UpdateKind) {
    const ri = rec.reintegrate!
    try {
      await this.o.reintegration!.run(end, async (r) => {
        const again = r.failed && r.failed.branch === ri.branch ? r.failed : null
        if (end === 'give-up') this.note(rec, r.code === 0 ? 'The update is given up: its branch and worktree are dropped, and the console stays on its core.' : `Giving the update up failed (exit ${r.code}): ${lastLine(r.output)}`)
        else if (r.updated) this.note(rec, `The update applied: the console is on core ${ri.core.slice(0, 7)} and restarts.`)
        else if (again) {
          this.note(rec, `The update failed again at ${again.step}.`)
          this.tell(rec, reintegrateAgain(again))
        } else this.note(rec, `The update did not apply (exit ${r.code}): ${lastLine(r.output)}`)
        await this.persist(rec)
      })
    } catch (e) {
      this.note(rec, `The update did not run: ${(e as Error).message}`)
      await this.persist(rec).catch(() => {})
    }
  }

  private committed(rec: AgentRec, c: AgentCommit, undoes?: string) {
    rec.commits.push(c)
    if (!undoes) return
    const owner = (this.recs ?? []).find((x) => x.commits.some((y) => y.sha === undoes))
    const was = owner?.commits.find((y) => y.sha === undoes)
    if (was) was.undoneBy = c.sha
    if (owner && owner !== rec) this.put(owner)
  }

  private say(rec: AgentRec, who: AgentWho, t: string) {
    rec.turns.push({ at: iso(), who, t })
    if (rec.turns.length > MAX_TURNS) rec.turns.splice(0, rec.turns.length - MAX_TURNS)
  }
  private note(rec: AgentRec, t: string) { this.say(rec, 'note', t) }
  private tell(rec: AgentRec, line: string) { rec.inbox = [...(rec.inbox ?? []), line] }

  /** stored in order; a failed write is logged, never thrown into a turn */
  private put(rec: AgentRec): Promise<void> {
    const copy = clone(rec), p = this.saving.then(() => this.o.records.put(copy))
    this.saving = p.catch((e) => console.error(`agent ${this.o.ws}: saving the conversation failed:`, (e as Error).message))
    return p
  }
  private persist(rec: AgentRec): Promise<void> {
    // strictly later than the last save, so the page can tell which of two frames of a conversation is newer
    rec.updated = new Date(Math.max(Date.now(), Date.parse(rec.updated) + 1)).toISOString()
    this.o.bus.emit({ kind: 'agent', agent: clone(rec) })
    return this.put(rec)
  }
}

const lastLine = (out: string) => out.trim().split(/\r?\n/).at(-1) ?? ''
const busy = () => new HttpError(409, 'busy', 'the agent is still answering: wait, or stop it')
const clone0 = (r: AgentRec | undefined) => (r ? clone(r) : null)
