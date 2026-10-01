import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { DEFAULT_WS, PACKS } from '../../src/data/packs.ts'
import * as T from '../../src/model/transitions.ts'
import { SESSION_OPS } from '../../src/model/types.ts'
import type { Cmd, Job } from '../../src/model/types.ts'
import { HttpError } from '../events.ts'
import type { StartItem } from '../board/start.ts'
import type { Jobs } from '../jobs/jobs.ts'

/* Job tools for the user's own Claude Code sessions: an MCP server (streamable HTTP, JSON replies only)
   on the loopback listener at /mcp, behind a bearer token kept in the console's home. A change goes
   through the same Jobs.cmd as the page's, applies at once, is broadcast to open pages and is signed
   "Claude Code" in the journal. Undo walks back this session's own changes. The console's LLM runs
   never get these tools: they load no user-scope MCP servers and deny this one by name. */

export interface Tool {
  name: string; description: string; inputSchema: Record<string, unknown>
  run(a: Record<string, unknown>, s: Session): Promise<unknown>
}
/** what a session can take back: a command (put prev back if v is still current) or a job it created */
type Undo = { id: string; v: number; prev: Job } | { id: string; created: true }
export interface Session { undo: Undo[] }

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']
const MAX_UNDO = 50

/** creates the token file once; the token is read from it on every request */
export function ensureToken(path: string) {
  if (!existsSync(path)) writeFileSync(path, randomBytes(32).toString('hex') + '\n', { mode: 0o600 })
  return path
}

const clip = (t: string, n = 1500) => (t.length > n ? t.slice(0, n) + ` … (${t.length - n} more characters)` : t)
const fail = (e: unknown) => {
  if (e instanceof HttpError) return `${e.code}: ${e.message}`
  return String((e as Error)?.message || e)
}

export function brief(x: T.Ctx, j: Job) {
  const at = T.atOf(x, j)
  return {
    id: j.id, key: j.key, title: j.t, status: j.st, playbook: j.pb, project: j.prj, round: (j.rounds?.length || 0) + 1,
    step: at ? T.stepOf(x, j, at)!.t : null, needsYou: T.needsYou(x, j),
  }
}

export function detail(x: T.Ctx, j: Job) {
  const at = T.atOf(x, j)
  return {
    ...brief(x, j), v: j.v, current: at, roundFrom: j.rf ?? null, chat: j.chat, mail: j.mail,
    phases: (x.PB[j.pb]?.ph || []).map((p) => ({
      phase: `${p.c} ${p.n}`,
      steps: p.s.map((s) => {
        const f = j.flow[s.id]
        return {
          id: s.id, title: s.t, who: s.m, state: f.s, doneWhen: s.x, meta: f.m || undefined,
          notes: f.b.length ? f.b.map((b, i) => ({ i, kind: b.k, text: b.t, open: !!b.o, answer: b.r || undefined })) : undefined,
          draft: f.dr ? clip(f.dr.t) : undefined, output: f.out ? clip(f.out) : undefined, running: f.run ? true : undefined,
          artifacts: f.arts.length ? f.arts.map((a) => a.n + (a.ok ? '' : ' (planned)')) : undefined,
          plannedMessages: (x.TPL[s.id] || []).length ? (x.TPL[s.id] || []).map((_, i) => (f.sent[i] ? `${i}: sent` : `${i}: not sent`)) : undefined,
        }
      }),
    })),
    rounds: j.rounds?.length ? j.rounds.map((r) => ({ n: r.n, from: r.from, ended: r.at, by: r.by, why: r.why })) : undefined,
    journal: j.jr.slice(0, 10).map((e) => `${e.ts} ${e.a}: ${e.o} ${e.c} Next: ${e.n}`),
  }
}

/** a step named by id or, failing that, by its title */
function stepId(x: T.Ctx, j: Job, s: unknown) {
  if (typeof s !== 'string' || j.flow[s]) return s
  const hit = T.steps(x, j.pb).find((st) => st.t.toLowerCase() === s.trim().toLowerCase())
  return hit ? hit.id : s
}

