import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { dayOf, fromWall, offsetAt, zoneName } from '../../src/lib/zone.ts'
import { KINDS, ctxLabel, ctxUnit } from '../../src/model/context.ts'
import { holdsOf, reaches } from '../../src/model/blockers.ts'
import { FMT, freeKey, stepProblems } from '../../src/model/pbFormat.ts'
import type { PbFile, PbStepFile } from '../../src/model/pbFormat.ts'
import type { BlockerForm, BuildForm } from '../../src/model/njForm.ts'
import * as T from '../../src/model/transitions.ts'
import type { CtxItem, CtxKind, Job, Mode, Playbook, Tpl } from '../../src/model/types.ts'
import type { WorkspacePage } from '../../src/workspace.ts'
import { READY } from '../bridge/wire.ts'
import type { ConceptReply } from '../bridge/wire.ts'
import { HttpError } from '../events.ts'
import type { Bus } from '../events.ts'
import type { NoteIndex, Notes } from '../knowledge/notes.ts'
import { resolveItem } from './context.ts'
import { hitLine, noteText } from './sdk.ts'
import type { AskTool, Sdk } from './sdk.ts'

/* The job builder: one read-only session per build fills the New job form from what the user said. Its prompt
   carries what most builds need (the workspace, the playbook catalog, the note index, the form and every say),
   so it calls a tool only for what that leaves open: a note, or a work item, chat or mail through the
   workspace's gateway. It proposes; nothing is saved until the user presses Create job. Its answer is checked
   here, and what fails a check stays in the form with the problem in why, never failing the build. */

/** the New job form's shape lives with the page's form */
export type { BuildForm }
/** id = the page's name for the build, which its events carry; say = every say so far, oldest first */
export interface BuildIn { id: string; say: string[]; form: BuildForm }
/** what the source tools read: a concept's list and one item */
export interface SourceReader {
  read(concepts: string[]): Promise<Record<string, ConceptReply>>
  get(concept: string, id: string): Promise<ConceptReply>
}

const str = (x: unknown) => (typeof x === 'string' ? x : '')
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : [])
const obj = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {})
const kindOf = (k: unknown) => (typeof k === 'string' && Object.hasOwn(KINDS, k) ? KINDS[k as CtxKind] : undefined)
/** a one-line text of a list field, at most max chars */
const one = (x: unknown, max = 120) => {
  const t = typeof x === 'number' ? String(x) : typeof x === 'string' ? x.replace(/\s+/g, ' ').trim() : ''
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}
/** a count as a job keeps it: none for a kind read whole, else clamped to the kind's range, default its own */
const countOf = (k: unknown, n: unknown) => {
  const K = kindOf(k)
  if (!K) return undefined
  return K.whole ? 1 : Number.isInteger(n) ? Math.min(Math.max(n as number, 1), K.max) : K.def
}

/* ===== what the page sends ===== */

/** the form as the page sends it, leniently: a missing field is empty and a malformed context item is left out */
export function formIn(f: unknown): BuildForm {
  const o = obj(f), npb = obj(o.npb), bl = obj(o.bl)
  return {
    t: str(o.t), key: str(o.key), prj: str(o.prj), pb: str(o.pb), d: str(o.d), due: str(o.due),
    ctx: arr(o.ctx).flatMap((c) => {
      const x = obj(c), K = kindOf(x.k), id = str(x.id).trim(), name = str(x.name).trim()
      return K && id ? [{ k: x.k as CtxKind, id, n: countOf(x.k, x.n)!, ...(name ? { name } : {}) }] : []
    }),
    npb: npb.file && typeof npb.file === 'object' && !Array.isArray(npb.file) ? { once: npb.once === true, file: npb.file as PbFile } : null,
    why: [],
    ...(str(bl.j) && str(bl.step) ? { bl: { j: str(bl.j), step: str(bl.step), plan: str(bl.plan), link: null } } : {}),
  }
}

export function buildIn(b: Record<string, unknown>): BuildIn {
  if (typeof b.id !== 'string' || !/^[\w-]{1,64}$/.test(b.id)) throw new HttpError(400, 'bad_args', 'id must be 1–64 letters, digits, dashes or underscores')
  const say = arr(b.say).filter((s): s is string => typeof s === 'string').map((s) => s.trim()).filter(Boolean)
  if (!say.length) throw new HttpError(400, 'bad_args', 'say must hold at least one text')
  return { id: b.id, say, form: formIn(b.form) }
}

