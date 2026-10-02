import { itemOf, pageOf } from '../data/registry.ts'
import type { CtxItem, CtxKind, Job, Ws } from './types.ts'

/* What a job gives its LLM runs. Each kind reads one bridge item and turns it into prompt text; the run's
   prompt and the page's preview both use these renderers, so an expanded row shows what the run gets. */

/** concept = the bridge concept its get reads */
export interface Kind { l: string; unit: string; def: number; max: number; ic: string; concept: string }
export const KINDS: Record<CtxKind, Kind> = {
  work: { l: 'Work item', unit: 'comments', def: 10, max: 20, ic: 'file', concept: 'work' },
  chat: { l: 'Chat', unit: 'messages', def: 10, max: 50, ic: 'message', concept: 'chat' },
}
export const CTX_MAX = 10, FIELD_MAX = 4000, ENTRY_MAX = 1500

/** the workspace's board rule; a workspace that is not registered (a job from a removed one) has none */
const boardOf = (ws: Ws) => pageOf(ws)?.board
/** a job key that names a work item: the item's id, or null for any other key */
export const workId = (ws: Ws, key: string): string | null => boardOf(ws)?.itemId(key) ?? null
/** what someone types for a work item: its key or its id */
export const parseWorkId = (ws: Ws, s: string) => { const b = boardOf(ws); return b ? itemOf(b, s.trim()) : null }

export function ctxDefaults(ws: Ws, key: string, chat?: string, chatName?: string): CtxItem[] {
  const out: CtxItem[] = [], w = workId(ws, key)
  if (w) out.push({ k: 'work', id: w, n: KINDS.work.def, name: key })
  if (chat) out.push({ k: 'chat', id: chat, n: KINDS.chat.def, ...(chatName ? { name: chatName } : {}) })
  return out
}
export const ctxOf = (j: Pick<Job, 'ws' | 'key' | 'chat' | 'ctx'>): CtxItem[] => j.ctx ?? ctxDefaults(j.ws, j.key, j.chat)
export const ctxLabel = (ws: Ws, it: Pick<CtxItem, 'k' | 'id' | 'name'>) => it.name || (it.k === 'work' ? (boardOf(ws)?.key(it.id) ?? it.id) : it.id)
export const ctxUnit = (it: Pick<CtxItem, 'k' | 'n'>) => `last ${it.n} ${KINDS[it.k].unit}`

/* ===== reading a bridge item as text ===== */
type Entry = { author?: string; authorKind?: string; at?: string; text?: string }
/** work.get: the header fields are absent while the workplace runs an older pack */
export interface WorkDetail {
  type?: string; title?: string; state?: string; assignedTo?: string | null
  description?: string; reproSteps?: string; acceptanceCriteria?: string; comments?: Entry[]
}
export interface ChatDetail { messages?: Entry[] }
/** status ok = text is the item; anything else = text says why it could not be read */
export interface Resolved extends CtxItem { status: string; text: string }

const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max).trimEnd() + ' […]' : s)
const stamp = (at = '') => (/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(at) ? at.slice(0, 16).replace('T', ' ') + 'Z' : at)
/** the newest n, oldest first */
const latest = (es: Entry[] | undefined, n: number) => (Array.isArray(es) ? es : [])
  .filter((e) => e && typeof e.text === 'string' && e.text.trim())
  .map((e, i) => ({ e, i })).sort((a, b) => String(a.e.at || '').localeCompare(String(b.e.at || '')) || a.i - b.i)
  .slice(-n).map((x) => x.e)
/** me = what the user's own entries are signed with; unset or empty: "the user", as in the prompt */
const entry = (me?: string) => (e: Entry) => `- ${stamp(e.at)} ${e.authorKind === 'me' ? me || 'the user' : e.author || 'unknown'}: ${clip(e.text!.trim(), ENTRY_MAX).replace(/\n/g, '\n  ')}`
const section = (h: string, t: string | undefined) => (t && t.trim() ? [`${h}:`, clip(t.trim(), FIELD_MAX), ''] : [])

export function renderWork(it: CtxItem, d: WorkDetail, me?: string): string {
  const head = `${d.type || 'Work item'} ${it.id}${d.title ? `: ${d.title}` : ''}`
  const meta = [d.state ? `State ${d.state}` : '', d.assignedTo !== undefined ? `assigned to ${d.assignedTo || 'nobody'}` : ''].filter(Boolean).join(' · ')
  const cs = latest(d.comments, it.n)
  return [head, ...(meta ? [meta] : []), '',
    ...section('Description', d.description), ...section('Acceptance criteria', d.acceptanceCriteria), ...section('Repro steps', d.reproSteps),
    ...(cs.length ? ['Comments, oldest first:', ...cs.map(entry(me))] : ['No comments.'])].join('\n')
}
export function renderChat(it: CtxItem, d: ChatDetail, me?: string): string {
  const ms = latest(d.messages, it.n)
  return ms.length ? ms.map(entry(me)).join('\n') : 'No messages.'
}
export const renderItem = (it: CtxItem, d: unknown, me?: string) =>
  (it.k === 'work' ? renderWork(it, (d || {}) as WorkDetail, me) : renderChat(it, (d || {}) as ChatDetail, me))

export const okItem = (it: CtxItem, d: unknown, me?: string): Resolved => ({ ...it, status: 'ok', text: renderItem(it, d, me) })
export const badItem = (it: CtxItem, status: string, why: string): Resolved => ({ ...it, status: status === 'ok' ? 'source_error' : status, text: why })

/** the prompt's context block; empty when the job gives none */
export function contextSection(ws: Ws, rs: Resolved[]): string {
  if (!rs.length) return ''
  return `## Context\n${rs.map((r) => `### ${KINDS[r.k].l} ${ctxLabel(ws, r)} (${ctxUnit(r)})${r.status === 'ok' ? '' : ' — unavailable'}\n${r.text}`).join('\n\n')}\n`
}
