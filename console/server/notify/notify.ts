import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import webpush from 'web-push'
import { pageOf } from '../../src/data/registry.ts'
import * as T from '../../src/model/transitions.ts'
import type { Job, RunRec } from '../../src/model/types.ts'
import type { Bus } from '../events.ts'

/* Web Push for every event worth a look, no batching, no quiet hours. The push service's 404/410
   means the subscription is dead and it is dropped. One Notify serves every workspace: a url names the
   workspace it opens (ws=), and what a source has already pushed is remembered per workspace. */

export type Sub = { endpoint: string; keys?: { p256dh: string; auth: string }; expirationTime?: number | null }
export interface Sender { send(sub: Sub, payload: string): Promise<{ status: number }> }
type Item = Record<string, unknown> & { id: string }

const first = (t: unknown) => String(t ?? '').split('\n').map((l) => l.trim()).find(Boolean) || ''
const cut = (t: string, n = 140) => (t.length > n ? t.slice(0, n - 1) + '…' : t)
/** the page url with the workspace it belongs to; none given, the url as it is */
export const withWs = (url: string, ws?: string) => (ws ? `${url}${url.includes('?') ? '&' : '?'}ws=${encodeURIComponent(ws)}` : url)

function webPushSender(keys: { publicKey: string; privateKey: string; subject: string }): Sender {
  return {
    async send(sub, payload) {
      try {
        const r = await webpush.sendNotification(sub as webpush.PushSubscription, payload, { vapidDetails: keys, TTL: 24 * 3600 })
        return { status: r.statusCode }
      } catch (e) {
        const st = (e as { statusCode?: number }).statusCode
        if (st) return { status: st }
        throw e
      }
    },
  }
}

export class Notify {
  private dir: string; private sender: Sender; private ctx: () => T.Ctx; private jobFor: (text: string, ws?: string) => Job | undefined
  private keys: { publicKey: string; privateKey: string; subject: string }
  private subs: Sub[]
  private unread = new Map<string, number>(); private mails = new Set<string>(); private proposals = new Set<string>(); private marks = new Map<string, string>()

  constructor(o: {
    dir: string; bus: Bus; ctx: () => T.Ctx; sender?: Sender; subject?: string
    jobs?: { onNeedsYou(f: (j: Job) => void): void }; runs?: { onSettled(f: (r: RunRec) => void): void }
    /** the open job a review or build names, among the jobs of the workspace it came from when one is given */
    jobFor: (text: string, ws?: string) => Job | undefined; job?: (id: string) => Job | undefined
  }) {
    this.dir = o.dir; this.ctx = o.ctx; this.jobFor = o.jobFor
    mkdirSync(o.dir, { recursive: true })
    const vf = join(o.dir, 'vapid.json')
    if (existsSync(vf)) this.keys = JSON.parse(readFileSync(vf, 'utf8'))
    else {
      const k = webpush.generateVAPIDKeys()
      this.keys = { ...k, subject: o.subject || 'mailto:work-console@example.org' }
      writeFileSync(vf, JSON.stringify(this.keys, null, 1))
    }
    const sf = join(o.dir, 'push.json')
    this.subs = existsSync(sf) ? JSON.parse(readFileSync(sf, 'utf8')) : []
    this.sender = o.sender ?? webPushSender(this.keys)
    o.jobs?.onNeedsYou((j) => void this.needsYou(j))
    o.runs?.onSettled((r) => void this.run(r, o.job?.(r.job)))
    o.bus.on((e) => { if (e.kind === 'source' && !e.reset) void this.source(e.concept, e.upserts as Item[], e.removes, e.ws) })
  }

  publicKey() { return this.keys.publicKey }
  count() { return this.subs.length }

