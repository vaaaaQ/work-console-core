import * as T from '../../src/model/transitions.ts'
import type { Job } from '../../src/model/types.ts'
import type { Bus } from '../events.ts'
import type { Jobs } from '../jobs/jobs.ts'

/* QA sending an item back shows on the board as a QA column turning into Dev. The item's job,
   reopened if it was closed, gets an open problem note so it needs the user, and one push names it.
   Columns are remembered from the first read on; a return while the console was down is not seen.
   One per workspace: key turns a board item id into a job key by that workspace's board rule. */

type Item = { id: string; column?: unknown }
const QA = /\bQA\b/

export class BoardReturns {
  private jobs: Jobs; private ctx: () => T.Ctx; private read: () => Promise<Item[] | null>; private key: (id: string) => string
  private push: (title: string, body: string, url: string) => Promise<void>
  private cols = new Map<string, string | null>(); private busy = new Set<string>()

  constructor(o: {
    bus: Bus; jobs: Jobs; ctx: () => T.Ctx; read: () => Promise<Item[] | null>; key: (id: string) => string
    push(title: string, body: string, url: string): Promise<void>
  }) {
    this.jobs = o.jobs; this.ctx = o.ctx; this.read = o.read; this.key = o.key; this.push = o.push
    o.bus.on((e) => {
      if (e.kind === 'bridge' && e.state === 'ok') void this.reload()
      else if (e.kind === 'source' && e.concept === 'board') void (e.reset ? this.reload() : this.see(e.upserts as Item[]))
    })
  }

  /** a job this is handling: its generic needs-you push would say the same thing again */
  handling(id: string) { return this.busy.has(id) }

  async reload() {
    try { const items = await this.read(); if (items) await this.see(items) } catch (e) { console.error('reading the board failed:', (e as Error).message) }
  }

  async see(items: Item[]) {
    const back: string[] = []
    for (const i of items || []) {
      const col = typeof i.column === 'string' ? i.column : null, prev = this.cols.get(i.id)
      this.cols.set(i.id, col)
      if (prev && QA.test(prev) && col === 'Dev') back.push(i.id)
    }
    for (const id of back) await this.returned(id).catch((e) => console.error(`handling the QA return of ${this.key(id)} failed:`, (e as Error).message))
  }

  private async returned(id: string) {
    const key = this.key(id), js = (await this.jobs.all()).filter((j) => j.key === key)
    const j: Job | undefined = js.find((x) => !T.isClosed(x)) ?? js.sort((a, b) => b.ts - a.ts)[0]
    if (!j) return
    this.busy.add(j.id)
    try {
      let cur = j
      if (T.isClosed(cur)) cur = (await this.jobs.cmd(cur.id, { op: 'reopen' }, undefined, 'console')).job
      const x = this.ctx(), step = T.atOf(x, cur) ?? T.steps(x, cur.pb).at(-1)?.id
      if (step) cur = (await this.jobs.cmd(cur.id, { op: 'noteAdd', step, k: 'p', t: `QA returned ${key} to Dev; return the job to a step.` }, undefined, 'console')).job
      await this.push(`${cur.id}: QA returned it to Dev`, cur.t, `/?job=${encodeURIComponent(cur.id)}`)
    } finally { this.busy.delete(j.id) }
  }
}
