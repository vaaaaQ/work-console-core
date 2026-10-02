import { CHATS, JOBS, MAIL, PB, S, byId, putJob, setJobs } from '../model/world.ts'
import type { Chat, Mail, Ws } from '../model/types.ts'
import { DEFAULT_WS } from '../data/packs.ts'
import type { BoardItem } from '../data/board.ts'
import { commit, repaint } from '../store.ts'
import * as api from './api.ts'
import { LIVE } from './api.ts'
import type { CalItem, ConceptState, Ev, State } from './api.ts'
import type { TimeItem } from '../data/time.ts'

/* Live mode: the backend's jobs and playbooks replace the demo's, the sources come from bridge A,
   and the event stream keeps both current. The gateway serves one pack, the default
   workspace's; other packs show their sources as not connected. */

/** the workspace the gateway serves; read on use, since install() sets DEFAULT_WS after this module loads */
const liveWs = (): Ws => DEFAULT_WS
const CONCEPTS = ['chat', 'mail', 'cal', 'board', 'time']
const KNOWLEDGE = ['notes', 'proposals']

/** null = demo data; 'ok'; 'loading'; or why the concept is unavailable */
export function srcState(concept: string): string | null {
  if (!LIVE.on) return null
  if (S.ws !== liveWs()) return 'not connected in this version'
  if (LIVE.bridge !== 'ok') return 'the bridge is unavailable'
  return LIVE.sources[concept] || 'loading'
}

let rereading: ReturnType<typeof setTimeout> | undefined
/** B could not give a part: ask again until it can */
function rereadLater() {
  clearTimeout(rereading)
  rereading = setTimeout(() => void api.state().then((s) => commit(() => applyState(s)), rereadLater), 10000)
}

export function applyState(st: State) {
  for (const k of Object.keys(PB)) delete PB[k]
  Object.assign(PB, st.playbooks)
  // a job event may have landed while the state was on its way: keep whichever copy is newer
  const have = new Map(JOBS.map((j) => [j.id, j]))
  setJobs(st.jobs.map((j) => { const o = have.get(j.id); return o && o.v != null && j.v != null && o.v > j.v ? o : j }))
  LIVE.runs = Object.fromEntries(st.runs.map((r) => [r.id, r]))
  LIVE.bridge = st.bridge.state; LIVE.concepts = st.bridge.concepts
  LIVE.parts = { jobs: st.parts.jobs, runs: st.parts.runs }
  clearTimeout(rereading)
  if (st.bridge.state === 'ok' && Object.values(st.parts).some((p) => p !== 'ok')) rereadLater()
}

function applyConcept(c: string, r: ConceptState | undefined) {
  if (!r || r.status !== 'ok' || !Array.isArray(r.items)) { LIVE.sources[c] = r?.message || r?.status || 'unavailable'; return }
  LIVE.sources[c] = 'ok'
  if (c === 'chat') {
    // a thread already read keeps its messages until it is opened again
    const old = new Map((CHATS[liveWs()] || []).map((x) => [x.id, x]))
    CHATS[liveWs()] = (r.items as Chat[]).map((x) => ({ ...x, msgs: old.get(x.id)?.msgs || [] }))
    loaded.chat.clear()
  } else if (c === 'mail') {
    const old = new Map((MAIL[liveWs()] || []).map((x) => [x.id, x]))
    MAIL[liveWs()] = (r.items as Mail[]).map((x) => { const o = old.get(x.id); return { ...x, body: o?.body || x.body, ...(o?.sent ? { sent: o.sent } : {}) } })
  } else if (c === 'cal') LIVE.cal = r.items as CalItem[]
  else if (c === 'board') LIVE.board = r.items as BoardItem[]
  else if (c === 'time') LIVE.time = r.items as TimeItem[]
}

export async function loadSources(concepts = CONCEPTS) {
  try {
    const { concepts: r } = await api.sources(concepts)
    commit(() => concepts.forEach((c) => applyConcept(c, r[c])))
    // the thread on screen may have new messages
    if (concepts.includes('chat') && S.view === 'chats' && S.ws === liveWs()) loadThread(S.chat[liveWs()])
  } catch (e) {
    commit(() => concepts.forEach((c) => { LIVE.sources[c] = e instanceof api.ApiError ? e.message : 'unavailable' }))
  }
}

export async function loadKnowledge() {
  try {
    const [n, p] = await Promise.all([api.notes(), api.proposals()])
    commit(() => { LIVE.notes = n; LIVE.proposals = p; LIVE.kn = 'ok' })
  } catch (e) {
    commit(() => { LIVE.kn = e instanceof api.ApiError ? e.message : 'unavailable' })
  }
}

