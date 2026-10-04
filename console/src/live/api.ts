import type { CalEvent, Chat, Cmd, Job, Mail, Msg, Playbook, RunRec, Tpl } from '../model/types.ts'
import type { NewJob } from '../model/transitions.ts'
import type { Resolved } from '../model/context.ts'
import type { BoardItem } from '../data/board.ts'
import type { TimeItem } from '../data/time.ts'
import { S } from '../model/world.ts'

/* The page's side of the backend. Without a backend (the published artifact, `vite dev`) detect()
   answers null and the page stays the in-memory demo. */

export type CalItem = CalEvent & { id: string }
/** status ok carries items; anything else (unavailable, signin_required, …) carries a message */
export type ConceptState = { status: string; rev?: string; items?: unknown[]; message?: string }
export type Device = { id: string; name: string; at: string; lastSeen?: string }
export type Part = 'ok' | 'unavailable'
/** one workspace's part of the state, from its own gateway and B */
export interface WsBlock {
  jobs: Job[]; runs: RunRec[]; playbooks: Record<string, Playbook>
  /** planned messages by step id: the core's, the workspace page's and its stored playbooks' */
  templates: Record<string, Tpl[]>
  marks: Record<string, { done?: boolean; job?: string }>
  /** a part B could not give comes back empty and unavailable */
  parts: { jobs: Part; runs: Part; marks: Part }
  bridge: { state: 'ok' | 'unavailable'; concepts: Record<string, string> }
  plugins: Record<string, unknown>
}
export interface State {
  /** the PC's own zone and name */
  home: { tz: string; pc: string }
  side: 'loopback' | 'lan'; device: string | null; push: { key: string } | null
  /** the PC has an OpenAI key, so the mic can be offered */
  voice: boolean
  ws: Record<string, WsBlock>
}
/** every frame names the workspace it came from */
export type Ev =
  | { kind: 'job'; ws: string; job: Job } | { kind: 'run'; ws: string; run: RunRec } | { kind: 'feed'; ws: string; run: string; t: string; tool?: string }
  | { kind: 'bridge'; ws: string; state: 'ok' | 'unavailable'; concepts: Record<string, string> }
  | { kind: 'source'; ws: string; concept: string }
export type ActRes = { actionId: string; status: 'ok' | 'error' | 'outcome_unknown'; error?: { code: string; message: string }; result?: unknown }
/** playbooks: keys of the playbooks whose every run reads the note in full */
export type NoteIndex = { id: string; v: number; title: string; tags: string[]; playbooks: string[]; updated: string; size: number }
export type Note = { id: string; v: number; title: string; tags: string[]; playbooks: string[]; text: string; updated: string }
export type Hit = NoteIndex & { score: number; snippet: string }
export type Proposal = { id: string; note?: string; baseV?: number; title: string; tags: string[]; playbooks: string[]; text: string; reason: string; by: string; at: string }
export type NoteIn = { title: string; tags: string[]; playbooks: string[]; text: string }

export class ApiError extends Error {
  status: number; code: string
  constructor(status: number, code: string, msg: string) { super(msg); this.status = status; this.code = code }
}

/** what the page knows of one workspace: its bridge, its sources and its knowledge */
export interface LiveWs {
  bridge: 'ok' | 'unavailable'; concepts: Record<string, string>
  /** per concept: ok, loading, or why it is unavailable */
  sources: Record<string, string>; cal: CalItem[]; time: TimeItem[]; board: BoardItem[]
  /** knowledge, the workspace's notes folder: the note index, proposals waiting in Approvals, and 'ok', 'loading' or why not */
  notes: NoteIndex[]; proposals: Proposal[]; kn: string
  parts: Record<string, Part>
  /** each plugin's state block, by plugin name */
  plugins: Record<string, unknown>
}
export const blankWs = (): LiveWs => ({
  bridge: 'ok', concepts: {}, sources: {}, cal: [], time: [], board: [],
  notes: [], proposals: [], kn: 'loading', parts: { jobs: 'ok', runs: 'ok' }, plugins: {},
})

/** what the page knows about the backend: on = live mode, pc = opened on the PC itself (pairing, devices) */
export const LIVE = {
  on: false, pc: false, paired: true,
  runs: {} as Record<string, RunRec>, feed: {} as Record<string, string[]>,
  push: null as string | null,
  /** the backend can turn speech into text */
  voice: false,
  /** one block per workspace the backend serves */
  ws: {} as Record<string, LiveWs>,
}

/** the parts of a workspace's state B did not give while its bridge is up: unavailable, not empty */
export function missingParts(ws: string = S.ws) {
  const l = LIVE.ws[ws]
  return l && l.bridge === 'ok' ? ['jobs', 'runs'].filter((k) => l.parts[k] === 'unavailable') : []
}

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

/** a workspace-bound route: /api/ws/<ws><path> */
export const wsCall = <T>(ws: string, method: string, path: string, body?: unknown, timeout?: number) =>
  call<T>(method, `/api/ws/${enc(ws)}${path}`, body, timeout)

