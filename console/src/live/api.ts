import type { CalEvent, Chat, Cmd, Job, Mail, Msg, Playbook, RunRec } from '../model/types.ts'
import type { NewJob } from '../model/transitions.ts'
import type { Resolved } from '../model/context.ts'
import type { BoardItem } from '../data/board.ts'
import type { TimeItem } from '../data/time.ts'

/* The page's side of the backend. Without a backend (the published artifact, `vite dev`) detect()
   answers null and the page stays the in-memory demo. */

export type CalItem = CalEvent & { id: string }
/** status ok carries items; anything else (unavailable, signin_required, …) carries a message */
export type ConceptState = { status: string; rev?: string; items?: unknown[]; message?: string }
export type Device = { id: string; name: string; at: string; lastSeen?: string }
export type Part = 'ok' | 'unavailable'
export interface State {
  jobs: Job[]; runs: RunRec[]; playbooks: Record<string, Playbook>
  marks: Record<string, { done?: boolean; job?: string }>
  /** a part B could not give comes back empty and unavailable */
  parts: { jobs: Part; runs: Part; marks: Part }
  bridge: { state: 'ok' | 'unavailable'; concepts: Record<string, string> }
  side: 'loopback' | 'lan'; device: string | null; push: { key: string } | null
}
export type Ev =
  | { kind: 'job'; job: Job } | { kind: 'run'; run: RunRec } | { kind: 'feed'; run: string; t: string; tool?: string }
  | { kind: 'bridge'; state: 'ok' | 'unavailable'; concepts: Record<string, string> }
  | { kind: 'source'; concept: string }
export type ActRes = { actionId: string; status: 'ok' | 'error' | 'outcome_unknown'; error?: { code: string; message: string }; result?: unknown }
export type NoteIndex = { id: string; v: number; title: string; tags: string[]; updated: string; size: number }
export type Note = { id: string; v: number; title: string; tags: string[]; text: string; updated: string }
export type Hit = NoteIndex & { score: number; snippet: string }
export type Proposal = { id: string; note?: string; baseV?: number; title: string; tags: string[]; text: string; reason: string; by: string; at: string }
export type NoteIn = { title: string; tags: string[]; text: string }

export class ApiError extends Error {
  status: number; code: string
  constructor(status: number, code: string, msg: string) { super(msg); this.status = status; this.code = code }
}

/** what the page knows about the backend: on = live mode, pc = opened on the PC itself (pairing, devices) */
export const LIVE = {
  on: false, pc: false, paired: true,
  bridge: 'ok' as 'ok' | 'unavailable', concepts: {} as Record<string, string>,
  runs: {} as Record<string, RunRec>, feed: {} as Record<string, string[]>,
  /** per concept: ok, loading, or why it is unavailable */
  sources: {} as Record<string, string>, cal: [] as CalItem[], time: [] as TimeItem[],
  board: [] as BoardItem[],
  push: null as string | null,
  /** knowledge in B: the note index, proposals waiting in Approvals, and 'ok', 'loading' or why not */
  notes: [] as NoteIndex[], proposals: [] as Proposal[], kn: 'loading',
  parts: { jobs: 'ok', runs: 'ok' } as Record<string, Part>,
}

/** the parts of the state B did not give while the bridge is up: unavailable, not empty */
export const missingParts = () => (LIVE.bridge === 'ok' ? ['jobs', 'runs'].filter((k) => LIVE.parts[k] === 'unavailable') : [])

let base = ''
/** tests point the client at a server; the page uses its own origin */
export function setBase(b: string) { base = b }

const enc = encodeURIComponent