/* ===== what the session answers ===== */

const S = { type: 'string' } as const
const STEP = {
  type: 'object', additionalProperties: false, required: ['id', 'title', 'who', 'doneWhen'],
  properties: {
    id: S, title: S, who: { type: 'string', enum: ['you', 'llm'] }, doneWhen: S,
    produces: { type: 'array', items: S }, output: S, review: { type: 'boolean' },
    messages: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['via', 'text'], properties: { via: { type: 'string', enum: ['chat', 'work', 'mail'] }, to: S, cc: S, subject: S, text: S } },
    },
  },
}
export const FORM_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['title', 'key', 'project', 'playbook', 'description', 'context', 'due', 'problems'],
  properties: {
    title: S, key: S, project: S, playbook: S,
    newPlaybook: {
      type: 'object', additionalProperties: false, required: ['once', 'key', 'name', 'description', 'phases'],
      properties: {
        once: { type: 'boolean' }, key: S, name: S, description: S, needs: S,
        phases: {
          type: 'array',
          items: { type: 'object', additionalProperties: false, required: ['code', 'name', 'steps'], properties: { code: S, name: S, steps: { type: 'array', items: STEP } } },
        },
      },
    },
    description: S,
    context: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['k', 'id'], properties: { k: { type: 'string', enum: Object.keys(KINDS) }, id: S, n: { type: 'integer' }, name: S } },
    },
    due: S,
    problems: { type: 'array', items: S },
    blocker: {
      type: 'object', additionalProperties: false, required: ['step', 'plan'],
      properties: { step: S, plan: S, link: { type: 'object', additionalProperties: false, required: ['job', 'why'], properties: { job: S, why: S } } },
    },
  },
}

/** a playbook a job of this workspace may follow: its own or the core's, never one job's own steps */
const offered = (PB: Record<string, Playbook>, k: string, ws: string) => Object.hasOwn(PB, k) && !PB[k].once && (!PB[k].ws || PB[k].ws === ws)

function stepOf(s: Record<string, unknown>): PbStepFile {
  const produces = arr(s.produces).filter((p): p is string => typeof p === 'string' && !!p.trim()).map((p) => p.trim())
  const messages = arr(s.messages).map((m) => { const x = obj(m), to = str(x.to).trim(), cc = str(x.cc).trim(), subject = str(x.subject).trim(); return { via: str(x.via) || 'chat', ...(to ? { to } : {}), ...(cc ? { cc } : {}), ...(subject ? { subject } : {}), text: str(x.text) } })
  const output = str(s.output).trim()
  return {
    id: str(s.id).trim(), title: str(s.title).trim(), who: s.who as Mode, doneWhen: str(s.doneWhen).trim(),
    ...(produces.length ? { produces } : {}), ...(output ? { output } : {}), ...(messages.length ? { messages } : {}), ...(s.review === true ? { review: true } : {}),
  }
}
/** new steps as a playbook file of this workspace */
function fileOf(np: Record<string, unknown>, key: string, ws: string): PbFile {
  const needs = str(np.needs).trim()
  return {
    format: FMT, key, name: str(np.name).trim(), description: str(np.description).trim(), ...(needs ? { needs } : {}), workspace: ws,
    phases: arr(np.phases).map((p) => { const ph = obj(p); return { code: str(ph.code).trim(), name: str(ph.name).trim(), steps: arr(ph.steps).map((s) => stepOf(obj(s))) } }),
  }
}

/** a due as the session writes it, as an instant: a day alone is 18:00 that day, a time without an offset the home zone's */
export function dueAt(s: string, tz: string): number {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2})?))?$/.exec(s)
  return m ? fromWall(Date.parse(`${m[1]}T${m[2] ?? '18:00'}Z`), tz) : Date.parse(s)
}

/** the session's answer as the form: the playbook and project checked against the workspace, the context as a job
    keeps it, due as ISO, new steps by Add playbook's rules. A playbook and a key both empty keep the form's choice.
    A due that is not a date keeps the form's. Nothing is dropped silently: each problem goes into why, the session's
    own after the checks' */
