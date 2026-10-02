import type { Job, RunRec } from '../src/model/types.ts'

/* Everything the page hears about travels on a bus; the SSE endpoint and Web Push listen to it. Each workspace
   has its own; the hub re-emits them all on a shared one, each event carrying the id of its workspace as ws. */

export type BridgeState = 'ok' | 'unavailable'
export type Ev = (
  | { kind: 'job'; job: Job }
  | { kind: 'run'; run: RunRec }
  | { kind: 'feed'; run: string; t: string; tool?: string }
  | { kind: 'bridge'; state: BridgeState; concepts: Record<string, string> }
  | { kind: 'source'; concept: string; upserts: unknown[]; removes: string[]; reset?: boolean }
) & { ws?: string }

export class Bus {
  private fs = new Set<(e: Ev) => void>()
  on(f: (e: Ev) => void) { this.fs.add(f); return () => { this.fs.delete(f) } }
  /** a listener that throws never stops the others */
  emit(e: Ev) { for (const f of [...this.fs]) { try { f(e) } catch (err) { console.error('bus listener failed', err) } } }
}

/** an error the HTTP layer turns into {status, error:{code, message}} */
export class HttpError extends Error {
  status: number; code: string
  constructor(status: number, code: string, msg: string) { super(msg); this.status = status; this.code = code }
}
