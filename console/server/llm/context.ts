import { KINDS, badItem, ctxOf, okItem } from '../../src/model/context.ts'
import type { Resolved } from '../../src/model/context.ts'
import type { CtxItem, Job } from '../../src/model/types.ts'
import { READY } from '../bridge/wire.ts'
import type { ConceptReply } from '../bridge/wire.ts'

/* A job's context read through the bridge, one get per item at once. An item that cannot be read
   becomes text saying why; it never stops a run. */

export interface Getter { get(concept: string, id: string): Promise<ConceptReply> }

/** me = what the user's own entries are signed with, as the prompt names the user */
export async function resolveItem(b: Getter, it: CtxItem, me?: string): Promise<Resolved> {
  try {
    const r = await b.get(KINDS[it.k].concept, it.id)
    if (!READY.has(r.status) || !r.items || typeof r.items !== 'object') return badItem(it, r.status, r.message || `the bridge answered ${r.status}`)
    return okItem(it, r.items, me)
  } catch (e) {
    return badItem(it, (e as { code?: string }).code || 'unavailable', (e as Error).message || String(e))
  }
}

export const resolveContext = (b: Getter, j: Job, me?: string): Promise<Resolved[]> => Promise.all(ctxOf(j).map((it) => resolveItem(b, it, me)))