export function checkForm(out: unknown, o: { ws: string; form: BuildForm; PB: Record<string, Playbook>; prj: string[]; tz: string; taken?: (k: string) => boolean; jobs?: Job[] }): BuildForm {
  const a = obj(out), why: string[] = [], { form, PB, ws } = o
  const np = obj(a.newPlaybook), own = form.npb ? form.pb : null
  let pb = str(a.playbook).trim(), npb: BuildForm['npb'] = null
  if (pb && pb !== own && (offered(PB, pb, ws) || !Object.keys(np).length)) { /* a catalog playbook, or an unknown one */ }
  else if (Object.keys(np).length) {
    const once = np.once === true
    pb = freeKey(str(np.key) || str(np.name) || str(a.title), once, PB, own, o.taken)
    npb = { once, file: fileOf(np, pb, ws) }
  } else { pb = form.pb; npb = form.npb }
  if (npb) why.push(...stepProblems(npb.file).map((p) => `New steps: ${p}`))
  else if (!pb) why.push('No playbook yet: name one, or say what its steps are.')
  else if (!offered(PB, pb, ws)) why.push(`Playbook ${pb} is not one of this workspace's.`)

  const prj = str(a.project).trim()
  if (prj && !o.prj.includes(prj)) why.push(`Project ${prj} is not one of this workspace's (${o.prj.join(', ') || 'none'}).`)

  const d = str(a.description).trim()
  if (d.length > T.DESC_MAX) why.push(`The description is longer than ${T.DESC_MAX} characters.`)

  const ctx: CtxItem[] = []
  for (const c of arr(a.context)) {
    const x = obj(c)
    try {
      const it = T.ctxItem(ws, { k: x.k, id: x.id, n: countOf(x.k, x.n), name: x.name })
      if (!ctx.some((y) => y.k === it.k && y.id === it.id)) ctx.push(it)
    } catch (e) { why.push(`Context ${one(x.k, 20) || '?'} ${one(x.id, 60) || '?'} was left out: ${(e as Error).message}.`) }
  }

  let due = str(a.due).trim()
  if (due) {
    const t = dueAt(due, o.tz)
    if (Number.isFinite(t)) due = new Date(t).toISOString()
    else { why.push(`Due “${due}” is not a date.`); due = form.due }
  }
  for (const p of arr(a.problems)) if (typeof p === 'string' && p.trim()) why.push(p.trim())
  let bl: BlockerForm | undefined
  if (form.bl) {
    const b = obj(a.blocker), all = o.jobs ?? [], w = all.find((j) => j.id === form.bl!.j)
    let step = str(b.step).trim() || form.bl.step
    if (w && !T.steps({ PB, TPL: {} }, w.pb).some((s) => s.id === step)) { why.push(`Step ${step} is not one of ${w.id}'s.`); step = form.bl.step }
    else if (w && w.flow[step] && !T.isLive(w.flow[step])) { why.push(`Step ${step} of ${w.id} is ${w.flow[step].s === 'done' ? 'done' : 'skipped'}.`); step = form.bl.step }
    const lk = obj(b.link), lj = str(lk.job).trim(), t = all.find((j) => j.id === lj)
    let link: BlockerForm['link'] = null
    if (lj) {
      const no = !t || T.isClosed(t) ? 'there is no such open job' : lj === form.bl.j ? 'it is the waiting job' : t.st === 'recurring' ? 'a recurring job never closes'
        : reaches((i) => all.find((j) => j.id === i), lj, form.bl.j) ? `it already waits for ${form.bl.j}` : ''
      if (no) why.push(`Job ${lj} cannot be linked: ${no}.`)
      else link = { j: lj, why: str(lk.why).trim() }
    }
    bl = { j: form.bl.j, step, plan: str(b.plan).trim() || form.bl.plan, link }
  }
  return { t: str(a.title).trim(), key: str(a.key).trim(), prj, pb, d, ctx, due, npb, why, ...(bl ? { bl } : {}) }
}

/* ===== the prompt ===== */