/* a thread or a mail body is fetched when it is first shown */
const loaded = { chat: new Set<string>(), mail: new Set<string>() }
export function loadThread(id: string) {
  if (!LIVE.on || srcState('chat') !== 'ok' || loaded.chat.has(id)) return
  loaded.chat.add(id)
  api.chatThread(id).then((msgs) => commit(() => { const c = (CHATS[liveWs()] || []).find((x) => x.id === id); if (c) c.msgs = msgs }))
    .catch(() => { loaded.chat.delete(id) })
}
export function refreshThread(id: string) { loaded.chat.delete(id); loadThread(id) }
export function loadMailBody(id: string) {
  if (!LIVE.on || srcState('mail') !== 'ok' || loaded.mail.has(id)) return
  loaded.mail.add(id)
  api.mailItem(id).then((body) => commit(() => { const m = (MAIL[liveWs()] || []).find((x) => x.id === id); if (m) m.body = body || '(no text)' }))
    .catch(() => { loaded.mail.delete(id) })
}

const pending = new Map<string, ReturnType<typeof setTimeout>>()
export function onEvent(e: Ev) {
  if (e.kind === 'job') commit(() => { putJob(e.job) })
  else if (e.kind === 'run') commit(() => { LIVE.runs[e.run.id] = e.run })
  else if (e.kind === 'feed') {
    const f = (LIVE.feed[e.run] ||= [])
    f.push(e.tool ? `→ ${e.tool} ${e.t}` : e.t)
    if (f.length > 300) f.splice(0, f.length - 300)
    repaint()
  } else if (e.kind === 'bridge') {
    const back = LIVE.bridge !== 'ok' && e.state === 'ok'
    commit(() => { LIVE.bridge = e.state; LIVE.concepts = e.concepts })
    if (back) { void loadSources(); void loadKnowledge(); void api.state().then((s) => commit(() => applyState(s))).catch(() => undefined) }
  } else if (e.kind === 'source' && CONCEPTS.includes(e.concept)) {
    // a burst of changes to one concept is one reload
    clearTimeout(pending.get(e.concept))
    pending.set(e.concept, setTimeout(() => { pending.delete(e.concept); void loadSources([e.concept]) }, 400))
  } else if (e.kind === 'source' && KNOWLEDGE.includes(e.concept)) {
    clearTimeout(pending.get('knowledge'))
    pending.set('knowledge', setTimeout(() => { pending.delete('knowledge'); void loadKnowledge() }, 400))
  }
}

/** a push notification opens /?job=…&step=… or /?view=chats&chat=… or /?view=mail&mail=… */
export function fromQuery(q = location.search) {
  const p = new URLSearchParams(q), jid = p.get('job'), view = p.get('view')
  if (jid && byId(jid)) { const j = byId(jid)!; S.ws = j.ws; S.view = 'job'; S.job = j.id; S.sel = p.get('step') || null }
  else if (view === 'chats') { S.ws = liveWs(); S.view = 'chats'; const c = p.get('chat'); if (c) S.chat[liveWs()] = c }
  else if (view === 'mail') { S.ws = liveWs(); S.view = 'mail'; const m = p.get('mail'); if (m) { S.mail = m; S.mcat = 'reply' } }
  else if (view === 'approvals') { S.ws = liveWs(); S.view = 'approvals' }
  else return false
  try { history.replaceState(null, '', location.pathname + (S.view === 'job' ? '#' + S.job : '#' + S.view)) } catch { /* as in setHash */ }
  return true
}

function addManifest() {
  if (document.querySelector('link[rel=manifest]')) return
  const l = document.createElement('link'); l.rel = 'manifest'; l.href = '/manifest.webmanifest'
  document.head.appendChild(l)
}

/** decides the mode before the first render: demo, live, or the pairing screen */
export async function boot(): Promise<'demo' | 'live' | 'unpaired'> {
  const st = await api.detect()
  if (st === null) return 'demo'
  LIVE.on = true
  if (st === 'unpaired') { LIVE.paired = false; return 'unpaired' }
  LIVE.pc = st.side === 'loopback'; LIVE.push = st.push?.key ?? null
  applyState(st)
  addManifest()
  void loadSources(); void loadKnowledge()
  let opened = false
  // events between the first state and the stream opening, or during a reconnect, may be missed:
  // take the whole state again on every open
  api.events(onEvent, () => {
    const again = opened
    opened = true
    void api.state().then((s) => { commit(() => applyState(s)); if (again) { void loadSources(); void loadKnowledge() } }).catch(() => undefined)
  })
  void api.subscribePush(LIVE.push)
  return 'live'
}
