import type { Job, Playbook, RunRec, Tpl } from '../../src/model/types.ts'

/* The state store as the backend sees it. B will implement it; until then store/file.ts does. */

/** the version a write named is no longer the stored one */
export class Conflict extends Error {
  current: Job | undefined
  constructor(msg: string, current?: Job) { super(msg); this.current = current }
}
/** a mail's done/job, or a chat thread's hidden under chat:{threadId}; console-only, never sent to the source */
export type Mark = { done?: boolean; job?: string; hidden?: boolean; name?: string }

export interface Store {
  jobs(): Promise<Job[]>
  job(id: string): Promise<Job | undefined>
  /** stores job with v = expectV + 1 (1 when new, expectV null); Conflict when the stored v differs */
  putJob(job: Job, expectV: number | null): Promise<Job>
  runs(): Promise<RunRec[]>
  putRun(r: RunRec): Promise<void>
  playbooks(): Promise<Record<string, Playbook>>
  /** the stored playbooks' planned messages, by step id */
  templates(): Promise<Record<string, Tpl[]>>
  /** tpl = the playbook's planned messages by step id, kept with it; null deletes both */
  putPlaybook(id: string, pb: Playbook | null, tpl?: Record<string, Tpl[]>): Promise<void>
  marks(): Promise<Record<string, Mark>>
  /** merges into the mark; null deletes it */
  putMark(id: string, m: Mark | null): Promise<void>
  nextJobId(): Promise<string>
}
