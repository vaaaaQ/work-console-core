import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { slugify } from '../../src/lib/util.ts'
import { HttpError } from '../events.ts'

/* Knowledge as a folder of Markdown notes, one folder per workspace. A note is <id>.md: front matter whose
   values are JSON (title, tags, playbooks, v, updated), then its text. An LLM never writes a note: its
   proposals wait in .proposals/P-NNNN.json until the user decides. Every call reads the folder, so a note
   edited outside the console shows on the next read. */

export type NoteIndex = { id: string; v: number; title: string; tags: string[]; playbooks: string[]; updated: string; size: number }
export type Note = { id: string; v: number; title: string; tags: string[]; playbooks: string[]; text: string; updated: string }
export type Hit = NoteIndex & { score: number; snippet: string }
export type Proposal = {
  id: string; note?: string; baseV?: number; title: string; tags: string[]; playbooks: string[]; text: string; reason: string; by: string; at: string
}
export type NoteIn = { title: string; tags: string[]; playbooks: string[]; text: string }
/** tags and playbooks left out of a change keep the note's */
export type ProposalIn = { note?: string; title: string; tags?: string[]; playbooks?: string[]; text: string; reason: string; by: string }
/** notes travel as their index entry */
export type NotesChange = (concept: 'notes' | 'proposals', upserts: unknown[], removes: string[]) => void
export type Notes = ReturnType<typeof notesStore>

const MAX_TEXT = 64 * 1024
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/, PID = /^P-\d{4,}$/

const strs = (x: unknown) => (Array.isArray(x) ? x.filter((t): t is string => typeof t === 'string').map((t) => t.trim()).filter(Boolean) : [])
const byTitle = (a: { title: string }, b: { title: string }) => a.title.localeCompare(b.title)
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT'
const conflict = (msg: string) => new HttpError(409, 'conflict', msg)
const tooLarge = () => new HttpError(413, 'too_large', 'a note text is capped at 64 KB')

export function noteIn(b: Record<string, unknown>): NoteIn {
  const title = typeof b.title === 'string' ? b.title.trim() : ''
  if (!title || typeof b.text !== 'string') throw new HttpError(400, 'bad_args', 'a note needs a title and a text')
  return { title, tags: strs(b.tags), playbooks: strs(b.playbooks), text: b.text }
}

/** a value that is not JSON is read leniently: `[a, b]` as a list, anything else as a string */
function value(raw: string): unknown {
  const s = raw.trim()
  try { return JSON.parse(s) } catch { /* hand-written */ }
  if (s.startsWith('[') && s.endsWith(']')) return s.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, ''))
  return s
}

/** front matter is the lines between a first line `---` and the next `---`; without it the file is all text */
export function parseNote(id: string, raw: string, mtime: string): Note {
  const lines = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n').split('\n')
  const end = lines[0] === '---' ? lines.indexOf('---', 1) : -1
  const fm: Record<string, unknown> = {}
  for (const l of end > 0 ? lines.slice(1, end) : []) {
    const i = l.indexOf(':')
    if (i > 0) fm[l.slice(0, i).trim()] = value(l.slice(i + 1))
  }
  const text = lines.slice(end > 0 ? end + 1 : 0).join('\n')
  const title = typeof fm.title === 'string' && fm.title.trim() ? fm.title.trim() : /^#\s+(.+)$/m.exec(text)?.[1].trim() || id
  const v = Number(fm.v)
  return { id, title, tags: strs(fm.tags), playbooks: strs(fm.playbooks), v: Number.isInteger(v) && v > 0 ? v : 1, updated: typeof fm.updated === 'string' ? fm.updated : mtime, text }
}

export function formatNote(n: Note): string {
  return ['---', `title: ${JSON.stringify(n.title)}`, `tags: ${JSON.stringify(n.tags)}`, `playbooks: ${JSON.stringify(n.playbooks)}`, `v: ${n.v}`,
    `updated: ${JSON.stringify(n.updated)}`, '---', n.text].join('\n')
}

