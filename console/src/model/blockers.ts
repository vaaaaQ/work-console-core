import type { Flow, Job, WaitLink } from './types.ts'

/* A step's blockers: other jobs of its workspace it waits for. Pure and free of transitions.ts, which imports it. */

const closed = (j: Job) => j.st === 'done' || j.st === 'cancelled'
const live = (f: Flow) => f.s !== 'done' && f.s !== 'skip'

export const openOf = (f: Flow): WaitLink[] => (f.w || []).filter((l) => l.st === 'open')
/** the step's note while it waits: "waits for J-0007, J-0008" */
export const waitsM = (f: Flow) => `waits for ${openOf(f).map((l) => l.j).join(', ')}`

/** the live steps of open jobs that wait for id */
export function holdsOf(jobs: Job[], id: string): { job: Job; step: string }[] {
  return jobs.flatMap((job) => (closed(job) ? [] : Object.entries(job.flow)
    .filter(([, f]) => live(f) && openOf(f).some((l) => l.j === id)).map(([step]) => ({ job, step }))))
}

/** whether from waits for to through open links of live steps, at any depth */
export function reaches(jobOf: (id: string) => Job | undefined, from: string, to: string): boolean {
  const seen = new Set<string>(), stack = [from]
  while (stack.length) {
    const id = stack.pop()!
    if (id === to) return true
    if (seen.has(id)) continue
    seen.add(id)
    const j = jobOf(id)
    if (!j || closed(j)) continue
    for (const f of Object.values(j.flow)) if (live(f)) for (const l of openOf(f)) stack.push(l.j)
  }
  return false
}

/** the state a reached step's blockers and draft call for; null = leave it as it is */
export function settled(f: Flow): 'cur' | 'wait' | 'bad' | null {
  if (!live(f) || f.s === 'fut' || f.s === 'tpl') return null
  const w = f.w || []
  if (w.some((l) => l.st === 'cancelled')) return 'bad'
  if (w.some((l) => l.st === 'open') || f.dr) return 'wait'
  // a step is bad for other reasons too; only a blocker's bad clears here
  return f.s === 'wait' || (f.s === 'bad' && f.m.startsWith('blocker ')) ? 'cur' : null
}
