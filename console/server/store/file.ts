import { existsSync, readFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import type { Job, Playbook, RunRec, Tpl } from '../../src/model/types.ts'
import { Conflict } from './port.ts'
import type { Mark, Store } from './port.ts'

/* The dev store: one JSON file, rewritten whole (tmp + rename) after every change. Writes are
   serialized, so two commands on one job see each other's version. Good for one PC, not more. */

/** tpl = each stored playbook's planned messages, under its id */
type Data = { jobs: Job[]; runs: RunRec[]; playbooks: Record<string, Playbook>; tpl?: Record<string, Record<string, Tpl[]>>; marks: Record<string, Mark>; seq: number }
export type Seed = { jobs?: Job[]; playbooks?: Record<string, Playbook> }

const copy = <T>(o: T): T => (o === undefined ? o : structuredClone(o))

/** prefix = what job ids start with (`<prefix>-NNNN`), one per workspace */
export function fileStore(path: string, seed: () => Seed = () => ({}), prefix = 'J'): Store {
  const fresh = !existsSync(path)
  let d: Data
  if (!fresh) d = JSON.parse(readFileSync(path, 'utf8'))
  else {
    const s = seed()
    d = { jobs: copy(s.jobs || []), runs: [], playbooks: copy(s.playbooks || {}), marks: {}, seq: 0 }
  }
  d.jobs.forEach((j) => { j.v = j.v || 1 })
  let chain: Promise<unknown> = Promise.resolve()
  /** one change at a time: read-check-write is atomic against other callers */
  const serial = <T>(f: () => T | Promise<T>): Promise<T> => {
    const p = chain.then(f)
    chain = p.catch(() => undefined)
    return p
  }
  const flush = async () => {
    const tmp = path + '.tmp'
    await writeFile(tmp, JSON.stringify(d))
    await rename(tmp, path)
  }
  if (fresh) void serial(flush)

  return {
    jobs: () => serial(() => copy(d.jobs)),
    job: (id) => serial(() => copy(d.jobs.find((j) => j.id === id))),
    putJob: (job, expectV) => serial(async () => {
      const i = d.jobs.findIndex((j) => j.id === job.id), cur = i >= 0 ? d.jobs[i] : undefined
      if ((cur?.v ?? null) !== expectV) throw new Conflict(`${job.id} is at v${cur?.v ?? '-'}, not v${expectV ?? '-'}`, copy(cur))
      const next = { ...copy(job), v: (expectV || 0) + 1 }
      if (i >= 0) d.jobs[i] = next; else d.jobs.unshift(next)
      await flush()
      return copy(next)
    }),
    runs: () => serial(() => copy(d.runs)),
    putRun: (r) => serial(async () => {
      const i = d.runs.findIndex((x) => x.id === r.id)
      if (i >= 0) d.runs[i] = copy(r); else d.runs.push(copy(r))
      // ended runs are history; the newest 400 are enough to explain what happened
      if (d.runs.length > 500) d.runs = d.runs.filter((x) => !x.ended).concat(d.runs.filter((x) => x.ended).slice(-400))
      await flush()
    }),
    playbooks: () => serial(() => copy(d.playbooks)),
    templates: () => serial(() => Object.assign({}, ...Object.values(copy(d.tpl || {})))),
    putPlaybook: (id, pb, tpl) => serial(async () => {
      const t = (d.tpl ||= {})
      if (pb) d.playbooks[id] = copy(pb); else delete d.playbooks[id]
      if (pb && tpl && Object.keys(tpl).length) t[id] = copy(tpl); else delete t[id]
      await flush()
    }),
    marks: () => serial(() => copy(d.marks)),
    putMark: (id, m) => serial(async () => { if (m) d.marks[id] = { ...d.marks[id], ...m }; else delete d.marks[id]; await flush() }),
    nextJobId: () => serial(async () => {
      // only this prefix's ids count; a prefix may hold digits, so the number is what follows the dash
      d.seq = Math.max(d.seq, ...d.jobs.map((j) => (j.id.startsWith(prefix + '-') ? +j.id.slice(prefix.length + 1) || 0 : 0))) + 1
      await flush()
      return `${prefix}-${String(d.seq).padStart(4, '0')}`
    }),
  }
}
