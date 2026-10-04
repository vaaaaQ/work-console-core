import { fromWall, offsetAt } from '../lib/zone.ts'
import { KINDS, ctxDefaults, parseWorkId, workId } from './context.ts'
import { FMT, freeKey, stepProblems, toInternal } from './pbFormat.ts'
import type { PbFile } from './pbFormat.ts'
import * as T from './transitions.ts'
import type { CtxItem, CtxKind, NjDraft, Playbook, Tpl, Ws } from './types.ts'

/* The New job form as plain data, so the page, the backend's builder and the tests share its rules. The builder
   reads the form as a BuildForm and answers with one; mergeBuild folds the answer into the form as it is by then. */

/** the New job form as the builder reads and fills it. pb = a catalog playbook's key, or the key npb is saved
    under; npb = steps the builder wrote, saved before the job is created (once = steps for this job only);
    due = ISO or empty; why = what the builder could not settle, in words */
export interface BuildForm {
  t: string; key: string; prj: string; pb: string; d: string; ctx: CtxItem[]; due: string
  npb: { once: boolean; file: PbFile } | null
  why: string[]
}

/** steps the builder wrote, under the key Create job saves them with */
export interface NjSteps { key: string; once: boolean; file: PbFile }
/** the form on the page. pb = the picked playbook: a catalog key, or npb's key while its steps are picked (npb
    stays when a catalog playbook is picked, so the user can switch back); ctx null = what the key and chat
    imply, until the list is changed; say = the says the form was built from; why = the builder's problems;
    src, chat, chatName, mail, ev = what the job comes from */
export interface Nj {
  ws: Ws; t: string; key: string; prj: string; pb: string; d: string; due: string; ctx: CtxItem[] | null
  npb: NjSteps | null
  src?: string; chat?: string; chatName?: string; mail?: string; ev?: string
  say: string[]; why: string[]
}

/** pbs = the catalog playbooks the workspace offers, prjs = its projects */
export function njStart(ws: Ws, pre: NjDraft & { chatName?: string }, pbs: string[], prjs: string[], PB: Record<string, Playbook>): Nj {
  const pb = pre.pb && pbs.includes(pre.pb) ? pre.pb : pbs.find((k) => PB[k]?.ws) || pbs[0] || ''
  const from = Object.fromEntries((['src', 'chat', 'chatName', 'mail', 'ev'] as const).filter((k) => pre[k]).map((k) => [k, pre[k]]))
  return {
    ws, t: pre.t || '', key: pre.key || '', prj: pre.prj && prjs.includes(pre.prj) ? pre.prj : prjs[0] || '', pb, d: '', due: pre.due || '',
    ctx: null, npb: null, ...from, say: [], why: [],
  }
}

/** the builder's steps are the job's playbook */
export const stepsOn = (f: Nj) => !!f.npb && f.pb === f.npb.key
/** the context the job will get */
export const shownCtx = (f: Nj): CtxItem[] => f.ctx ?? ctxDefaults(f.ws, f.key.trim(), f.chat, f.chatName)

