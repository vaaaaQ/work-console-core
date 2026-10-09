import * as T from '../../src/model/transitions.ts'
import type { Job, ReplyWatch } from '../../src/model/types.ts'
import { HttpError } from '../events.ts'
import type { Bus } from '../events.ts'
import type { Bridge } from '../http/app.ts'
import { READY } from '../bridge/wire.ts'
import type { ConceptReply } from '../bridge/wire.ts'
import type { Jobs } from './jobs.ts'

/* Replies: an ask step that sent its message waits for the answer in chat or mail. The source is read only when it
   says something changed there, or when it comes back, and each answer is recorded with replyIn; no LLM looks. */

/** seen = the replies the step already has */
export type Watch = { job: string; step: string; rw: ReplyWatch; seen: string[] }
type Msg = { id?: string; author?: string; authorKind?: string; at?: string; text?: string }
export type MailItem = { id: string; folder?: string; from?: string; at?: string; conversationId?: string; preview?: string; link?: string }
type Got = { id: string; at: string; from: string; t: string; link?: string }

/** the open watches: live steps of open jobs that wait for a reply in chat or mail */
export function watches(all: Job[]): Watch[] {
  return all.filter((j) => !T.isClosed(j)).flatMap((j) => Object.entries(j.flow).flatMap(([step, f]) =>
    f.rw && T.isLive(f) && (f.rw.src === 'chat' || f.rw.src === 'mail') ? [{ job: j.id, step, rw: f.rw, seen: (f.rp ?? []).map((r) => r.id) }] : []))
}
const after = (w: ReplyWatch, at: unknown) => typeof at === 'string' && Date.parse(at) > Date.parse(w.at)
const oldest = (a: { at?: string }, b: { at?: string }) => Date.parse(a.at!) - Date.parse(b.at!)
/** a chat message that answers w: a person's, after the message went out */
export const chatHit = (w: ReplyWatch, m: { authorKind?: string; at?: string }) => m.authorKind === 'person' && after(w, m.at)
/** a mail that answers w: in Inbox, after it went out, in its thread or from its addressee */
export const mailHit = (w: ReplyWatch, conv: string | null, m: MailItem) => m.folder === 'Inbox' && after(w, m.at)
  && ((!!conv && m.conversationId === conv) || (!!w.to && w.to.split(/[,;]/).map((a) => a.trim().toLowerCase()).some((a) => !!a && String(m.from ?? '').toLowerCase().includes(a))))
const mailOf = (r: ConceptReply | undefined): MailItem[] => (r && READY.has(r.status) && Array.isArray(r.items) ? (r.items as MailItem[]) : [])

export class Replies {
  private jobs: Jobs; private source: Pick<Bridge, 'get' | 'read'>
  private chain = Promise.resolve(); private off: () => void
  /** a replied mail's id → its conversation, once looked up */
  private threads = new Map<string, string>()
  /** the jobs as saved, kept from the bus so a source event reads no store; null = not read yet */
  private known: Map<string, Job> | null = null

  constructor(o: { jobs: Jobs; source: Pick<Bridge, 'get' | 'read'>; bus: Bus }) {
    this.jobs = o.jobs; this.source = o.source
    this.off = o.bus.on((e) => {
      if (e.kind === 'job') this.known?.set(e.job.id, e.job)
      if (e.kind !== 'source') return
      if (e.concept === 'chat') { const ids = e.reset ? null : new Set((e.upserts as { id?: string }[]).map((u) => u?.id)); void this.queue(() => this.chat(ids)) }
      if (e.concept === 'mail') { const items = e.reset ? null : (e.upserts as MailItem[]); void this.queue(() => this.mail(items)) }
    })
  }

  /** every open watch re-read from the source since its at */
  reconcile() { return this.queue(async () => { this.known = null; await this.chat(null); await this.mail(null) }) }
  /** settles when the checks queued so far are done */
  idle() { return this.chain }
  stop() { this.off() }

  // one check at a time, as the events came; a failed one is logged and the next goes on
  private queue(f: () => Promise<void>) {
    this.chain = this.chain.then(f).catch((e) => console.error(`replies: ${(e as Error).message}`))
    return this.chain
  }
  private async open(src: string) {
    this.known ??= new Map((await this.jobs.all()).map((j) => [j.id, j]))
    return watches([...this.known.values()]).filter((w) => w.rw.src === src)
  }
  private async each(ws: Watch[], f: (w: Watch) => Promise<void>) {
    for (const w of ws) { try { await f(w) } catch (e) { console.error(`replies: ${w.job} ${w.step}: ${(e as Error).message}`) } }
  }

  /** ids = the chats that changed; null = all of them */
  private async chat(ids: Set<string | undefined> | null) {
    await this.each((await this.open('chat')).filter((w) => w.rw.ch && (!ids || ids.has(w.rw.ch))), async (w) => {
      const r = await this.source.get('chat', w.rw.ch), ms = (r.items as { messages?: Msg[] } | undefined)?.messages ?? []
      for (const m of ms.filter((m) => chatHit(w.rw, m)).sort(oldest)) {
        const id = m.id ?? `${w.rw.ch}@${m.at}`
        if (!w.seen.includes(id)) await this.record(w, { id, at: m.at!, from: m.author || 'someone', t: m.text ?? '' })
      }
    })
  }

  /** items = the mails that changed; null = read the whole list */
  private async mail(items: MailItem[] | null) {
    const ws = await this.open('mail')
    if (!ws.length) return
    let all: MailItem[] | null = null
    const list = async () => (all ??= mailOf((await this.source.read(['mail'])).mail))
    const changed = items ?? await list()
    await this.each(ws, async (w) => {
      let conv = w.rw.ch ? this.threads.get(w.rw.ch) ?? null : null
      if (w.rw.ch && !conv) {
        conv = (changed.find((m) => m.id === w.rw.ch) ?? (await list()).find((m) => m.id === w.rw.ch))?.conversationId ?? null
        if (conv) this.threads.set(w.rw.ch, conv)
      }
      for (const m of changed.filter((m) => mailHit(w.rw, conv, m) && !w.seen.includes(m.id)).sort(oldest)) {
        let t = String(m.preview ?? '')
        try { const b = (await this.source.get('mail', m.id)).items as { body?: unknown } | undefined; if (typeof b?.body === 'string' && b.body.trim()) t = b.body } catch { /* the preview stands in */ }
        await this.record(w, { id: m.id, at: m.at!, from: m.from || 'someone', t, ...(m.link ? { link: m.link } : {}) })
      }
    })
  }

  /** a step that moved on meanwhile no longer waits; its reply is dropped */
  private async record(w: Watch, g: Got) {
    try { await this.jobs.cmd(w.job, { op: 'replyIn', step: w.step, ...g }, undefined, 'console') } catch (e) {
      if (!(e instanceof HttpError && e.code === 'bad_state')) throw e
    }
  }
}