export const indexOf = (n: Note): NoteIndex => ({ id: n.id, v: n.v, title: n.title, tags: n.tags, playbooks: n.playbooks, updated: n.updated, size: n.text.length })

/** dir = the workspace's knowledge folder; it need not exist until the first write */
export function notesStore(dir: string, o: { onChange?: NotesChange; now?: () => string } = {}) {
  const pdir = join(dir, '.proposals'), seqFile = join(pdir, '.seq')
  const now = o.now ?? (() => new Date().toISOString()), changed: NotesChange = o.onChange ?? (() => undefined)
  let chain: Promise<unknown> = Promise.resolve()
  /** one write at a time: read-check-write is atomic against the console's other callers */
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const p = chain.then(f)
    chain = p.catch(() => undefined)
    return p
  }
  const checkId = (id: string) => { if (!ID.test(id)) throw new HttpError(400, 'bad_id', `'${id}' is not a note id`); return id }
  const file = (id: string) => join(dir, `${checkId(id)}.md`)
  const pfile = (id: string) => {
    if (!PID.test(id)) throw new HttpError(400, 'bad_id', `'${id}' is not a proposal id`)
    return join(pdir, `${id}.json`)
  }
  const write = async (path: string, s: string) => {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(`${path}.tmp`, s, 'utf8')
    await rename(`${path}.tmp`, path)
  }
  const names = async (d: string) => { try { return await readdir(d) } catch (e) { if (missing(e)) return []; throw e } }
  const load = async (id: string): Promise<Note | undefined> => {
    const p = file(id)
    try {
      const [raw, st] = await Promise.all([readFile(p, 'utf8'), stat(p)])
      return parseNote(id, raw, st.mtime.toISOString())
    } catch (e) { if (missing(e)) return undefined; throw e }
  }
  const all = async () => {
    const ids = (await names(dir)).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).filter((id) => ID.test(id))
    return (await Promise.all(ids.map(load))).filter((n): n is Note => !!n)
  }
  const loadP = async (id: string): Promise<Proposal> => {
    try { return JSON.parse((await readFile(pfile(id), 'utf8')).replace(/^﻿/, '')) as Proposal } catch (e) {
      if (missing(e)) throw new HttpError(404, 'not_found', `proposal '${id}' does not exist`)
      throw e
    }
  }
  // ids never repeat, so a push already sent for one is never mistaken for another
  const nextPid = async () => {
    let last = 0
    try { last = Number((await readFile(seqFile, 'utf8')).trim()) || 0 } catch (e) { if (!missing(e)) throw e }
    for (const f of await names(pdir)) { const m = /^P-(\d+)\.json$/.exec(f); if (m) last = Math.max(last, Number(m[1])) }
    await write(seqFile, String(last + 1))
    return `P-${String(last + 1).padStart(4, '0')}`
  }
  const put = async (n: Note) => { await write(file(n.id), formatNote(n)); changed('notes', [indexOf(n)], []); return n }
  const accept = async (p: Proposal, text?: string) => {
    const body = text ?? p.text
    if (body.length > MAX_TEXT) throw tooLarge()
    let key = p.note ?? (slugify(p.title) || 'note')
    const cur = p.note ? await load(key) : undefined
    if (p.note && (cur?.v ?? null) !== (p.baseV ?? null)) throw conflict(`note '${key}' changed since the proposal`)
    if (!p.note) for (let n = 2, base = key; await load(key); n++) key = `${base}-${n}`
    return put({ id: key, title: p.title, tags: p.tags, playbooks: p.playbooks ?? [], v: (cur?.v ?? 0) + 1, updated: now(), text: body })
  }

  return {
    dir,
    async list(): Promise<NoteIndex[]> { return (await all()).map(indexOf).sort(byTitle) },
    /** every term scores title ×3, tags ×2, text ×1; tags must all match; the best 20 */
    async search(q: string, tags: string[] = []): Promise<Hit[]> {
      const terms = q.toLowerCase().split(/\s+/).filter(Boolean), want = tags.map((t) => t.toLowerCase())
      return (await all())
        .filter((n) => want.every((t) => n.tags.some((x) => x.toLowerCase() === t)))
        .map((n) => {
          const title = n.title.toLowerCase(), text = n.text.toLowerCase(), ts = n.tags.map((t) => t.toLowerCase())
          const score = terms.reduce((s, t) => s + (title.includes(t) ? 3 : 0) + (ts.some((x) => x.includes(t)) ? 2 : 0) + (text.includes(t) ? 1 : 0), 0)
          const hit = terms.find((t) => text.includes(t)), at = Math.max(0, (hit ? text.indexOf(hit) : 0) - 60)
          return { ...indexOf(n), score, snippet: n.text.slice(at, at + 160).replace(/\s+/g, ' ') }
        })
        .filter((h) => !terms.length || h.score > 0)
        .sort((a, b) => b.score - a.score || byTitle(a, b))
        .slice(0, 20)
    },
    async read(id: string): Promise<Note> {
      const n = await load(id)
      if (!n) throw new HttpError(404, 'not_found', `note '${id}' does not exist`)
      return n
    },
    /** what every run of a playbook's jobs gets in full */
    async forPlaybook(pb: string): Promise<Note[]> { return (await all()).filter((n) => n.playbooks.includes(pb)).sort(byTitle) },
    /** id null = a new note, keyed by its title's slug, refused when that is taken; an edit names the v it replaces */
    save: (id: string | null, n: NoteIn, v: number | null) => serial(async () => {
      if (n.text.length > MAX_TEXT) throw tooLarge()
      const key = id ?? (slugify(n.title) || 'note'), cur = await load(key)
      if (id === null && cur) throw conflict(`a note '${key}' exists; pick another title`)
      if (id !== null && (cur?.v ?? null) !== v) throw conflict(`note '${key}' is at v${cur?.v ?? '-'}, not v${v ?? '-'}`)
      return put({ id: key, title: n.title, tags: n.tags, playbooks: n.playbooks, v: (cur?.v ?? 0) + 1, updated: now(), text: n.text })
    }),
    remove: (id: string, v: number) => serial(async () => {
      const cur = await load(id)
      if (!cur) throw new HttpError(404, 'not_found', `note '${id}' does not exist`)
      if (cur.v !== v) throw conflict(`note '${id}' is at v${cur.v}, not v${v}`)
      await rm(file(id))
      changed('notes', [], [id])
    }),
    async proposals(): Promise<Proposal[]> {
      const ids = (await names(pdir)).map((f) => /^(P-\d+)\.json$/.exec(f)?.[1]).filter((x): x is string => !!x && PID.test(x))
      const ps = await Promise.all(ids.map((id) => loadP(id).catch(() => undefined)))
      return ps.filter((p): p is Proposal => !!p).sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))
    },
    propose: (p: ProposalIn) => serial(async () => {
      const title = p.title.trim()
      if (!title || !p.text.trim()) throw new HttpError(400, 'bad_args', 'a proposal needs a title and a text')
      if (p.text.length > MAX_TEXT) throw tooLarge()
      const cur = p.note ? await load(p.note) : undefined
      if (p.note && !cur) throw new HttpError(404, 'not_found', `note '${p.note}' does not exist`)
      const doc: Proposal = {
        id: await nextPid(), ...(cur ? { note: cur.id, baseV: cur.v } : {}), title,
        tags: p.tags ? strs(p.tags) : cur?.tags ?? [], playbooks: p.playbooks ? strs(p.playbooks) : cur?.playbooks ?? [],
        text: p.text, reason: p.reason.trim(), by: p.by, at: now(),
      }
      await write(pfile(doc.id), JSON.stringify(doc, null, 2))
      changed('proposals', [doc], [])
      return doc
    }),
    /** accept writes the note (text = an edit made before accepting) and drops the proposal; a change whose note moved on is a conflict and stays */
    decide: (id: string, yes: boolean, text?: string) => serial(async () => {
      const p = await loadP(id)
      const saved = yes ? await accept(p, text) : null
      await rm(pfile(id))
      changed('proposals', [], [id])
      return saved
    }),
  }
}