  private saveSubs() {
    const f = join(this.dir, 'push.json'), tmp = f + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.subs, null, 1)); renameSync(tmp, f)
  }

  subscribe(s: Sub) {
    if (!s || typeof s.endpoint !== 'string' || !/^https:\/\//.test(s.endpoint)) throw new Error('not a push subscription')
    this.subs = this.subs.filter((x) => x.endpoint !== s.endpoint).concat([{ endpoint: s.endpoint, keys: s.keys, expirationTime: s.expirationTime ?? null }])
    this.saveSubs()
  }

  async push(title: string, body: string, url: string) {
    const payload = JSON.stringify({ title, body, url })
    const dead: string[] = []
    await Promise.all(this.subs.map(async (s) => {
      try {
        const r = await this.sender.send(s, payload)
        if (r.status === 404 || r.status === 410) dead.push(s.endpoint)
      } catch (e) { console.error('push failed', (e as Error).message) }
    }))
    if (dead.length) { this.subs = this.subs.filter((s) => !dead.includes(s.endpoint)); this.saveSubs() }
  }

  private stepName(j: Job | undefined, step: string) { return (j && T.stepOf(this.ctx(), j, step)?.t) || step }

  async run(r: RunRec, j?: Job) {
    const what = r.state === 'draft' ? 'draft ready' : r.state === 'failed' ? 'run failed' : r.ar === 'due' ? 'run interrupted, resumes by itself' : 'run interrupted'
    await this.push(`${r.job} · ${this.stepName(j, r.step)}: ${what}`, r.reason || j?.t || '', withWs(`/?job=${encodeURIComponent(r.job)}&step=${encodeURIComponent(r.step)}`, j?.ws))
  }

  async needsYou(j: Job) {
    const x = this.ctx()
    const what = T.hasDraft(j) ? 'a draft to review' : T.unsentAt(x, j) ? 'a message to send' : j.st === 'ready' ? 'ready to start' : 'waiting for you'
    await this.push(`${j.id}: ${what}`, j.t, withWs(`/?job=${encodeURIComponent(j.id)}`, j.ws))
  }

  /** ws = the workspace whose source this is; two workspaces may both have a c1 */
  async source(concept: string, ups: Item[], removes: string[] = [], ws?: string) {
    const k = (id: string) => (ws ? `${ws}/${id}` : id)
    // a thread that left the list (hidden) and comes back unread (mentioned) is new unread again
    if (concept === 'chat') for (const id of removes) this.unread.delete(k(id))
    for (const i of ups || []) {
      if (concept === 'chat') {
        const n = Number(i.unread) || 0, prev = this.unread.get(k(i.id)) ?? 0
        this.unread.set(k(i.id), n)
        if (n > prev) await this.push(String(i.name ?? 'Chat'), cut(`${i.lastFrom ? `${i.lastFrom}: ` : ''}${first(i.lastPreview)}`), withWs(`/?view=chats&chat=${encodeURIComponent(i.id)}`, ws))
      } else if (concept === 'mail') {
        if (i.category !== 'reply' || i.myReply === true || i.unread === false || this.mails.has(k(i.id))) continue
        this.mails.add(k(i.id))
        await this.push(`Mail: ${i.from ?? ''}`, cut(String(i.subject ?? '')), withWs(`/?view=mail&mail=${encodeURIComponent(i.id)}`, ws))
      } else if (concept === 'proposals') {
        if (this.proposals.has(k(i.id))) continue
        this.proposals.add(k(i.id))
        await this.push(`Knowledge: ${String(i.title ?? i.id)}`, cut(`${i.by ? `${i.by}: ` : ''}${first(i.reason)}`), withWs('/?view=approvals', ws))
      } else if (concept === 'review' || concept === 'ci') {
        const j = this.jobFor([i.title, i.branch, i.pipeline, i.id].map((v) => String(v ?? '')).join(' '), ws)
        if (!j) continue
        const mark = concept === 'review'
          ? JSON.stringify(i.votes ?? []) + String(i.activeThreads ?? '')
          : `${i.status ?? ''}/${i.result ?? ''}`
        const key = `${concept}:${k(i.id)}`
        if (this.marks.get(key) === mark) continue
        this.marks.set(key, mark)
        // a review id is written as its workspace writes it
        const change = concept === 'review'
          ? `review ${pageOf(ws ?? j.ws)?.reviewMark ?? '#'}${i.id}: ${(i.votes as { reviewer: string; vote: number }[] | undefined)?.map((v) => `${v.reviewer} ${v.vote > 0 ? '+' : ''}${v.vote}`).join(', ') || 'updated'}`
          : `build ${i.pipeline ?? ''} ${i.result || i.status || ''}`.replace(/\s+/g, ' ').trim()
        await this.push(`${j.id}: ${change}`, j.t, withWs(`/?job=${encodeURIComponent(j.id)}`, ws ?? j.ws))
      }
    }
  }
}