/** null = no backend (demo); 'unpaired' = this device has no pairing yet */
export async function detect(): Promise<State | null | 'unpaired'> {
  try {
    const st = await call<State>('GET', '/api/state', undefined, 1500)
    // a dev server answers any path with the page; only the backend's state counts
    return st && st.home && st.ws && typeof st.ws === 'object' ? st : null
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
export const act = (ws: string, action: string, args: Record<string, unknown>, jobId?: string) =>
  wsCall<ActRes>(ws, 'POST', '/act', { action, actionId: crypto.randomUUID(), args, ...(jobId ? { job: jobId } : {}) }, 60000)
/** A takes the item and moves it to the board's dev column; the job is the open one for its key, or a new one already started */
export const startItem = (ws: string, id: string, pb?: string) =>
  wsCall<{ job: Job; created: boolean }>(ws, 'POST', `/board/${enc(id)}/start`, pb ? { pb } : {}, 60000)
export const ask = (j: string, step: string, q: string) => call<{ run: RunRec }>('POST', '/api/runs', { job: j, step, instruction: q })
export const cancelRun = (id: string) => call<{ run: RunRec }>('POST', `/api/runs/${enc(id)}/cancel`)
export const resumeRun = (id: string) => call<{ run: RunRec }>('POST', `/api/runs/${enc(id)}/resume`)
export const runInfo = (id: string) => call<{ run: RunRec; feed: string[] }>('GET', `/api/runs/${enc(id)}`)
export const sources = (ws: string, concepts: string[]) =>
  wsCall<{ concepts: Record<string, ConceptState> }>(ws, 'GET', `/sources?concepts=${concepts.map(enc).join(',')}`)
export const chatThread = async (ws: string, id: string) =>
  (await wsCall<{ item: { messages?: Msg[] } }>(ws, 'GET', `/sources/chat/${enc(id)}`)).item.messages || []
export const mailItem = async (ws: string, id: string) =>
  (await wsCall<{ item: { body?: string } }>(ws, 'GET', `/sources/mail/${enc(id)}`)).item.body || ''
export const markMail = (ws: string, id: string, m: { done?: boolean; job?: string }) => wsCall<object>(ws, 'POST', `/mail/${enc(id)}/mark`, m)
/** hiding is the console's own mark in B; the chat tool never sees it */
export const hideChat = (ws: string, id: string, hidden: boolean, name?: string) =>
  wsCall<object>(ws, 'POST', `/chats/${enc(id)}/hide`, { hidden, ...(name ? { name } : {}) })
export const hiddenChats = async (ws: string) => (await wsCall<{ hidden: { id: string; name: string }[] }>(ws, 'GET', '/chats/hidden')).hidden
/** tpl = the playbook's planned messages by step id, saved with it */
export const putPlaybook = (ws: string, id: string, pb: Playbook | null, tpl?: Record<string, Tpl[]>) =>
  wsCall<{ playbooks: Record<string, Playbook>; templates: Record<string, Tpl[]> }>(ws, pb ? 'PUT' : 'DELETE', `/playbooks/${enc(id)}`, pb ? { pb, ...(tpl ? { tpl } : {}) } : undefined)
export const notes = async (ws: string) => (await wsCall<{ notes: NoteIndex[] }>(ws, 'GET', '/knowledge')).notes
export const searchNotes = async (ws: string, q: string, tags: string[] = []) =>
  (await wsCall<{ hits: Hit[] }>(ws, 'GET', `/knowledge/search?q=${enc(q)}&tags=${tags.map(enc).join(',')}`)).hits
export const note = async (ws: string, id: string) => (await wsCall<{ note: Note }>(ws, 'GET', `/knowledge/notes/${enc(id)}`)).note
/** id null = a new note; an edit names the v it replaces */
export const saveNote = async (ws: string, id: string | null, n: NoteIn, v?: number) =>
  (await wsCall<{ note: Note }>(ws, id ? 'PUT' : 'POST', id ? `/knowledge/notes/${enc(id)}` : '/knowledge/notes', id ? { ...n, v } : n)).note
/** a delete names the v it removes */
export const deleteNote = (ws: string, id: string, v: number) => wsCall<object>(ws, 'DELETE', `/knowledge/notes/${enc(id)}?v=${v}`)
export const proposals = async (ws: string) => (await wsCall<{ proposals: Proposal[] }>(ws, 'GET', '/knowledge/proposals')).proposals
export const decide = async (ws: string, id: string, accept: boolean, text?: string) =>
  (await wsCall<{ note: Note | null }>(ws, 'POST', `/knowledge/proposals/${enc(id)}/decide`, { accept, ...(text !== undefined ? { text } : {}) })).note
/** the words in a recording; audio = base64, mime = the recorder's type */
export const transcribe = async (ws: string, audio: string, mime: string) =>
  (await wsCall<{ text: string }>(ws, 'POST', '/transcribe', { audio, mime }, 130000)).text
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
