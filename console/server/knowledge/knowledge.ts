import { slugify } from '../../src/lib/util.ts'
import { READY, stateError } from '../bridge/wire.ts'
import type { ConceptReply } from '../bridge/wire.ts'
import { HttpError } from '../events.ts'

/* Knowledge in B, for the console's own screens: list, search, read and edit notes by hand, and
   decide what an LLM proposed. B keeps the rules; a refusal comes back as its HTTP status. */

export interface KnowledgeGateway {
  read(concepts: string[]): Promise<Record<string, ConceptReply>>
  get(concept: string, id: string): Promise<ConceptReply>
  state(method: 'GET' | 'POST', path: string, body?: unknown): Promise<ConceptReply>
}
export type NoteIndex = { id: string; v: number; title: string; tags: string[]; updated: string; size: number }
export type Note = { id: string; v: number; title: string; tags: string[]; text: string; updated: string }
export type Hit = NoteIndex & { score: number; snippet: string }
export type Proposal = { id: string; note?: string; baseV?: number; title: string; tags: string[]; text: string; reason: string; by: string; at: string }
export type NoteIn = { title: string; tags: string[]; text: string }
export type Knowledge = ReturnType<typeof knowledge>

const ok = (r: ConceptReply | undefined, what: string) => {
  const x = r ?? { status: 'source_unavailable', message: `the bridge did not answer for ${what}` }
  if (!READY.has(x.status)) throw stateError(x)
  return x
}

export function noteIn(b: Record<string, unknown>): NoteIn {
  const title = typeof b.title === 'string' ? b.title.trim() : ''
  if (!title || typeof b.text !== 'string') throw new HttpError(400, 'bad_args', 'a note needs a title and a text')
  const tags = Array.isArray(b.tags) ? b.tags.filter((t): t is string => typeof t === 'string').map((t) => t.trim()).filter(Boolean) : []
  return { title, tags, text: b.text }
}

export function knowledge(g: KnowledgeGateway) {
  return {
    async list(): Promise<NoteIndex[]> {
      const r = ok((await g.read(['notes'])).notes, 'notes')
      return (r.items as NoteIndex[]).slice().sort((a, b) => a.title.localeCompare(b.title))
    },
    async search(q: string, tags: string[]): Promise<Hit[]> {
      const p = new URLSearchParams({ q, tags: tags.join(',') })
      return ok(await g.state('GET', `/api/knowledge/search?${p}`), 'search').items as Hit[]
    },
    async read(id: string): Promise<Note> { return ok(await g.get('notes', id), 'notes').items as Note },
    /** id null = a new note, keyed by its title's slug; B refuses it when that slug is taken */
    async save(id: string | null, n: NoteIn, v: number | null): Promise<Note> {
      const key = id ?? (slugify(n.title) || 'note')
      const r = ok(await g.state('POST', '/api/state/put', { concept: 'notes', id: key, doc: n, expectV: id ? v : null }), 'notes')
      return (r.items as { doc: Note }).doc
    },
    async proposals(): Promise<Proposal[]> {
      const r = ok((await g.read(['proposals'])).proposals, 'proposals')
      return (r.items as Proposal[]).slice().sort((a, b) => b.at.localeCompare(a.at))
    },
    async decide(id: string, accept: boolean, text?: string): Promise<Note | null> {
      const r = ok(await g.state('POST', '/api/knowledge/decide', { proposal: id, accept, ...(text !== undefined ? { text } : {}) }), 'proposals')
      return (r.items as { doc: Note | null }).doc
    },
  }
}