export function buildForm(f: Nj): BuildForm {
  const s = stepsOn(f) ? f.npb! : null
  return { t: f.t, key: f.key, prj: f.prj, pb: f.pb, d: f.d, ctx: shownCtx(f), due: f.due, npb: s && { once: s.once, file: s.file }, why: [] }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
/** The builder's answer in the form as it is now. A field the user changed while the build ran keeps the user's
    value, and so does one the answer leaves empty (title, key, project, description) or names wrong (a project
    or playbook the workspace does not offer: why says so). New steps get picked; a catalog playbook picked
    over steps keeps them. sent = the form the build got; say = every say it got; pbs, prjs as for njStart */
export function mergeBuild(cur: Nj, sent: BuildForm, got: BuildForm, o: { say: string[]; pbs: string[]; prjs: string[] }): Nj {
  const now = buildForm(cur), f: Nj = { ...cur, say: o.say, why: got.why }
  const kept = (k: 't' | 'key' | 'prj' | 'd' | 'due') => now[k] === sent[k]
  if (kept('t') && got.t) f.t = got.t
  if (kept('key') && got.key) f.key = got.key
  if (kept('prj') && o.prjs.includes(got.prj)) f.prj = got.prj
  if (kept('d') && got.d) f.d = got.d
  if (kept('due')) f.due = got.due
  if (same(now.ctx, sent.ctx)) f.ctx = got.ctx
  if (now.pb === sent.pb && same(now.npb, sent.npb)) {
    if (got.npb) { f.npb = { key: got.pb, once: got.npb.once, file: got.npb.file }; f.pb = got.pb }
    else if (o.pbs.includes(got.pb)) f.pb = got.pb
  }
  return f
}

/** the steps as this job's own (once) or as a playbook to keep; their key follows, from their name */
export function njOnce(f: Nj, once: boolean, PB: Record<string, Playbook>): Nj {
  const s = f.npb
  if (!s || s.once === once) return f
  const key = freeKey(s.file.name || s.key, once, PB, null)
  return { ...f, npb: { ...s, once, key }, pb: f.pb === s.key ? key : f.pb }
}
/** steps as edited by hand, picked; they keep their key */
export function njSteps(f: Nj, file: PbFile, PB: Record<string, Playbook>): Nj {
  const once = f.npb?.once ?? false, key = f.npb?.key ?? freeKey(file.name, once, PB, null)
  return { ...f, npb: { key, once, file }, pb: key }
}
/** the picked steps as Create job saves them: the file, the playbook and its messages (null while errs says
    what is wrong) */
export function njPlaybook(f: Nj): { key: string; file: PbFile; errs: string[]; pb: Playbook | null; tpl: Record<string, Tpl[]> } {
  const s = f.npb!, file: PbFile = { ...s.file, format: FMT, key: s.key, workspace: f.ws }, errs = stepProblems(file)
  if (errs.length) return { key: s.key, file, errs, pb: null, tpl: {} }
  const { pb, tpl } = toInternal(file, s.key)
  if (s.once) pb.once = 1
  return { key: s.key, file, errs, pb, tpl }
}

/** the job Create job makes: a description when there is one, the context when it was changed */
export function njJob(f: Nj): T.NewJob {
  const d = f.d.trim(), from = Object.fromEntries((['src', 'chat', 'chatName', 'mail', 'ev', 'due'] as const).filter((k) => f[k]).map((k) => [k, f[k]]))
  return { t: f.t.trim(), key: f.key.trim() || 'NEW', pb: f.pb, prj: f.prj, ws: f.ws, ...from, ...(d ? { d } : {}), ...(f.ctx ? { ctx: f.ctx } : {}) }
}

/* ===== the context list ===== */
/** raw = a work item's key or id, or the picked id; name = how the item reads; answers the new form, or why not */
export function ctxAdd(f: Nj, k: CtxKind, raw: string, n?: number, name?: string): Nj | string {
  const K = KINDS[k], list = shownCtx(f), typed = raw.trim(), what = K.l.toLowerCase()
  const id = k === 'work' ? parseWorkId(f.ws, typed) : typed
  if (!id) return k === 'work' && typed ? `${typed} is not a work item.` : `Pick a ${what}.`
  if (list.some((c) => c.k === k && c.id === id)) return `That ${what} is already in the context.`
  try {
    const nm = k === 'work' ? (workId(f.ws, typed) ? typed : undefined) : name
    return { ...f, ctx: [...list, T.ctxItem(f.ws, { k, id, ...(K.whole ? {} : { n }), ...(nm ? { name: nm } : {}) })] }
  } catch (e) { return (e as Error).message }
}
export const ctxDel = (f: Nj, k: CtxKind, id: string): Nj => ({ ...f, ctx: shownCtx(f).filter((c) => !(c.k === k && c.id === id)) })
/** a count out of the kind's range leaves the form as it is */
export function ctxSet(f: Nj, k: CtxKind, id: string, n: number): Nj {
  const K = KINDS[k]
  if (K.whole || !Number.isInteger(n) || n < 1 || n > K.max) return f
  return { ...f, ctx: shownCtx(f).map((c) => (c.k === k && c.id === id ? { ...c, n } : c)) }
}

/* ===== due, as the field shows it: the home zone's wall time ===== */
/** YYYY-MM-DDTHH:MM, or empty for none */
export function dueWall(iso: string): string {
  const t = Date.parse(iso)
  return iso && Number.isFinite(t) ? new Date(t + offsetAt(t)).toISOString().slice(0, 16) : ''
}
/** the field's value as ISO, or empty for none */
export function wallDue(v: string): string {
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d)(?::\d\d(?:\.\d+)?)?$/.exec(v)
  return m ? new Date(fromWall(Date.parse(m[1] + ':00Z'))).toISOString() : ''
}