export const SYSTEM = `You fill in the New job form of a work console from what the user said. You only propose: the user reviews the form and creates the job, and your tools only read.

Answer with the whole form. A field the user's words do not touch keeps its value from "The form now", where the user may have edited it by hand. The says come oldest first; where they disagree, the latest wins. Most builds need one tool call or none: use the tools only for what the prompt leaves open.

- title: short, in English, whatever language the user spoke.
- key: the key of the work item the job is about when the user names one, written as the workspace writes keys; otherwise a short slug of the title, such as weekly-report.
- project: one of the workspace's projects.
- playbook: the key of the catalog playbook that fits the job. When none fits, leave it empty and write newPlaybook. Leave both empty to keep the form's choice.
- newPlaybook: steps for a job no catalog playbook fits. once: true for steps of this job only, false when such jobs will recur and the steps should be saved as a playbook. key: a short slug. Each phase has a code of 1 to 4 letters or digits, a name and at least one step. Each step has an id (letters, digits and dashes, unique), a title, who ("you" for the user, "llm" for an LLM run) and doneWhen. An llm step that drafts a text names its output, one word such as reply; a step that sends it carries messages whose text is "{reply}", via chat (the job's chat), work (a comment on its work item) or mail. A mail without to replies to the job's mail; a new mail has to and cc, mail addresses separated by commas, and a subject, and its drafted text is the body alone. The user reviews and sends every message.
- A job whose result is a new mail needs a step that sends one: a catalog playbook whose send step does not, gets newPlaybook instead. Take the addresses from the sources or the user's words; a person whose address you could not find goes in problems.
- description: Markdown, in English: what the job is for, what done looks like, and what the user said that a run will need. No attachments and no copies of the context items: those go in context.
- context: what every LLM run of the job reads. When the chosen playbook says what its jobs need, give that; otherwise choose what the job needs. Kinds: work (a work item by its id; n = its newest comments, 10 by default, at most 20), chat (by its id; n = its newest messages, 10 by default, at most 50), mail (by its id, read whole), note (a knowledge note by its id, read whole). name: how the item reads to the user, such as a chat's name. A note whose playbooks list the chosen playbook reaches every run already. Take ids from source_list, the note index or the user's words; never invent one.
- due: only when the user named a deadline: ISO 8601 with the home zone's offset, a day without a time meaning 18:00 that day; otherwise the form's.
- problems: what you could not settle, a few words each; empty when nothing.
- blocker: only when the prompt has a "# Blocker" section: the user wants a job that a step of the waiting job waits for. step: the waiting job's step it blocks, the one the user named, else the one the section names. plan: a sentence or two on what that step does with the blocker's outcome, from the user's words, such as "if Imre confirms, set the connection string; if not, ask him for the secret name". link: when an open job already does what the user asks, its id and why, and leave the rest of the form as it is. Otherwise pick the catalog playbook that fits the kind of blocker, or write newPlaybook with once false, so the next blocker of that kind reuses it. A message the blocker sends goes into a step's messages; the user reviews and sends it.`

const offText = (off: number) => {
  const m = Math.round(off / 60000), a = Math.abs(m)
  return `${m < 0 ? '-' : '+'}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`
}
/** an instant as ISO in the zone's wall time, with its offset */
export const zoneIso = (ms: number, tz: string) => { const off = offsetAt(ms, tz); return new Date(ms + off).toISOString().slice(0, 19) + offText(off) }
/** "Sunday 2026-10-04 14:05, Sao Paulo time (UTC-03:00)" */
export function nowLine(now: Date, tz: string) {
  const ms = now.getTime(), off = offsetAt(ms, tz)
  return `${now.toLocaleDateString('en-US', { weekday: 'long', timeZone: tz })} ${dayOf(ms, tz)} ${new Date(ms + off).toISOString().slice(11, 16)}, ${zoneName(tz)} time (UTC${offText(off)})`
}

/** the form in the answer's own field names, its due in the home zone */
export function formOut(f: BuildForm, tz: string) {
  const t = Date.parse(f.due), file = f.npb?.file
  return {
    title: f.t, key: f.key, project: f.prj, playbook: f.npb ? '' : f.pb,
    ...(f.npb && file ? { newPlaybook: { once: f.npb.once, key: f.pb, name: file.name, description: file.description ?? '', ...(file.needs ? { needs: file.needs } : {}), phases: file.phases } } : {}),
    description: f.d, context: f.ctx.map((c) => ({ k: c.k, id: c.id, n: c.n, ...(c.name ? { name: c.name } : {}) })),
    due: Number.isFinite(t) ? zoneIso(t, tz) : f.due,
    ...(f.bl ? { blocker: { step: f.bl.step, plan: f.bl.plan, ...(f.bl.link ? { link: { job: f.bl.link.j, why: f.bl.link.why } } : {}) } } : {}),
  }
}

