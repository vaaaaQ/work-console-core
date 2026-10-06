import type { WorkDetail } from './context.ts'

/* The job page's two panels: the job's work items, and the pull requests linked to them. Built from the
   work get of every work item in the job's context and the review get of every PR those list. Every field
   past the id may be absent: the workplace may run a pack older than these fields. */

/** vote: 10 approved, 5 approved with suggestions, 0 none, -5 waiting for the author, -10 rejected */
export interface Vote { reviewer: string; vote: number }
export interface Policy { name: string; status: string; blocking: boolean }
/** review.get's pr: the PR itself; status active, completed or abandoned; policies only while it is active */
export interface PrHeader {
  title?: string; repo?: string; link?: string; source?: string; target?: string; status?: string; draft?: boolean
  author?: string; closedAt?: string | null; votes?: Vote[]; merge?: string | null; policies?: Policy[] | null
}
/** work.get's fields the panel shows; prs = the ids of the PRs linked to it */
export type WorkHead = Omit<WorkDetail, 'comments' | 'images'> & { link?: string; area?: string; iteration?: string }
export interface WorkCard extends WorkHead { id: string; prs: string[]; err?: string }
/** items = the work items that link it, in the context's order */
export interface PrRow extends PrHeader { id: string; items: string[]; err?: string }
/** supported false = the workspace has no tracker to show (or the job no work item): no panels */
export interface Tracker { supported: boolean; items: WorkCard[]; prs: PrRow[]; at: string }
/** what the page gets; offline = why it shows an earlier snapshot (or nothing): every work item failed to read */
export type TrackerView = Tracker & { offline?: string }

export type TrackerReply = { status: string; items?: unknown; message?: string }
export type TrackerGet = (concept: string, id: string) => Promise<TrackerReply>

const READY = new Set(['ok', 'ready'])
const PR_ID = /^\d+$/
const HEAD = ['type', 'title', 'state', 'assignedTo', 'link', 'area', 'iteration', 'description', 'reproSteps', 'acceptanceCriteria'] as const

async function fetch1(get: TrackerGet, concept: string, id: string): Promise<{ ok: true; d: Record<string, unknown> } | { ok: false; status: string; err: string }> {
  try {
    const r = await get(concept, id)
    if (READY.has(r.status) && r.items && typeof r.items === 'object') return { ok: true, d: r.items as Record<string, unknown> }
    return { ok: false, status: r.status, err: r.message || `the bridge answered ${r.status}` }
  } catch (e) {
    return { ok: false, status: (e as { code?: string }).code || 'unavailable', err: (e as Error).message || String(e) }
  }
}

/** ids = the work items in the job's context, in its order; now = when it was read */
export async function buildTracker(ids: string[], get: TrackerGet, now: string): Promise<Tracker> {
  const works = await Promise.all(ids.map((id) => fetch1(get, 'work', id)))
  if (!ids.length || works.every((w) => !w.ok && w.status === 'unsupported')) return { supported: false, items: [], prs: [], at: now }
  const items: WorkCard[] = works.map((w, i) => {
    const id = ids[i]
    if (!w.ok) return { id, prs: [], err: w.err }
    const card: WorkCard = { id, prs: Array.isArray(w.d.prs) ? [...new Set(w.d.prs.filter((p): p is string => typeof p === 'string' && PR_ID.test(p)))] : [] }
    for (const k of HEAD) if (w.d[k] !== undefined) (card as unknown as Record<string, unknown>)[k] = w.d[k]
    return card
  })
  const by = new Map<string, string[]>()
  for (const c of items) for (const p of c.prs) by.set(p, [...(by.get(p) ?? []), c.id])
  const reviews = await Promise.all([...by.keys()].map((id) => fetch1(get, 'review', id)))
  const prs: PrRow[] = [...by.entries()].map(([id, links], i) => {
    const r = reviews[i]
    if (!r.ok) return { id, items: links, err: r.err }
    const h = r.d.pr && typeof r.d.pr === 'object' ? r.d.pr as PrHeader : {}
    return { ...h, id, items: links }
  })
  prs.sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active') || Number(b.id) - Number(a.id))
  return { supported: true, items, prs, at: now }
}

/** every work item failed to read: the bridge is down, so an earlier snapshot is worth more than this */
export const isOffline = (t: Tracker) => t.supported && t.items.length > 0 && t.items.every((c) => c.err !== undefined)