async function call<T>(method: string, path: string, body?: unknown, timeout = 15000): Promise<T> {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), timeout)
  // every write carries a JSON body: the backend refuses a POST without one (415)
  const b = body === undefined && method !== 'GET' && method !== 'DELETE' ? {} : body
  try {
    const r = await fetch(base + path, {
      method, signal: ac.signal, credentials: 'same-origin',
      headers: b === undefined ? {} : { 'content-type': 'application/json' },
      body: b === undefined ? undefined : JSON.stringify(b),
    })
    const txt = await r.text()
    let data: Record<string, unknown> = {}
    try { data = txt ? JSON.parse(txt) : {} } catch { data = { error: { code: String(r.status), message: txt.slice(0, 200) } } }
    const err = data?.error as { code?: string; message?: string } | undefined
    if (!r.ok) throw Object.assign(new ApiError(r.status, err?.code || String(r.status), err?.message || r.statusText), { body: data })
    return data as T
  } catch (e) {
    if (e instanceof ApiError) throw e
    throw new ApiError(0, 'network', ac.signal.aborted ? 'the console backend did not answer' : String((e as Error).message || e))
  } finally { clearTimeout(t) }
}

/** null = no backend (demo); 'unpaired' = this device has no pairing yet */
export async function detect(): Promise<State | null | 'unpaired'> {
  try {
    const st = await call<State>('GET', '/api/state', undefined, 1500)
    // a dev server answers any path with the page; only the backend's state counts
    return st && Array.isArray(st.jobs) ? st : null
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return 'unpaired'
    return null
  }
}
export const state = () => call<State>('GET', '/api/state')
export const cmd = (id: string, c: Cmd, v: number | undefined) =>
  call<{ job: Job; prev: Job; nx: string | null }>('POST', `/api/jobs/${enc(id)}/cmd`, { cmd: c, v })
export const job = (id: string) => call<{ job: Job }>('GET', `/api/jobs/${enc(id)}`)
export const create = (o: NewJob) => call<{ job: Job }>('POST', '/api/jobs', o)
/** one context item as the job's next run would get it */
export const ctxPreview = async (id: string, k: string, item: string) =>
  (await call<{ item: Resolved }>('GET', `/api/jobs/${enc(id)}/context/${enc(k)}/${enc(item)}`, undefined, 30000)).item
export const undo = (id: string, v: number, prev: Job) => call<{ job: Job }>('POST', '/api/undo', { job: id, v, prev })
/** an artifact's text for the viewer; link is the one the runner recorded */
export async function artText(link: string): Promise<string> {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), 15000)
  try {
    const r = await fetch(base + link, { signal: ac.signal, credentials: 'same-origin' })
    if (!r.ok) throw new ApiError(r.status, String(r.status), r.status === 404 ? 'the file is no longer there' : r.statusText)
    return await r.text()
  } catch (e) {
    if (e instanceof ApiError) throw e
    throw new ApiError(0, 'network', ac.signal.aborted ? 'the console backend did not answer' : String((e as Error).message || e))
  } finally { clearTimeout(t) }
}
/** job = the job the message belongs to, so the backend can find its chat */
export const act = (action: string, args: Record<string, unknown>, jobId?: string) =>
  call<ActRes>('POST', '/api/act', { action, actionId: crypto.randomUUID(), args, ...(jobId ? { job: jobId } : {}) }, 60000)
/** A takes the item and moves it to Dev; the job is the open one for its key, or a new one already started */
export const startItem = (id: string, pb?: string) =>
  call<{ job: Job; created: boolean }>('POST', `/api/board/${enc(id)}/start`, pb ? { pb } : {}, 60000)
export const ask = (j: string, step: string, q: string) => call<{ run: RunRec }>('POST', '/api/runs', { job: j, step, instruction: q })
export const cancelRun = (id: string) => call<{ run: RunRec }>('POST', `/api/runs/${enc(id)}/cancel`)
export const resumeRun = (id: string) => call<{ run: RunRec }>('POST', `/api/runs/${enc(id)}/resume`)
export const runInfo = (id: string) => call<{ run: RunRec; feed: string[] }>('GET', `/api/runs/${enc(id)}`)
export const sources = (concepts: string[]) =>
  call<{ concepts: Record<string, ConceptState> }>('GET', `/api/sources?concepts=${concepts.map(enc).join(',')}`)