const str = (v: unknown, what: string) => {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, 'bad_args', `${what} is missing`)
  return v.trim()
}

export function jobTools(d: { jobs: Jobs; ctx: () => T.Ctx; start?: StartItem }): Tool[] {
  const get = async (id: unknown) => {
    const j = await d.jobs.get(str(id, 'id'))
    if (!j) throw new HttpError(404, 'not_found', `no job ${id}`)
    return j
  }
  const command = async (s: Session, id: unknown, c: Record<string, unknown>) => {
    const x = d.ctx(), j = await get(id)
    if ('step' in c) c.step = stepId(x, j, c.step)
    const r = await d.jobs.cmd(j.id, c as unknown as Cmd, undefined, 'session')
    s.undo.push({ id: j.id, v: r.job.v!, prev: r.prev }); s.undo.splice(0, s.undo.length - MAX_UNDO)
    const e = r.job.jr[0]
    return { job: brief(x, r.job), journal: `${e.o} ${e.c} Next: ${e.n}` }
  }
  return [
    {
      name: 'list_jobs', description: 'List Work Console jobs: id, key, title, status, current step, round, whether it needs the user.',
      inputSchema: { type: 'object', properties: { filter: { type: 'string', enum: ['open', 'needs_you', 'closed', 'all'], description: 'default open' } } },
      async run(a) {
        const x = d.ctx(), f = a.filter || 'open'
        const js = (await d.jobs.all()).filter((j) => f === 'all' || (f === 'closed' ? T.isClosed(j) : f === 'needs_you' ? T.needsYou(x, j) : !T.isClosed(j)))
        return js.sort((a, b) => b.ts - a.ts).map((j) => brief(x, j))
      },
    },
    {
      name: 'get_job', description: 'One job in full: every step with its state, notes, draft, output, artifacts and planned messages; past rounds; the last 10 journal entries.',
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'job id, e.g. J-0412' } }, required: ['id'] },
      async run(a) { return detail(d.ctx(), await get(a.id)) },
    },
    {
      name: 'job_command',
      description: 'Apply one job command, exactly as the console page would. It applies at once, shows live in the console and is journaled as Claude Code. '
        + 'Args per op: start; close {st: done|cancelled, note?}; reopen; stepDone|stepSkip|stepResume|stepReopen|rejectDraft {step}; stepWait {step, m: what it waits for}; '
        + 'acceptDraft {step, text?: edited text}; noteAdd {step, k: q question|c contradiction|d design note|p problem, t}; noteAnswer {step, i, r}; noteReopen {step, i}; '
        + 'sent {step, i: planned message index, t: the text you sent, to: channel} (record only, send it yourself first); vote {step, n: reviewer, v}; '
        + 'nudged {to}; replied {subj}; returnTo {step, why}. A step is its id or exact title.',
      inputSchema: {
        type: 'object', required: ['id', 'op'],
        properties: {
          id: { type: 'string' }, op: { type: 'string', enum: [...SESSION_OPS] }, step: { type: 'string' }, why: { type: 'string' }, m: { type: 'string' },
          text: { type: 'string' }, k: { type: 'string', enum: ['q', 'c', 'd', 'p'] }, t: { type: 'string' }, i: { type: 'integer' }, r: { type: 'string' },
          n: { type: 'string' }, v: { type: 'integer' }, st: { type: 'string', enum: ['done', 'cancelled'] }, note: { type: 'string' }, to: { type: 'string' }, subj: { type: 'string' },
        },
      },
      async run(a, s) { const { id, ...c } = a; return command(s, id, c) },
    },
    {
      name: 'return_to',
      description: 'Send a job back to a step it has passed (also a closed job): the pass so far is kept as a round, the steps from that one on start again. Refused while an LLM run is in flight.',
      inputSchema: { type: 'object', required: ['id', 'step', 'why'], properties: { id: { type: 'string' }, step: { type: 'string', description: 'step id or exact title' }, why: { type: 'string' } } },
      async run(a, s) { return command(s, a.id, { op: 'returnTo', step: a.step, why: a.why }) },
    },
    {
      name: 'create_job', description: 'Create a job from a playbook (see list_playbooks). It starts as ready; start it with job_command op start.',
      inputSchema: {
        type: 'object', required: ['title', 'playbook'],
        properties: {
          title: { type: 'string' }, playbook: { type: 'string', description: 'playbook id' }, key: { type: 'string', description: 'work item or ticket key, e.g. ACME-512' },
          project: { type: 'string', description: `one of ${PACKS[DEFAULT_WS].prj.join(', ')}; default ${PACKS[DEFAULT_WS].prj[0]}` }, chat: { type: 'string', description: 'chat id to link' }, mail: { type: 'string', description: 'mail id to link' },
        },
      },
      async run(a, s) {
        const j = await d.jobs.create({
          t: str(a.title, 'title'), pb: str(a.playbook, 'playbook'), key: typeof a.key === 'string' && a.key.trim() ? a.key.trim() : 'NEW',
          prj: typeof a.project === 'string' && a.project ? a.project : PACKS[DEFAULT_WS].prj[0], ws: DEFAULT_WS,
          ...(typeof a.chat === 'string' ? { chat: a.chat } : {}), ...(typeof a.mail === 'string' ? { mail: a.mail } : {}),
        }, 'session')
        s.undo.push({ id: j.id, created: true })
        return brief(d.ctx(), j)
      },
    },
    ...(d.start ? [{
      name: 'start_item',
      description: 'Start a board item: in the tracker assign it to the user and move it from Ready to Dev, then create and start its job, or return the job if one is open. '
        + 'Undo cancels a job this created; the tracker change stays.',
      inputSchema: {
        type: 'object', required: ['key'],
        properties: { key: { type: 'string', description: 'work item key, e.g. ACME-603' }, playbook: { type: 'string', description: 'playbook id; default dev-item' } },
      },
      async run(a: Record<string, unknown>, s: Session) {
        const r = await d.start!(str(a.key, 'key'), typeof a.playbook === 'string' && a.playbook.trim() ? a.playbook.trim() : undefined, 'session')
        if (r.created) { s.undo.push({ id: r.job.id, created: true }); s.undo.splice(0, s.undo.length - MAX_UNDO) }
        return { ...brief(d.ctx(), r.job), created: r.created }
      },
    }] : []),
    {
      name: 'undo', description: "Take back this session's last change. A command is undone only if the job has not changed since; a job this session created is cancelled.",
      inputSchema: { type: 'object', properties: {} },
      async run(_, s) {
        const u = s.undo.pop()
        if (!u) throw new HttpError(400, 'bad_state', 'nothing to undo in this session')
        const x = d.ctx()
        if ('created' in u) {
          const r = await d.jobs.cmd(u.id, { op: 'close', st: 'cancelled', note: 'created by mistake; undone' }, undefined, 'session')
          return { undone: `created ${u.id}`, job: brief(x, r.job) }
        }
        return { undone: `last change to ${u.id}`, job: brief(x, await d.jobs.undo(u.id, u.v, u.prev)) }
      },
    },
    {
      name: 'list_playbooks', description: 'Playbooks a job can follow, with their phases and step ids.',
      inputSchema: { type: 'object', properties: {} },
      async run() {
        const PB = d.ctx().PB
        return Object.entries(PB).map(([id, p]) => ({ id, name: p.n, about: p.d, phases: p.ph.map((h) => `${h.c} ${h.n}: ${h.s.map((s) => `${s.id} ${s.t}`).join('; ')}`) }))
      },
    },
  ]
}

