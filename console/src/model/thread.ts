import type { Draft, RunRec } from './types.ts'

/** a step's conversation: its latest run and the runs it replies to, oldest first */
export function thread(runs: RunRec[], job: string, step: string): RunRec[] {
  const mine = runs.filter((r) => r.job === job && r.step === step)
  if (!mine.length) return []
  const by = new Map(mine.map((r) => [r.id, r]))
  let r: RunRec | undefined = mine.reduce((a, b) => (b.at > a.at ? b : a))
  const out: RunRec[] = []
  while (r && !out.includes(r)) { out.unshift(r); r = r.parent ? by.get(r.parent) : undefined }
  return out
}

/** the run a draft's Approve goes to: the thread's newest, when the draft waits for commands, was written by an LLM
    (not handed in by hand) and the thread has a session to continue; else null */
export function approveTo(dr: Pick<Draft, 'cm' | 'hd'>, t: RunRec[]): RunRec | null {
  if (!dr.cm?.length || dr.hd || !t.some((r) => r.session)) return null
  return t.at(-1) ?? null
}
