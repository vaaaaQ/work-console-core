import { randomUUID } from 'node:crypto'
import { DEFAULT_PB, boardKey } from '../../src/data/board.ts'
import { DEFAULT_WS, PACKS } from '../../src/data/packs.ts'
import { itemOf } from '../../src/model/context.ts'
import * as T from '../../src/model/transitions.ts'
import type { Job } from '../../src/model/types.ts'
import { READY } from '../bridge/wire.ts'
import type { ActReq, ActRes, ConceptReply } from '../bridge/wire.ts'
import { HttpError } from '../events.ts'
import type { Jobs, Who } from '../jobs/jobs.ts'

/* Start on a board item, the same for the page and a Claude Code session: the tracker assigns the item to
   the user and moves it to Dev, then its open job is reused or a new one is created and started. */

/** longest input Start looks at, counted after trimming; the board rule limits the characters, not the length */
const KEY_MAX = 64
export type StartItem = (key: string, pb?: string, who?: Who) => Promise<{ job: Job; created: boolean }>
interface Deps {
  jobs: Jobs; ctx: () => T.Ctx
  bridge: { available(): boolean; act(a: ActReq): Promise<ActRes>; read(concepts: string[]): Promise<Record<string, ConceptReply>> }
}

export function startItem(d: Deps): StartItem {
  const title = async (id: string, data: unknown) => {
    const t = (data as { title?: unknown } | undefined)?.title
    if (typeof t === 'string' && t.trim()) return t.trim()
    try {
      const b = (await d.bridge.read(['board'])).board
      const hit = READY.has(b?.status) && Array.isArray(b.items) ? (b.items as { id: string; title?: string }[]).find((i) => i.id === id) : undefined
      if (hit?.title?.trim()) return hit.title.trim()
    } catch { /* the key stands in */ }
    return boardKey(id)
  }
  // two Starts on one item (two devices, or the page and a session) run one after the other,
  // so the second finds the job the first created
  const queue = new Map<string, Promise<unknown>>()
  return (key, pb = DEFAULT_PB, who = 'page') => {
    const raw = String(key ?? '').trim(), id = raw.length <= KEY_MAX ? itemOf(raw) : null
    if (!id) return Promise.reject(new HttpError(400, 'bad_args', `${key} is not a board item key`))
    const prev = queue.get(id) ?? Promise.resolve(), run = prev.catch(() => {}).then(() => start(id, pb, who))
    queue.set(id, run)
    void run.catch(() => {}).finally(() => { if (queue.get(id) === run) queue.delete(id) })
    return run
  }
  async function start(id: string, pb: string, who: Who) {
    if (!d.ctx().PB[pb]) throw new HttpError(400, 'bad_args', `no playbook ${pb}`)
    if (!d.bridge.available()) throw new HttpError(503, 'bridge_unavailable', 'the bridge is unavailable; nothing was changed')
    const r = await d.bridge.act({ action: 'work.start', actionId: randomUUID(), args: { id } })
    if (r.status !== 'ok') {
      // the pack's refusal reaches the console as "<source>: bad_args: <why>"
      const m = r.error?.message || r.status, no = /\bbad_args: /.exec(m)
      if (no) throw new HttpError(400, 'refused', m.slice(no.index + no[0].length))
      throw new HttpError(502, r.error?.code || r.status, m)
    }
    const k = boardKey(id)
    const open = (await d.jobs.all()).find((j) => j.key === k && !T.isClosed(j))
    if (open) return { job: open, created: false }
    const job = await d.jobs.create({ t: await title(id, r.result), key: k, pb, prj: PACKS[DEFAULT_WS].prj[0], ws: DEFAULT_WS }, who)
    return { job: (await d.jobs.cmd(job.id, { op: 'start' }, undefined, who)).job, created: true }
  }
}