function readJson(req: IncomingMessage, limit = 1 << 20): Promise<unknown> {
  return new Promise((ok, no) => {
    const parts: Buffer[] = []; let n = 0
    req.on('data', (c: Buffer) => { n += c.length; if (n > limit) { no(new Error('too large')); req.destroy() } else parts.push(c) })
    req.on('end', () => { try { ok(JSON.parse(Buffer.concat(parts).toString('utf8'))) } catch (e) { no(e) } })
    req.on('error', no)
  })
}

const tokenOk = (req: IncomingMessage, want: string) => {
  const got = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1]?.trim() || ''
  const a = Buffer.from(got), b = Buffer.from(want)
  return want.length > 0 && a.length === b.length && timingSafeEqual(a, b)
}

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }

export function mcpHandler(o: { tools: Tool[]; token: () => string; version?: string }) {
  const sessions = new Map<string, Session & { seen: number }>()
  const byName = new Map(o.tools.map((t) => [t.name, t]))
  const session = (id: string) => {
    let s = sessions.get(id)
    if (!s) {
      for (const [k, v] of sessions) if (Date.now() - v.seen > 7 * 86400e3) sessions.delete(k)
      s = { undo: [], seen: 0 }; sessions.set(id, s)
    }
    s.seen = Date.now()
    return s
  }
  const out = (res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'cache-control': 'no-store', ...(body === undefined ? {} : { 'content-type': 'application/json; charset=utf-8' }), ...headers })
    res.end(body === undefined ? undefined : JSON.stringify(body))
  }

  async function one(m: Rpc, sid: string, made: { sid?: string }): Promise<unknown | undefined> {
    const reply = (result: unknown) => ({ jsonrpc: '2.0', id: m?.id ?? null, result })
    const error = (code: number, message: string) => ({ jsonrpc: '2.0', id: m?.id ?? null, error: { code, message } })
    if (!m || typeof m !== 'object' || typeof m.method !== 'string') return error(-32600, 'not a JSON-RPC request')
    if (m.id === undefined) return undefined
    switch (m.method) {
      case 'initialize': {
        const asked = String(m.params?.protocolVersion || '')
        made.sid = randomUUID(); session(made.sid)
        return reply({
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0], capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'work-console', version: o.version || '1.0.0' },
          instructions: 'Work Console jobs. Read a job with get_job before changing it. Every change applies at once, shows live in the console and is journaled as Claude Code; undo takes back this session\'s last change.',
        })
      }
      case 'ping': return reply({})
      case 'tools/list': return reply({ tools: o.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
      case 'tools/call': {
        const t = byName.get(String(m.params?.name))
        if (!t) return error(-32602, `no tool ${m.params?.name}`)
        try {
          const r = await t.run((m.params?.arguments as Record<string, unknown>) || {}, session(sid))
          return reply({ content: [{ type: 'text', text: JSON.stringify(r, null, 1) }] })
        } catch (e) {
          if (!(e instanceof HttpError)) console.error('mcp tool failed', t.name, e)
          return reply({ content: [{ type: 'text', text: fail(e) }], isError: true })
        }
      }
      default: return error(-32601, `no method ${m.method}`)
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (!tokenOk(req, o.token())) return out(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'missing or wrong bearer token (the console keeps it in mcp.token in its home)' } })
    const sid = String(req.headers['mcp-session-id'] || '')
    if (req.method === 'DELETE') { sessions.delete(sid); return out(res, 200) }
    if (req.method !== 'POST') return out(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'POST only; this server sends no event stream' } }, { allow: 'POST, DELETE' })
    let body: unknown
    try { body = await readJson(req) } catch { return out(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'the body is not JSON' } }) }
    const made: { sid?: string } = {}
    const batch = Array.isArray(body), msgs = (batch ? body : [body]) as Rpc[]
    const replies = (await Promise.all(msgs.map((m) => one(m, sid, made)))).filter((r) => r !== undefined)
    const headers: Record<string, string> = made.sid ? { 'mcp-session-id': made.sid } : {}
    if (!replies.length) return out(res, 202, undefined, headers)
    out(res, 200, batch ? replies : replies[0], headers)
  }
  return (req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch((e) => {
      console.error('mcp request failed', e)
      if (!res.headersSent) out(res, 500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'the console hit an error; see its log' } })
    })
  }
}
