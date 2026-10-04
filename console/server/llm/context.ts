import { KINDS, badItem, ctxLabel, ctxOf, okItem } from '../../src/model/context.ts'
import type { Resolved, WorkDetail, WorkImage } from '../../src/model/context.ts'
import type { CtxItem, Job } from '../../src/model/types.ts'
import { READY } from '../bridge/wire.ts'
import type { ConceptReply } from '../bridge/wire.ts'
import type { Notes } from '../knowledge/notes.ts'

/* A job's context read through the bridge, one get per item at once, and its notes from the workspace's
   notes. An item that cannot be read becomes text saying why; it never stops a run. A work item's text
   names its pictures [image N]; a run gets them too, each through an image get, numbered across the prompt. */

export interface Getter { get(concept: string, id: string): Promise<ConceptReply> }
export type NoteReader = Pick<Notes, 'read'>
/** a picture a run gets with its prompt; label = the line before it, which names the [image N] the text uses */
export interface PromptImage { label: string; mime: string; data: string }
/** the job's context items as a run gets them, and their pictures */
export interface RunContext { ctx: Resolved[]; images: PromptImage[] }

/** the pictures one run gets at most */
export const IMG_MAX = 20
/** what the model takes; a picture of another type or over IMG_DATA base64 chars counts as unreadable */
const MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
const IMG_DATA = 5 * 1024 * 1024
const MARK = /\[image (\d+)\]/g
const FROM = new Map([['description', 'description'], ['reproSteps', 'repro steps'], ['acceptanceCriteria', 'acceptance criteria']])

async function read(b: Getter, it: CtxItem, me?: string, notes?: NoteReader): Promise<{ r: Resolved; d?: unknown }> {
  try {
    const concept = KINDS[it.k].concept
    if (concept === null) return { r: notes ? okItem(it, await notes.read(it.id), me) : badItem(it, 'unavailable', 'this workspace has no notes') }
    const r = await b.get(concept, it.id)
    if (!READY.has(r.status) || !r.items || typeof r.items !== 'object') return { r: badItem(it, r.status, r.message || `the bridge answered ${r.status}`) }
    return { r: okItem(it, r.items, me), d: r.items }
  } catch (e) {
    return { r: badItem(it, (e as { code?: string }).code || 'unavailable', (e as Error).message || String(e)) }
  }
}

/** me = what the user's own entries are signed with, as the prompt names the user */
export const resolveItem = async (b: Getter, it: CtxItem, me?: string, notes?: NoteReader): Promise<Resolved> => (await read(b, it, me, notes)).r

/** a work get's pictures by their place; a malformed one keeps its place as null */
function imagesOf(d: unknown): (WorkImage | null)[] {
  const xs = (d as WorkDetail | undefined)?.images
  return Array.isArray(xs) ? xs.map((x) => (x && typeof x === 'object' && typeof x.ref === 'string' && x.ref ? x : null)) : []
}
const line = (s: unknown) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, 200) : '')
/** an image get's answer as the model takes it, or null */
function pic(r: ConceptReply): { mime: string; data: string } | null {
  const p = r.items as { mime?: unknown; data?: unknown } | undefined
  if (!READY.has(r.status) || !p || typeof p !== 'object') return null
  if (typeof p.mime !== 'string' || !MIMES.has(p.mime) || typeof p.data !== 'string' || !p.data || p.data.length > IMG_DATA) return null
  return { mime: p.mime, data: p.data }
}

/** the job's context for a run: every item read at once, then the pictures its work items' text names, at most
    IMG_MAX, read at once. A work item's pictures go by the pack's order (its fields, then comments newest first)
    and items by the context's. Their [image N] are numbered across the prompt in the order the text names them;
    one that is not read says [image N: unavailable] and never fails the run. */
export async function resolveContext(b: Getter, j: Job, me?: string, notes?: NoteReader): Promise<RunContext> {
  const rs = await Promise.all(ctxOf(j).map((it) => read(b, it, me, notes)))
  const want: { ref: string; label: string; g: number }[] = []
  let g = 0
  const nums = rs.map(({ r, d }) => {
    if (r.k !== 'work' || r.status !== 'ok') return null
    const list = imagesOf(d)
    // only the pictures the text names: a comment the run does not get brings none
    const shown = [...new Set([...r.text.matchAll(MARK)].map((m) => Number(m[1])))].filter((n) => list[n - 1])
    const keep = new Set([...shown].sort((a, b) => a - b).slice(0, Math.max(0, IMG_MAX - want.length)))
    const num = new Map<number, number>()
    for (const n of shown) {
      num.set(n, ++g)
      if (!keep.has(n)) continue
      const im = list[n - 1]!, where = FROM.get(im.from ?? '') ?? line(im.from).replace(/^comment:/, 'comment ')
      want.push({ ref: im.ref, g, label: `[image ${g}] ${ctxLabel(j.ws, r)}${where ? `, ${where}` : ''}${line(im.name) ? `: ${line(im.name)}` : ''}` })
    }
    return num
  })
  const pics = await Promise.all(want.map((w) => b.get('image', w.ref).then(pic, () => null)))
  const got = new Set(want.filter((_, i) => pics[i]).map((w) => w.g))
  const ctx = rs.map(({ r }, i) => {
    const num = nums[i]
    if (!num) return r
    return { ...r, text: r.text.replace(MARK, (_m, n: string) => {
      const x = num.get(Number(n))
      return x === undefined ? '[image: unavailable]' : got.has(x) ? `[image ${x}]` : `[image ${x}: unavailable]`
    }) }
  })
  return { ctx, images: want.flatMap((w, i) => (pics[i] ? [{ label: w.label, ...pics[i]! }] : [])) }
}