export const chatThread = async (id: string) =>
  (await call<{ item: { messages?: Msg[] } }>('GET', `/api/sources/chat/${enc(id)}`)).item.messages || []
export const mailItem = async (id: string) =>
  (await call<{ item: { body?: string } }>('GET', `/api/sources/mail/${enc(id)}`)).item.body || ''
export const markMail = (id: string, m: { done?: boolean; job?: string }) => call<object>('POST', `/api/mail/${enc(id)}/mark`, m)
/** hiding is the console's own mark in B; the chat tool never sees it */
export const hideChat = (id: string, hidden: boolean, name?: string) => call<object>('POST', `/api/chats/${enc(id)}/hide`, { hidden, ...(name ? { name } : {}) })
export const hiddenChats = async () => (await call<{ hidden: { id: string; name: string }[] }>('GET', '/api/chats/hidden')).hidden
export const putPlaybook = (id: string, pb: Playbook | null) =>
  call<{ playbooks: Record<string, Playbook> }>(pb ? 'PUT' : 'DELETE', `/api/playbooks/${enc(id)}`, pb ? { pb } : undefined)
export const notes = async () => (await call<{ notes: NoteIndex[] }>('GET', '/api/knowledge')).notes
export const searchNotes = async (q: string, tags: string[] = []) =>
  (await call<{ hits: Hit[] }>('GET', `/api/knowledge/search?q=${enc(q)}&tags=${tags.map(enc).join(',')}`)).hits
export const note = async (id: string) => (await call<{ note: Note }>('GET', `/api/knowledge/notes/${enc(id)}`)).note
/** id null = a new note; an edit names the v it replaces */
export const saveNote = async (id: string | null, n: NoteIn, v?: number) =>
  (await call<{ note: Note }>(id ? 'PUT' : 'POST', id ? `/api/knowledge/notes/${enc(id)}` : '/api/knowledge/notes', id ? { ...n, v } : n)).note
export const proposals = async () => (await call<{ proposals: Proposal[] }>('GET', '/api/knowledge/proposals')).proposals
export const decide = async (id: string, accept: boolean, text?: string) =>
  (await call<{ note: Note | null }>('POST', `/api/knowledge/proposals/${enc(id)}/decide`, { accept, ...(text !== undefined ? { text } : {}) })).note
export const pairNew = () => call<{ url: string; qr: string; expires: string }>('POST', '/api/pair/new')
export const devices = () => call<{ devices: Device[] }>('GET', '/api/devices')
export const revoke = (id: string) => call<object>('DELETE', `/api/devices/${enc(id)}`)

/** one EventSource for the page's lifetime; it reconnects by itself, and onOpen runs on every (re)connect */
export function events(on: (e: Ev) => void, onOpen?: () => void) {
  const es = new EventSource(base + '/api/events')
  for (const k of ['job', 'run', 'feed', 'bridge', 'source']) {
    es.addEventListener(k, (m) => { try { on({ ...JSON.parse((m as MessageEvent).data), kind: k }) } catch { /* a broken frame is dropped */ } })
  }
  if (onOpen) es.addEventListener('open', onOpen)
  return () => es.close()
}

export const pushSupported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

/** registers the service worker and subscribes to Web Push. ask = may show the permission prompt,
    which needs a click on phones; without it only an already granted permission subscribes. */
export async function subscribePush(vapid: string | null, ask = false) {
  if (!vapid || !pushSupported()) return false
  try {
    const reg = await navigator.serviceWorker.register('/sw.js')
    if (Notification.permission === 'default' && ask) await Notification.requestPermission()
    if (Notification.permission !== 'granted') return false
    const key = Uint8Array.from(atob(vapid.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
    const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }))
    await call('POST', '/api/push/subscribe', { sub: sub.toJSON() })
    return true
  } catch { return false }
}

export type { Chat, Mail }
