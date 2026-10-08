import { CHATS, JOBS, MAIL, PB, S, TPL, byId, putJob, setJobs } from '../model/world.ts'
import type { Chat, Mail, Ws } from '../model/types.ts'
import { DEFAULT_WS, PACKS } from '../data/packs.ts'
import type { BoardItem } from '../data/board.ts'
import { setZone } from '../lib/zone.ts'
import { commit, repaint } from '../store.ts'
import * as api from './api.ts'
import { LIVE, blankWs } from './api.ts'
import type { CalItem, ConceptState, Ev, LiveWs, State } from './api.ts'
import type { TimeItem } from '../data/time.ts'

/* Live mode: the backend's jobs and playbooks replace the demo's, each workspace's sources come
   from its own gateway, and the event stream keeps both current. Every frame names its workspace. */

const CONCEPTS = ['chat', 'mail', 'cal', 'board', 'time']
const KNOWLEDGE = ['notes', 'proposals']

/** a workspace's live block; one the backend does not serve reads as a bridge that is down */
export const L = (ws: Ws = S.ws): LiveWs => LIVE.ws[ws] || { ...blankWs(), bridge: 'unavailable' }

/** null = demo data; 'ok'; 'loading'; or why the concept is unavailable */
export function srcState(concept: string, ws: Ws = S.ws): string | null {
  if (!LIVE.on) return null
  const l = LIVE.ws[ws]
  if (!l) return 'not served by the console backend'
  if (l.bridge !== 'ok') return 'the bridge is unavailable'
  return l.sources[concept] || 'loading'
}

let rereading: ReturnType<typeof setTimeout> | undefined
/** B could not give a part: ask again until it can */
function rereadLater() {
  clearTimeout(rereading)
  rereading = setTimeout(() => void api.state().then((s) => commit(() => applyState(s)), rereadLater), 10000)
}

/** the workspace whose store holds a playbook: the block PB took it from */
const PB_WS: Record<string, Ws> = {}
/** where a playbook is saved or removed; one not loaded yet goes to its own workspace, else the one on screen */
export const pbWs = (k: string): Ws => PB_WS[k] || PB[k]?.ws || S.ws

export function applyState(st: State) {
  // the PC's zone is home; a zone this browser does not know leaves the device's
  try { setZone(st.home.tz) } catch { /* as said */ }
  LIVE.voice = st.voice === true
  // the first build seen is the one this page runs; another one means the server restarted into a new build
  if (st.build) { if (!LIVE.build) LIVE.build = st.build; else if (st.build !== LIVE.build) LIVE.updated = true }
  const blocks = Object.entries(st.ws)
  for (const k of Object.keys(PB)) delete PB[k]
  for (const k of Object.keys(PB_WS)) delete PB_WS[k]
  // a key two blocks carry is the last block's, as in the server's Spaces.ctx(), in PB and PB_WS alike
  for (const [id, b] of blocks) { for (const k of Object.keys(b.playbooks)) PB_WS[k] = id; Object.assign(PB, b.playbooks) }
  // their planned messages come with them: a stored playbook's too
  for (const k of Object.keys(TPL)) delete TPL[k]
  for (const [, b] of blocks) Object.assign(TPL, b.templates)
  // a job event may have landed while the state was on its way: keep whichever copy is newer
  const have = new Map(JOBS.map((j) => [j.id, j]))
  setJobs(blocks.flatMap(([, b]) => b.jobs).map((j) => { const o = have.get(j.id); return o && o.v != null && j.v != null && o.v > j.v ? o : j }))
  LIVE.runs = Object.fromEntries(blocks.flatMap(([, b]) => b.runs).map((r) => [r.id, r]))
  // blocks change in place: a load on its way keeps writing into the block it read
  for (const id of Object.keys(LIVE.ws)) if (!(id in st.ws)) delete LIVE.ws[id]
  for (const [id, b] of blocks) {
    Object.assign((LIVE.ws[id] ||= blankWs()), {
      bridge: b.bridge.state, concepts: b.bridge.concepts, parts: { jobs: b.parts.jobs, runs: b.parts.runs }, plugins: b.plugins || {},
    })
  }
  clearTimeout(rereading)
  if (blocks.some(([, b]) => b.bridge.state === 'ok' && Object.values(b.parts).some((p) => p !== 'ok'))) rereadLater()
}

function applyConcept(ws: Ws, c: string, r: ConceptState | undefined) {
  const l = LIVE.ws[ws]
  if (!l) return
  if (!r || r.status !== 'ok' || !Array.isArray(r.items)) { l.sources[c] = r?.message || r?.status || 'unavailable'; return }
  l.sources[c] = 'ok'
  if (c === 'chat') {
    // a thread already read keeps its messages until it is opened again
    const old = new Map((CHATS[ws] || []).map((x) => [x.id, x]))
    CHATS[ws] = (r.items as Chat[]).map((x) => ({ ...x, msgs: old.get(x.id)?.msgs || [] }))
    forget('chat', ws)
  } else if (c === 'mail') {
    const old = new Map((MAIL[ws] || []).map((x) => [x.id, x]))
    MAIL[ws] = (r.items as Mail[]).map((x) => { const o = old.get(x.id); return { ...x, body: o?.body || x.body, ...(o?.sent ? { sent: o.sent } : {}) } })
  } else if (c === 'cal') l.cal = r.items as CalItem[]
  else if (c === 'board') l.board = r.items as BoardItem[]
  else if (c === 'time') l.time = r.items as TimeItem[]
}