/** where a planned message goes, as the catalog says it */
const sendsTo = ([via, to]: Tpl) => (via === 'mail' ? (to ? 'a new mail' : "a reply to the job's mail") : via === 'work' ? 'a work item comment' : 'chat')
const catLine = (k: string, pb: Playbook, TPL: Record<string, Tpl[]>) => [
  `- ${k}: ${pb.n}${pb.d ? ` — ${pb.d}` : ''}`,
  ...(pb.needs ? [`  needs: ${pb.needs}`] : []),
  ...pb.ph.map((h) => `  ${h.c} ${h.n}: ${h.s.map((s) => `${s.t} (${s.m === 'llm' ? 'LLM' : 'you'}${TPL[s.id]?.length ? `; sends ${[...new Set(TPL[s.id].map(sendsTo))].join(', ')}` : ''})`).join('; ')}`),
].join('\n')
const noteLine = (n: NoteIndex) => `- ${n.id}: ${n.title}${n.tags.length ? ` · tags ${n.tags.join(', ')}` : ''}${n.playbooks.length ? ` · read by every run of ${n.playbooks.join(', ')}` : ''}`

export const OPEN_MAX = 60
const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n) + '…' : t)
/** the waiting job, its steps, the step the new job blocks, its draft and what the user asked in the reply */
function blockerLines(x: T.Ctx, w: Job, bl: BlockerForm): string[] {
  const f = w.flow[bl.step], s = T.stepOf(x, w, bl.step)
  return [
    '# Blocker',
    `The new job blocks ${w.id} “${w.t}” (playbook ${x.PB[w.pb]?.n ?? w.pb}): one of its steps waits for the new job to close, then goes on with its outcome.`,
    `Steps of ${w.id}: ${T.steps(x, w.pb).map((t) => `${t.id} “${t.t}” (${w.flow[t.id]?.s ?? 'fut'})`).join('; ')}`,
    `The step it blocks now: ${bl.step}${s ? ` “${s.t}”` : ''}`,
    ...(f?.dr ? ["The step's draft:", '```', clip(f.dr.t, 4000), '```'] : []),
    ...(f?.bb ? [`What the user asked in the reply: ${f.bb.say}`] : []),
    '',
  ]
}
/** the workspace's open jobs but the waiting one and the recurring ones, newest first, with what each already holds */
function openLines(x: T.Ctx, w: Job, all: Job[]): string[] {
  const open = all.filter((j) => !T.isClosed(j) && j.st !== 'recurring' && j.id !== w.id).sort((a, b) => b.ts - a.ts).slice(0, OPEN_MAX)
  return ['# Open jobs (newest first)', ...(open.length ? open.map((j) => {
    const h = holdsOf(all, j.id).map((r) => `${r.job.id}/${r.step}`), d = j.d ? one(j.d.split('\n')[0], 100) : ''
    return `- ${j.id}: ${j.t} · ${x.PB[j.pb]?.n ?? j.pb} · ${j.st}${d ? ` · ${d}` : ''}${h.length ? ` · holds ${h.join(', ')}` : ''}`
  }) : ['none']), '']
}

/** the prompt: the workspace, now in the home zone, the catalog with what each playbook's jobs need, the note
    index, whether sources can be read, the form, then every say */
export function buildPrompt(o: { page: WorkspacePage; PB: Record<string, Playbook>; TPL?: Record<string, Tpl[]>; notes: NoteIndex[]; form: BuildForm; say: string[]; now: Date; tz: string; sources: boolean; blocker?: { waiter: Job; all: Job[] } }): string {
  const { page, PB } = o, p = page.pack
  const cat = Object.keys(PB).filter((k) => offered(PB, k, page.id))
  return [
    '# Workspace',
    `${page.id}: ${p.n}${p.d ? ` (${p.d})` : ''}`,
    `Projects: ${p.prj.join(', ') || 'none'}`,
    ...(p.keyPh ? [`A work item's key looks like ${p.keyPh}.`] : []),
    ...(page.me ? [`The user is ${page.me}.`] : []),
    `Now: ${nowLine(o.now, o.tz)}`,
    '',
    '# Playbooks',
    ...(cat.length ? cat.map((k) => catLine(k, PB[k], o.TPL ?? {})) : ['none']),
    '',
    '# Knowledge notes',
    ...(o.notes.length ? o.notes.map(noteLine) : ['none']),
    '',
    '# Sources',
    o.sources ? 'source_list lists the work items, chats and mail with their ids; source_get reads one.' : 'This workspace has no sources to read: context can name notes, and ids the user said.',
    '',
    ...(o.blocker && o.form.bl ? [...blockerLines({ PB, TPL: o.TPL ?? {} }, o.blocker.waiter, o.form.bl), ...openLines({ PB, TPL: o.TPL ?? {} }, o.blocker.waiter, o.blocker.all)] : []),
    '# The form now',
    '```json', JSON.stringify(formOut(o.form, o.tz), null, 2), '```',
    '',
    '# What the user said, oldest first',
    ...o.say.map((s, i) => `${i + 1}. ${s.replace(/\n/g, '\n   ')}`),
  ].join('\n')
}

