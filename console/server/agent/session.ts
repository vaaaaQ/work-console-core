import { randomUUID } from 'node:crypto'
import type { AgentCommit, AgentRec, AgentWho, Grants } from '../../src/model/agent.ts'
import { HttpError } from '../events.ts'
import type { Bus } from '../events.ts'
import { CONSOLE } from '../config.ts'
import { EMPTY_GRANTS, grantsDiff, grantsOf } from '../grants.ts'
import { PROVIDERS, isProvider, pickOf } from '../llm/providers.ts'
import type { SdkPick } from '../llm/providers.ts'
import type { Sdk } from '../llm/sdk.ts'
import { agentLimits } from './limits.ts'
import type { Ops } from './ops.ts'
import { agentSystem } from './prompt.ts'
import type { AgentRecords } from './records.ts'
import { agentTools } from './tools.ts'

/* One managed workspace's agent: one conversation at a time and one turn at a time. A turn holds the console's
   restart until it ends; what the person decides or undoes meanwhile reaches the agent with its next prompt. */

export type SessionOps = Pick<Ops, 'check' | 'apply' | 'undo' | 'createWorkspace' | 'acceptGrants'>
export interface SessionOpts {
  ws: string; title: string; records: AgentRecords; sdk: Sdk | SdkPick; ops: SessionOps; bus: Bus
  /** marks a turn running; the release lets a restart asked for meanwhile go */
  hold(): () => void
  /** every registered workspace's id and job prefix */
  taken(): { ids: string[]; prefixes: string[] }
  /** the console's folder; default the one this code runs from */
  root?: string
  turnMs?: number
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
    const xs = await this.load(), last = xs.at(-1), rec = this.make(false)
    if (last?.pending) { rec.pending = last.pending; delete last.pending }
    if (last?.inbox?.length) { rec.inbox = last.inbox; delete last.inbox }
    if (last) this.put(last)
    xs.push(rec)
    await this.persist(rec)
    return clone(rec)
  }

  /** the person takes back one of the agent's commits from the page */
  async undo(sha: string): Promise<AgentRec> {
    if (this.turn) throw busy()
    const xs = await this.load(), c = xs.flatMap((x) => x.commits).find((x) => x.sha === sha)
    if (!c) throw new HttpError(404, 'not_found', `${short(sha)} is not one of the agent's commits`)
    if (c.undoneBy) throw new HttpError(409, 'undone', `${short(c.sha)} is already undone by ${short(c.undoneBy)}`)
    if (c.kind === 'grants' || c.kind === 'undo') throw new HttpError(409, 'not_undoable', `${short(c.sha)} is ${c.kind === 'grants' ? 'a grants change' : 'an undo'}; it cannot be undone here`)
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
    rec.status = 'running'; delete rec.error
    const release = this.o.hold(), abort = new AbortController()
    this.abort = abort; this.stopped = false
    const done = this.run(rec, sdk, prompt, abort, release)
    this.turn = done
    void this.persist(rec)
    return { rec: clone(rec), done }
  }

  private async run(rec: AgentRec, sdk: Sdk, prompt: string, abort: AbortController, release: () => void) {
    const timer = setTimeout(() => abort.abort(), this.o.turnMs ?? TURN_MS)
    let error = '', ok = false
    try {
      const tools = agentTools({ ws: this.o.ws, ops: this.o.ops, hooks: {
        grants: () => this.grants(),
        commits: () => (this.recs ?? []).flatMap((x) => x.commits),
        taken: () => this.o.taken(),
        committed: (c, undoes) => { this.committed(rec, c, undoes); void this.persist(rec) },
        propose: (change, reason) => {
          rec.pending = { id: randomUUID(), change, reason, at: iso(), diff: grantsDiff(this.grants(), change) }
          void this.persist(rec)
        },
      } })
      const system = agentSystem({ ws: this.o.ws, title: this.o.title, interview: rec.interview === true, grants: this.grants() })
      const events = sdk.agent!({ prompt, resume: rec.session, limits: agentLimits(this.root, this.o.ws), tools, system, abort })
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
    if (this.stopped) { rec.status = 'idle'; this.note(rec, 'Stopped.') }
    else if (abort.signal.aborted) { rec.status = 'failed'; rec.error = `the turn ran past ${Math.round((this.o.turnMs ?? TURN_MS) / 60_000)} min` }
    else if (error || !ok) { rec.status = 'failed'; rec.error = error || 'the turn ended without an answer' }
    else rec.status = 'idle'
    this.abort = null; this.turn = null
    await this.persist(rec).catch(() => {})
    // a rejection that came in during the turn is answered before a restart this turn asked for
    if (this.wake && rec.inbox?.length) {
      this.wake = false
      await this.begin('', false).catch((e) => console.error(`agent ${this.o.ws}: telling it the rejection failed:`, (e as Error).message))
    }
    release()
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
    rec.updated = iso()
    this.o.bus.emit({ kind: 'agent', agent: clone(rec) })
    return this.put(rec)
  }
}

const busy = () => new HttpError(409, 'busy', 'the agent is still answering: wait, or stop it')
const clone0 = (r: AgentRec | undefined) => (r ? clone(r) : null)