export async function loadSources(ws: Ws, concepts = CONCEPTS) {
  try {
    const { concepts: r } = await api.sources(ws, concepts)
    commit(() => concepts.forEach((c) => applyConcept(ws, c, r[c])))
    // the thread on screen may have new messages
    if (concepts.includes('chat') && S.view === 'chats' && S.ws === ws) loadThread(S.chat[ws], ws)
  } catch (e) {
    commit(() => concepts.forEach((c) => { const l = LIVE.ws[ws]; if (l) l.sources[c] = e instanceof api.ApiError ? e.message : 'unavailable' }))
  }
}

export async function loadKnowledge(ws: Ws = S.ws) {
  try {
    const [n, p] = await Promise.all([api.notes(ws), api.proposals(ws)])
    commit(() => { const l = LIVE.ws[ws]; if (l) { l.notes = n; l.proposals = p; l.kn = 'ok' } })
  } catch (e) {
    commit(() => { const l = LIVE.ws[ws]; if (l) l.kn = e instanceof api.ApiError ? e.message : 'unavailable' })
  }
}

/** every served workspace's sources and knowledge */
function loadAll() { for (const ws of Object.keys(LIVE.ws)) { void loadSources(ws); void loadKnowledge(ws) } }

/* a thread or a mail body is fetched when it is first shown; keys are workspace + id */
const loaded = { chat: new Set<string>(), mail: new Set<string>() }
const lk = (ws: Ws, id: string) => `${ws}\n${id}`
function forget(k: 'chat' | 'mail', ws: Ws) { for (const x of loaded[k]) if (x.startsWith(ws + '\n')) loaded[k].delete(x) }
export function loadThread(id: string, ws: Ws = S.ws) {
  const key = lk(ws, id)
  if (!LIVE.on || srcState('chat', ws) !== 'ok' || loaded.chat.has(key)) return
  loaded.chat.add(key)
  api.chatThread(ws, id).then((msgs) => commit(() => { const c = (CHATS[ws] || []).find((x) => x.id === id); if (c) c.msgs = msgs }))
    .catch(() => { loaded.chat.delete(key) })
}
export function refreshThread(id: string, ws: Ws = S.ws) { loaded.chat.delete(lk(ws, id)); loadThread(id, ws) }
export function loadMailBody(id: string, ws: Ws = S.ws) {
  const key = lk(ws, id)
  if (!LIVE.on || srcState('mail', ws) !== 'ok' || loaded.mail.has(key)) return
  loaded.mail.add(key)
  api.mailItem(ws, id).then((body) => commit(() => { const m = (MAIL[ws] || []).find((x) => x.id === id); if (m) m.body = body || '(no text)' }))
    .catch(() => { loaded.mail.delete(key) })
}

const pending = new Map<string, ReturnType<typeof setTimeout>>()
/** a burst of changes to one thing in one workspace is one reload */
function soon(k: string, f: () => void) {
  clearTimeout(pending.get(k))
  pending.set(k, setTimeout(() => { pending.delete(k); f() }, 400))
}
/** a build's progress lines, by the id the page gave it while it runs */
export const buildFeed = new Map<string, (t: string, tool?: string) => void>()
export function onEvent(e: Ev) {
  if (e.kind === 'build') buildFeed.get(e.id)?.(e.t, e.tool)
  else if (e.kind === 'job') commit(() => { putJob(e.job) })
  else if (e.kind === 'run') commit(() => { LIVE.runs[e.run.id] = e.run })
  else if (e.kind === 'feed') {
    const f = (LIVE.feed[e.run] ||= [])
    f.push(e.tool ? `→ ${e.tool} ${e.t}` : e.t)
    if (f.length > 300) f.splice(0, f.length - 300)
    repaint()
  } else if (e.kind === 'bridge') {
    const l = LIVE.ws[e.ws]
    if (!l) return
    const back = l.bridge !== 'ok' && e.state === 'ok'
    commit(() => { l.bridge = e.state; l.concepts = e.concepts })
    if (back) { void loadSources(e.ws); void api.state().then((s) => commit(() => applyState(s))).catch(() => undefined) }
  } else if (e.kind === 'source' && LIVE.ws[e.ws] && CONCEPTS.includes(e.concept)) {
    soon(`${e.ws}/${e.concept}`, () => void loadSources(e.ws, [e.concept]))
  } else if (e.kind === 'source' && LIVE.ws[e.ws] && KNOWLEDGE.includes(e.concept)) {
    soon(`${e.ws}/knowledge`, () => void loadKnowledge(e.ws))
  }
}

/** a push notification opens /?job=…&step=…, /?view=chats&chat=…, /?view=mail&mail=… or /?view=approvals,
    with ws= naming the workspace; without one (an older link) a job opens in its own and a view in the default */
export function fromQuery(q = location.search) {
  const p = new URLSearchParams(q), jid = p.get('job'), view = p.get('view'), asked = p.get('ws')
  const named = asked && PACKS[asked] ? asked : null, j = jid ? byId(jid) : undefined
  if (j) { S.ws = named || j.ws; S.view = 'job'; S.job = j.id; S.sel = p.get('step') || null }
  else if (view === 'chats') { const ws = (S.ws = named || DEFAULT_WS); S.view = 'chats'; const c = p.get('chat'); if (c) S.chat[ws] = c }
  else if (view === 'mail') { S.ws = named || DEFAULT_WS; S.view = 'mail'; const m = p.get('mail'); if (m) { S.mail = m; S.mcat = 'reply' } }
  else if (view === 'approvals') { S.ws = named || DEFAULT_WS; S.view = 'approvals' }
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
  loadAll()
  let opened = false
  // events between the first state and the stream opening, or during a reconnect, may be missed:
  // take the whole state again on every open
  api.events(onEvent, () => {
    const again = opened
    opened = true
    void api.state().then((s) => { commit(() => applyState(s)); if (again) loadAll() }).catch(() => undefined)
  })
  void api.subscribePush(LIVE.push)
  return 'live'
}
