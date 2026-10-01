/* Bridge A's wire, as its gateway serializes it (camelCase JSON). A concept reply is
   {status:'ok', rev, items} or {status:<error code>, message}; an act reply has the same shape. */

export type ConceptReply = { status: string; rev?: number; items?: unknown; message?: string }
export interface Snapshot {
  bridge: { state: string; at?: string }
  counts?: { chatUnread?: number; mailToReply?: number }
  concepts: Record<string, ConceptReply>
}
export interface Delta { concept: string; fromRev: number; toRev: number; upserts: { id: string }[]; removes: string[]; resync?: boolean }
/** state 'up' carries per-concept states; 'down' is the gateway's own 30 s liveness verdict */
export interface Status { state: 'up' | 'down'; machine?: string; browser?: string; concepts?: Record<string, string>; at?: string }
export interface ActReq { action: string; actionId: string; args: Record<string, unknown> }
export type ActRes = { status: 'ok' | 'error' | 'outcome_unknown'; error?: { code: string; message: string }; result?: unknown }

export interface Gateway {
  snapshot(concepts: string[]): Promise<Snapshot>
  get(concept: string, id: string, cursor?: string): Promise<ConceptReply>
  act(a: ActReq): Promise<ActRes>
}

/** a concept A can serve right now; anything else is shown as unavailable, never as empty */
export const READY = new Set(['ok', 'ready'])

export class GatewayError extends Error {
  status: number; code: string
  constructor(status: number, code: string, msg: string) { super(msg); this.status = status; this.code = code }
}

/** turns the gateway's act reply into ok / error / outcome_unknown */
export function actResult(r: ConceptReply): ActRes {
  // an act's own answer (time.fill's filled/skipped/failed days) rides in items
  if (r.status === 'ok') return r.items != null ? { status: 'ok', result: r.items } : { status: 'ok' }
  if (r.status === 'outcome_unknown') return { status: 'outcome_unknown', error: { code: r.status, message: r.message || 'the outcome is unknown' } }
  return { status: 'error', error: { code: r.status, message: r.message || r.status } }
}

/** a B refusal as the console's HTTP status: the caller's mistake is 4xx, the workplace's trouble 503 */
export function stateError(r: ConceptReply): GatewayError {
  const status = r.status === 'too_large' ? 413 : r.status === 'bad_request' ? 400 : r.status === 'not_found' ? 404 : r.status === 'conflict' ? 409 : 503
  return new GatewayError(status, r.status, r.message || r.status)
}