/* ===== the tools ===== */

const SRC = ['work', 'chat', 'mail'] as const
type SrcKind = (typeof SRC)[number]
const PLURAL: Record<SrcKind, string> = { work: 'work items', chat: 'chats', mail: 'mail' }
const LIST_MAX = 50

function listLine(kind: SrcKind, it: Record<string, unknown>, key: (id: string) => string) {
  const id = one(it.id)
  if (kind === 'work') {
    let k = ''
    try { k = key(id) } catch { /* no key for it */ }
    return `- ${id}${k && k !== id ? ` (${k})` : ''}: ${one(it.title)} · ${one(it.type)} · ${one(it.state)} · ${one(it.assignedTo) || 'unassigned'} · changed ${one(it.changedAt)}`
  }
  if (kind === 'chat') return `- ${id}: ${one(it.name)} (${one(it.kind)}) · ${Number(it.unread) || 0} unread · last ${one(it.lastAt)} ${one(it.lastFrom)}: ${one(it.lastPreview)}`
  return `- ${id}: ${one(it.subject)} · from ${one(it.from)} · ${one(it.at)}${it.folder ? ` · ${one(it.folder)}` : ''} · ${one(it.preview)}`
}

/** the session's tools: the notes, then, with a gateway, the sources' lists and items */
export function buildTools(o: { ws: string; notes: Pick<Notes, 'search' | 'read'>; source: SourceReader | null; me?: string; key(id: string): string }): AskTool[] {
  const src = o.source
  return [
    {
      name: 'knowledge_search', description: "Search the workspace's knowledge notes: how its tools, systems and processes work. Up to 20 notes, best first, each with a snippet.",
      input: { q: z.string() }, run: async (a) => (await o.notes.search(str(a.q))).map(hitLine).join('\n') || 'no note matches',
    },
    { name: 'knowledge_read', description: 'Read one knowledge note in full by its id.', input: { id: z.string().min(1) }, run: async (a) => noteText(await o.notes.read(str(a.id))) },
    ...(src ? [
      {
        name: 'source_list', description: `List the workspace's work items, chats or mail, newest first, one line each with its id. q keeps the lines that hold every one of its words. At most ${LIST_MAX}.`,
        input: { kind: z.enum(SRC), q: z.string().optional() },
        run: async (a: Record<string, unknown>) => {
          const kind = a.kind as SrcKind, r = (await src.read([kind]))[kind]
          if (!r || !READY.has(r.status) || !Array.isArray(r.items)) return `unavailable: ${r?.message || `the bridge answered ${r?.status ?? 'nothing'}`}`
          const words = str(a.q).toLowerCase().split(/\s+/).filter(Boolean)
          const rows = (r.items as unknown[]).map(obj).map((it) => ({ line: listLine(kind, it, o.key), at: one(it.changedAt ?? it.lastAt ?? it.at) }))
            .filter((x) => words.every((w) => x.line.toLowerCase().includes(w)))
            .sort((x, y) => y.at.localeCompare(x.at))
          if (!rows.length) return words.length ? `no ${PLURAL[kind]} match` : `no ${PLURAL[kind]}`
          return rows.slice(0, LIST_MAX).map((x) => x.line).join('\n') + (rows.length > LIST_MAX ? `\n(${rows.length - LIST_MAX} more; narrow with q)` : '')
        },
      },
      {
        name: 'source_get', description: 'Read one work item (with its newest n comments), chat (its newest n messages) or mail by its id, as an LLM run of the job would get it.',
        input: { kind: z.enum(SRC), id: z.string().min(1), n: z.number().int().optional() },
        run: async (a: Record<string, unknown>) => {
          const it = T.ctxItem(o.ws, { k: a.kind, id: a.id, n: countOf(a.kind, a.n) }), r = await resolveItem(src, it, o.me)
          return r.status === 'ok' ? `${KINDS[it.k].l} ${ctxLabel(o.ws, r)} (${ctxUnit(r)})\n\n${r.text}` : `unavailable: ${r.text}`
        },
      },
    ] : []),
  ]
}

