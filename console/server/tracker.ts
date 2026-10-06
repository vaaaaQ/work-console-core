import { buildTracker, isOffline, isPartial } from '../src/model/tracker.ts'
import type { Tracker, TrackerGet, TrackerView } from '../src/model/tracker.ts'

/* The job page's work item and PR panels, read through the bridge and kept per job for five minutes.
   While the bridge is down a job's last snapshot is answered instead, with why; a read that fails
   anywhere is shown but never kept. */

export const TRACKER_TTL = 5 * 60_000

export class TrackerCache {
  private m = new Map<string, { ids: string; t: Tracker; ms: number }>()
  private now: () => number; private ttl: number
  constructor(o: { now?: () => number; ttl?: number } = {}) { this.now = o.now ?? Date.now; this.ttl = o.ttl ?? TRACKER_TTL }

  /** ids = the job's work items; fresh = skip the cache */
  async read(job: string, ids: string[], get: TrackerGet, fresh = false): Promise<TrackerView> {
    const key = ids.join('\n'), hit = this.m.get(job), ms = this.now()
    const same = hit && hit.ids === key ? hit : undefined
    if (same && !fresh && ms - same.ms < this.ttl) return same.t
    const t = await buildTracker(ids, get, new Date(ms).toISOString())
    if (isOffline(t)) {
      const offline = t.items[0].err!
      return same ? { ...same.t, offline } : { ...t, offline }
    }
    if (!isPartial(t)) this.m.set(job, { ids: key, t, ms })
    return t
  }
}
