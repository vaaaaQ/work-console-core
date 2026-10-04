import { slugify } from '../lib/util.ts'
import type { Mode, Playbook, Step, Tpl, Ws } from './types.ts'

/* ===== the playbook file: what Download writes and Add playbook reads =====
   Plain functions over plain data, so the backend checks the builder's steps by the rules Add playbook uses. */
export const FMT = 'work-console/playbook@1'
export interface PbMsgFile { via?: string; to?: string; text: string }
export interface PbStepFile {
  id: string; title: string; who: Mode; doneWhen: string
  produces?: string[]; messages?: PbMsgFile[]; review?: boolean; output?: string
  /** the console action the step offers */
  act?: string
}
/** needs = in plain words, the context the playbook's jobs need */
export interface PbFile {
  format?: string; key?: string; name: string; description?: string; needs?: string; workspace?: Ws | null
  phases: { code: string; name: string; steps: PbStepFile[] }[]
}

/** added playbooks get step ids prefixed with their key, so they never collide with another playbook's */
export function toInternal(o: PbFile, k: string) {
  const tpl: Record<string, Tpl[]> = {}
  const pb: Playbook = {
    n: o.name.trim(), d: (o.description || '').trim(), ...(o.needs?.trim() ? { needs: o.needs.trim() } : {}), ws: o.workspace || undefined, custom: 1,
    ph: o.phases.map((ph) => ({
      c: String(ph.code).toUpperCase(), n: ph.name.trim(), s: ph.steps.map((s) => {
        const id = k + '/' + s.id, st: Step = { id, fid: s.id, t: s.title.trim(), m: s.who, x: s.doneWhen.trim() }
        if (s.produces && s.produces.length) st.a = s.produces.slice()
        if (s.messages && s.messages.length) { st.msg = s.messages.length; tpl[id] = s.messages.map((m) => [m.via || 'chat', m.to || '', m.text]) }
        if (s.review) st.rv = 1
        if (s.output) st.out = s.output
        if (s.act) st.act = s.act
        return st
      }),
    })),
  }
  return { pb, tpl }
}
/** every problem with a parsed file, in words; empty when it can be added */
export function checkPb(o: unknown): string[] {
  const e: string[] = [], str = (v: unknown) => typeof v === 'string' && !!v.trim()
  if (!o || typeof o !== 'object' || Array.isArray(o)) return ['The file must be one JSON object.']
  const f = o as Record<string, any>
  if (f.format != null && f.format !== FMT) e.push(`Unknown format “${f.format}”; expected ${FMT}.`)
  if (!str(f.name)) e.push('Add a name.')
  if (f.needs != null && typeof f.needs !== 'string') e.push('needs must be words: the context its jobs need.')
  if (!Array.isArray(f.phases) || !f.phases.length) { e.push('Add at least one phase.'); return e }
  const ids = new Set<string>()
  f.phases.forEach((ph: any, i: number) => {
    const at = `Phase ${i + 1}${ph && str(ph.name) ? ` (${ph.name})` : ''}`
    if (!ph || typeof ph !== 'object') { e.push(`${at}: must be an object.`); return }
    if (!/^[A-Za-z0-9]{1,4}$/.test(ph.code || '')) e.push(`${at}: code must be 1–4 letters or digits.`)
    if (!str(ph.name)) e.push(`${at}: add a name.`)
    if (!Array.isArray(ph.steps) || !ph.steps.length) { e.push(`${at}: add at least one step.`); return }
    ph.steps.forEach((s: any, k: number) => {
      const sa = `${at}, step ${k + 1}${s && str(s.id) ? ` “${s.id}”` : ''}`
      if (!s || typeof s !== 'object') { e.push(`${sa}: must be an object.`); return }
      if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,23}$/.test(s.id || '')) e.push(`${sa}: id must be letters, digits or dashes.`)
      else if (ids.has(s.id)) e.push(`${sa}: this id is used twice.`)
      else ids.add(s.id)
      if (!str(s.title)) e.push(`${sa}: add a title.`)
      if (s.who !== 'you' && s.who !== 'llm') e.push(`${sa}: who must be "you" or "llm".`)
      if (!str(s.doneWhen)) e.push(`${sa}: say when it is done (doneWhen).`)
      if (s.produces != null && !(Array.isArray(s.produces) && s.produces.every(str))) e.push(`${sa}: produces must be a list of names.`)
      if (s.messages != null && !(Array.isArray(s.messages) && s.messages.every((m: any) => m && str(m.text) && (m.via == null || ['chat', 'work', 'mail'].includes(m.via)))))
        e.push(`${sa}: each message needs a text, and via must be chat, work or mail.`)
      if (s.review != null && typeof s.review !== 'boolean') e.push(`${sa}: review must be true or false.`)
      if (s.act !== undefined && !str(s.act)) e.push(`${sa}: act must be the name of a console action.`)
    })
  })
  return e
}

/** what a message may name besides the steps' outputs */
const VARS = ['key', 'po', 'pr', 'reporter']
const list = (x: unknown): unknown[] => (Array.isArray(x) ? x : [])
const rec = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {})
const txt = (x: unknown) => (typeof x === 'string' ? x : '')
/** Add playbook's checks, then the ones a message needs to be filled: an output is one word, and a message names
    only words a step fills */
export function stepProblems(f: PbFile): string[] {
  const e = checkPb(f), steps = list(f.phases).flatMap((p) => list(rec(p).steps).map(rec))
  const outs = new Set([...VARS, ...steps.map((s) => txt(s.output)).filter(Boolean)])
  for (const s of steps) {
    const at = `Step “${txt(s.id)}”`
    if (s.output != null && !/^\w+$/.test(txt(s.output))) e.push(`${at}: output must be one word of letters, digits or _.`)
    for (const m of list(s.messages)) for (const [, v] of txt(rec(m).text).matchAll(/\{(\w+)\}/g))
      if (!outs.has(v)) e.push(`${at}: a message names {${v}}, which no step fills.`)
  }
  return e
}

/** a key for new steps: their slug, once- in front for one job's steps, and -2, -3… past a key in use;
    own = the key of the form's unsaved steps, which they may keep */
export function freeKey(name: string, once: boolean, PB: Record<string, Playbook>, own: string | null, taken?: (k: string) => boolean) {
  const slug = slugify(name).replace(/^once-/, '') || 'steps', base = once ? `once-${slug}` : slug
  const busy = (k: string) => k !== own && (Object.hasOwn(PB, k) || !!taken?.(k))
  let k = base
  for (let i = 2; busy(k); i++) k = `${base}-${i}`
  return k
}