/** a tool call as the page shows it while the build runs */
export function toolLine(name: string, a: Record<string, unknown>): string {
  const q = one(a.q, 60), id = one(a.id, 60), kind = SRC.includes(a.kind as SrcKind) ? (a.kind as SrcKind) : null
  if (name === 'knowledge_search') return q ? `Searching notes for “${q}”` : 'Listing notes'
  if (name === 'knowledge_read') return `Reading note ${id}`
  if (name === 'source_list' && kind) return `Listing ${PLURAL[kind]}${q ? ` matching “${q}”` : ''}`
  if (name === 'source_get' && kind) return `Reading ${KINDS[kind].l.toLowerCase()} ${id}`
  return `Using ${name}`
}

/* ===== a build ===== */

export interface BuilderOpts {
  ws: string; page: WorkspacePage; sdk: Sdk; notes: Pick<Notes, 'list' | 'search' | 'read'>
  /** none = a workspace without a gateway: no source tools */
  source: SourceReader | null
  ctx(): T.Ctx; bus: Bus
  /** the workspace's jobs, for blocker mode */
  jobs?: () => Promise<Job[]>
  /** where the session runs; default a folder of its own in the temp dir */
  cwd?: string; timeoutMs?: number; now?: () => Date
}
/** tz = the home zone; signal = the page dropped the request; taken = a key another workspace holds */
export type Build = (b: BuildIn, o: { tz: string; signal?: AbortSignal; taken?: (k: string) => boolean }) => Promise<BuildForm>

export function builder(o: BuilderOpts): Build {
  const ms = o.timeoutMs ?? 120_000
  return async (b, { tz, signal, taken }) => {
    if (!o.sdk.ask) throw new HttpError(501, 'no_builder', 'this console cannot run the builder')
    if (signal?.aborted) throw new HttpError(499, 'aborted', 'the page dropped the request')
    const { PB, TPL } = o.ctx()
    const notes = await o.notes.list().catch(() => [])
    const all = b.form.bl && o.jobs ? (await o.jobs()).filter((j) => j.ws === o.ws) : undefined
    const waiter = b.form.bl ? all?.find((j) => j.id === b.form.bl!.j) : undefined
    if (b.form.bl && all && !waiter) throw new HttpError(400, 'bad_args', `no job ${b.form.bl.j} in this workspace`)
    const prompt = buildPrompt({ page: o.page, PB, TPL, notes, form: b.form, say: b.say, now: o.now?.() ?? new Date(), tz, sources: !!o.source, blocker: waiter && all ? { waiter, all } : undefined })
    const tools = buildTools({ ws: o.ws, notes: o.notes, source: o.source, me: o.page.me, key: (id) => o.page.board.key(id) })
    const cwd = o.cwd ?? join(tmpdir(), 'work-console-build')
    mkdirSync(cwd, { recursive: true })
    const emit = (t: string, tool?: string) => o.bus.emit({ kind: 'build', id: b.id, t, ...(tool ? { tool } : {}) })
    const abort = new AbortController(), stop = () => abort.abort(), timer = setTimeout(stop, ms)
    signal?.addEventListener('abort', stop)
    let out: unknown, error = ''
    emit('Started')
    try {
      for await (const e of o.sdk.ask({ system: SYSTEM, prompt, schema: FORM_SCHEMA, tools, cwd, abort })) {
        if (e.k === 'tool') emit(toolLine(e.name, e.input), e.name)
        else if (e.ok) out = e.out
        else error = e.error
      }
    } catch (e) {
      error = (e as Error).message || String(e)
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop) }
    // an answer that came in before an abort is still the answer
    if (out !== undefined) return checkForm(out, { ws: o.ws, form: b.form, PB, prj: o.page.pack.prj, tz, taken, jobs: all })
    if (signal?.aborted) throw new HttpError(499, 'aborted', 'the page dropped the request')
    if (abort.signal.aborted) throw new HttpError(504, 'timeout', `the builder did not answer in ${Math.round(ms / 1000)} s`)
    if (error.startsWith('signin_required')) throw new HttpError(503, 'signin_required', error)
    throw new HttpError(502, 'build_failed', error || 'the builder ended without a form')
  }
}
