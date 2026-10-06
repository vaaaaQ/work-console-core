import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { columns } from '../../src/data/board.ts'
import { KINDS, ctxOf, parseWorkId } from '../../src/model/context.ts'
import { holdsOf } from '../../src/model/blockers.ts'
import { thread } from '../../src/model/thread.ts'
import * as T from '../../src/model/transitions.ts'
import { INTENTS, SESSION_OPS } from '../../src/model/types.ts'
import type { Cmd, Job, RunIntent, RunRec } from '../../src/model/types.ts'
import { GatewayError } from '../bridge/wire.ts'
import { HttpError } from '../events.ts'
import { safeName } from '../llm/runner.ts'
import type { Space, Spaces } from '../spaces.ts'

/* Job tools for the user's own sessions (Claude Code, Cursor, …): an MCP server (streamable HTTP, JSON replies only)
   on the loopback listener at /mcp, behind a bearer token kept in the console's home. A change goes
   through the same Jobs.cmd as the page's, applies at once, is broadcast to open pages and is signed
   in the journal with the client's own name (Claude Code when it gives none). A step taken up by hand
   reads its context with step_context and hands its draft in with submit_draft. Undo walks back this session's own changes. The console's LLM runs
   never get these tools: they load no user-scope MCP servers and deny this one by name.
   One server for every workspace: a job id names its workspace by its prefix, and create_job,
   start_item and the knowledge tools take a ws (optional while only one is registered).
   Knowledge is read here and only proposed: a proposal waits for the user in Approvals. */

/** raw = run returns the MCP content itself (pictures), not a value to send as JSON text */
export interface Tool {
  name: string; description: string; inputSchema: Record<string, unknown>; raw?: true
  run(a: Record<string, unknown>, s: Session): Promise<unknown>
}
/** what a session can take back: a command (put prev back if v is still current) or a job it created */
type Undo = { id: string; v: number; prev: Job } | { id: string; created: true }
/** client = the MCP client's name from initialize, which signs the session's changes */
export interface Session { undo: Undo[]; client?: string }

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']
const MAX_UNDO = 50
/** a hand-made draft's files: how many, and how big each */
const ARTS_MAX = 10, ART_MAX = 5 << 20

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

/** ws = the workspace that owns the job */
export function brief(x: T.Ctx, j: Job, ws: string) {
  const at = T.atOf(x, j)
  return {
    id: j.id, ws, key: j.key, title: j.t, status: j.st, playbook: j.pb, project: j.prj, round: (j.rounds?.length || 0) + 1,
    step: at ? T.stepOf(x, j, at)!.t : null, needsYou: T.needsYou(x, j),
  }
}

/** runs = the space's, for each step's conversation: there only once a reply has been made */
export function detail(x: T.Ctx, j: Job, ws: string, runs: RunRec[] = [], all: Job[] = []) {
  const at = T.atOf(x, j)
  return {
    ...brief(x, j, ws), v: j.v, current: at, roundFrom: j.rf ?? null, chat: j.chat, mail: j.mail, description: j.d,
    context: ctxOf(j).map((c) => ({ kind: c.k, item: c.id, count: c.n, name: c.name })),
    phases: (x.PB[j.pb]?.ph || []).map((p) => ({
      phase: `${p.c} ${p.n}`,
      steps: p.s.map((s) => {
        const f = j.flow[s.id], talk = thread(runs, j.id, s.id)
        return {
          id: s.id, title: s.t, who: s.m, state: f.s, doneWhen: s.x, meta: f.m || undefined,
          notes: f.b.length ? f.b.map((b, i) => ({ i, kind: b.k, text: b.t, open: !!b.o, answer: b.r || undefined })) : undefined,
          draft: f.dr ? clip(f.dr.t) : undefined, output: f.out ? clip(f.out) : undefined, running: f.run ? true : undefined,
          waitsFor: f.w?.length ? f.w.map((l) => ({ job: l.j, title: all.find((o) => o.id === l.j)?.t ?? l.t, state: l.st, plan: l.plan, outcome: l.out ? clip(l.out) : undefined })) : undefined,
          blockerAsked: f.bb?.say,
          conversation: talk.some((r) => r.parent) ? talk.map((r) => ({ q: clip(r.q), intent: r.intent, state: r.state, a: r.a ? clip(r.a) : undefined })) : undefined,
          artifacts: f.arts.length ? f.arts.map((a) => a.n + (a.ok ? '' : ' (planned)')) : undefined,
          plannedMessages: (x.TPL[s.id] || []).length ? (x.TPL[s.id] || []).map((_, i) => (f.sent[i] ? `${i}: sent` : `${i}: not sent`)) : undefined,
        }
      }),
    })),
    holds: (() => { const h = holdsOf(all, j.id); return h.length ? h.map((r) => ({ job: r.job.id, title: r.job.t, step: r.step })) : undefined })(),
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
/** a list of strings, or undefined when the argument is not a list */
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined)

export function jobTools(d: { spaces: Spaces }): Tool[] {
  const { spaces } = d, ids = spaces.list.map((s) => s.id)
  /** a per-workspace default for a description: the value alone when there is one workspace */
  const perWs = (f: (s: Space) => string) => (spaces.list.length === 1 ? f(spaces.list[0]) : spaces.list.map((s) => `${s.id}: ${f(s)}`).join('; '))
  const wsArg = { type: 'string', enum: ids, description: 'workspace; may be omitted when one workspace is registered' }
  /** the job and the space that owns it, by the prefix of its id */
  const get = async (id: unknown) => {
    const key = str(id, 'id'), sp = spaces.byJob(key), j = await sp.jobs.get(key)
    if (!j) throw new HttpError(404, 'not_found', `no job ${key}`)
    return { sp, j }
  }
  const command = async (s: Session, id: unknown, c: Record<string, unknown>) => {
    const { sp, j } = await get(id), x = sp.ctx()
    if ('step' in c) c.step = stepId(x, j, c.step)
    const r = await sp.jobs.cmd(j.id, c as unknown as Cmd, undefined, 'session', undefined, s.client)
    s.undo.push({ id: j.id, v: r.job.v!, prev: r.prev }); s.undo.splice(0, s.undo.length - MAX_UNDO)
    const e = r.job.jr[0], redo = await sp.runner.redoRejected(r.prev, c as unknown as Cmd, 'session', s.client)
    return { job: brief(x, r.job, sp.id), journal: `${e.o} ${e.c} Next: ${e.n}`, ...(redo.run ? { run: redo.run.id } : {}), ...(redo.redo ? { redo: redo.redo } : {}) }
  }
  return [
    {
      name: 'list_jobs', description: 'List Work Console jobs of every workspace: id, workspace, key, title, status, current step, round, whether it needs the user. '
        + 'A workspace that cannot answer appears as a { ws, unavailable } entry, not as having no jobs.',
      inputSchema: { type: 'object', properties: { filter: { type: 'string', enum: ['open', 'needs_you', 'closed', 'all'], description: 'default open' } } },
      async run(a) {
        const f = a.filter || 'open'
        const per = await Promise.all(spaces.list.map(async (sp) => {
          const x = sp.ctx()
          try {
            const js = (await sp.jobs.all()).filter((j) => f === 'all' || (f === 'closed' ? T.isClosed(j) : f === 'needs_you' ? T.needsYou(x, j) : !T.isClosed(j)))
            return { sp, x, js }
          } catch (e) { if (e instanceof GatewayError) return { sp, err: e }; throw e }
        }))
        // one workspace's gateway being away is no reason to hide the others; its absence is named, never read as "no jobs"
        const bad = per.flatMap((p) => (p.err ? [{ ws: p.sp.id, unavailable: p.err.message }] : []))
        if (bad.length === per.length) throw per[0].err
        const rows = per.flatMap((p) => (p.js ? p.js.map((j) => ({ j, b: brief(p.x!, j, p.sp.id) })) : []))
        return [...rows.sort((a, b) => b.j.ts - a.j.ts).map((r) => r.b), ...bad]
      },
    },
    {
      name: 'get_job', description: 'One job in full: every step with its state, notes, draft, output, artifacts and planned messages, and the replies to its draft once there are any; '
        + 'waitsFor (the blockers of a step: job, title, state open|done|cancelled, plan, outcome once closed), blockerAsked (a blocker the user asked for, not yet linked) and holds (the steps of other jobs that wait for this one), past rounds; the last 10 journal entries.',
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'job id, e.g. J-0412' } }, required: ['id'] },
      async run(a) { const { sp, j } = await get(a.id); return detail(sp.ctx(), j, sp.id, await sp.runner.all(), await sp.jobs.all()) },
    },
    {
      name: 'job_command',
      description: 'Apply one job command, exactly as the console page would. It applies at once, shows live in the console and is journaled as Claude Code. '
        + 'Args per op: start; close {st: done|cancelled, note?}; reopen; stepDone|stepSkip|stepResume|stepReopen {step}; rejectDraft {step, why?: the reason; with one the step is redone in a fresh LLM session}; stepWait {step, m: what it waits for}; '
        + 'acceptDraft {step, text?: edited text}; noteAdd {step, k: q question|c contradiction|d design note|p problem, t}; noteAnswer {step, i, r}; noteReopen {step, i}; '
        + 'sent {step, i: planned message index, t: the text you sent, to: channel} (record only, send it yourself first); vote {step, n: reviewer, v}; '
        + 'nudged {to}; replied {subj}; returnTo {step, why}; describe {d: the description, Markdown in English, the user\'s part of every LLM run; empty removes it}. '
        + 'waitAdd {step, j: an open job of the same workspace the step waits for, plan?: what the step does with its outcome; another workspace or a cycle is refused bad_args, a closed job bad_state}; waitDel {step, j}; blockerDrop {step}; '
        + 'stepDone and acceptDraft take force: true to finish a step whose blockers are still open (the open links are dropped). '
        + 'A step is its id or exact title.',
      inputSchema: {
        type: 'object', required: ['id', 'op'],
        properties: {
          id: { type: 'string' }, op: { type: 'string', enum: SESSION_OPS.filter((o) => !o.startsWith('ctx')) }, step: { type: 'string' }, why: { type: 'string' }, m: { type: 'string' },
          text: { type: 'string' }, k: { type: 'string', enum: ['q', 'c', 'd', 'p'] }, t: { type: 'string' }, i: { type: 'integer' }, r: { type: 'string' },
          n: { type: 'string' }, v: { type: 'integer' }, st: { type: 'string', enum: ['done', 'cancelled'] }, note: { type: 'string' }, to: { type: 'string' }, subj: { type: 'string' },
          d: { type: 'string' }, j: { type: 'string' }, plan: { type: 'string' }, force: { type: 'boolean' },
        },
      },
      async run(a, s) { const { id, ...c } = a; return command(s, id, c) },
    },
    {
      name: 'draft_reply',
      description: "Reply to a step's LLM draft in the draft's own session, as the console page does. intent: revise (change it; it waits for review again), "
        + 'accept (change it if asked, then it is accepted), ask (a question; the answer comes back as text and the draft stays). '
        + 'wait (seconds, at most 50) waits for the run to end and returns its answer or the new draft; without it, the run id. Journaled under your client\'s name.',
      inputSchema: {
        type: 'object', required: ['id', 'step', 'text', 'intent'],
        properties: { id: { type: 'string' }, step: { type: 'string' }, text: { type: 'string' }, intent: { type: 'string', enum: [...INTENTS] }, wait: { type: 'integer', minimum: 0, maximum: 50 } },
      },
      async run(a, s) {
        const { sp, j } = await get(a.id), step = stepId(sp.ctx(), j, a.step) as string
        const r = await sp.runner.reply(j.id, step, str(a.text, 'text'), a.intent as RunIntent, { via: 'session', name: s.client })
        const w = Math.min(50, Math.max(0, Number(a.wait) || 0))
        if (!w) return { run: r.id, state: r.state }
        const e = await sp.runner.settle(r.id, w * 1000), f = (await sp.jobs.get(j.id))?.flow[step]
        return {
          run: e.id, state: e.ended ? e.state : 'running', answer: e.a, reason: e.reason,
          draft: f?.dr ? clip(f.dr.t) : undefined, accepted: e.intent === 'accept' && !f?.dr && f?.s === 'done' ? true : undefined,
        }
      },
    },
    {
      name: 'step_context',
      description: "What an LLM run of the step would be told, for a step taken up by hand: the pictures its context names, the job and its step, its context items, "
        + 'its knowledge notes, earlier outputs, the journal, how to work, the description and the step\'s instruction. Read it first, do the step, then hand the result in with submit_draft.',
      inputSchema: { type: 'object', required: ['id', 'step'], properties: { id: { type: 'string' }, step: { type: 'string', description: 'step id or exact title' } } },
      raw: true,
      async run(a) {
        const { sp, j } = await get(a.id), step = stepId(sp.ctx(), j, a.step) as string
        const c = await sp.runner.stepText(j.id, step)
        return [
          ...c.images.flatMap((im) => [{ type: 'text', text: im.label }, { type: 'image', data: im.data, mimeType: im.mime }]),
          { type: 'text', text: c.text },
        ]
      },
    },
    {
      name: 'submit_draft',
      description: 'Hand in the draft of a step taken up by hand: it waits in Approvals for the user to accept, reply to or reject, as an LLM run\'s draft does. '
        + 'artifacts: files the step expects, as {name, content}, at most 10 of 5 MB each. Refused busy while an LLM run of the step is queued or running, '
        + 'and draft_waiting while a draft waits (reply to it with draft_reply, or reject it with job_command, first). Undo takes it back.',
      inputSchema: {
        type: 'object', required: ['id', 'step', 'output'],
        properties: {
          id: { type: 'string' }, step: { type: 'string', description: 'step id or exact title' }, output: { type: 'string' },
          artifacts: { type: 'array', maxItems: ARTS_MAX, items: { type: 'object', required: ['name', 'content'], properties: { name: { type: 'string' }, content: { type: 'string' } } } },
        },
      },
      async run(a, s) {
        const arts = Array.isArray(a.artifacts) ? a.artifacts as { name?: unknown; content?: unknown }[] : []
        if (arts.length > ARTS_MAX) throw new HttpError(400, 'bad_args', `at most ${ARTS_MAX} artifacts`)
        const files = arts.map((x) => {
          if (typeof x?.content !== 'string') throw new HttpError(400, 'bad_args', 'an artifact\'s content is text')
          if (Buffer.byteLength(x.content) > ART_MAX) throw new HttpError(400, 'bad_args', `${String(x.name)} is over 5 MB`)
          return { name: safeName(str(x.name, 'an artifact\'s name')), content: x.content }
        })
        const { sp, j } = await get(a.id), step = stepId(sp.ctx(), j, a.step) as string
        const busy = (await sp.runner.all()).some((r) => r.job === j.id && r.step === step && (r.state === 'queued' || r.state === 'running'))
        if (busy || j.flow[step]?.run) throw new HttpError(409, 'busy', 'an LLM run of this step is queued or running; wait for it or cancel it')
        if (j.flow[step]?.dr) throw new HttpError(409, 'draft_waiting', 'a draft of this step waits; reply to it with draft_reply or reject it first')
        const out = await command(s, j.id, { op: 'draftIn', step, t: str(a.output, 'output') })
        for (const f of files) await sp.runner.keepArtifact(j.id, step, f.name, (p) => writeFile(p, f.content, 'utf8'))
        // undo takes back the draft and its artifact links together
        const u = s.undo.at(-1)
        if (files.length && u && 'v' in u && u.id === j.id) u.v = (await sp.jobs.get(j.id))!.v!
        return { ...out, artifacts: files.length ? files.map((f) => f.name) : undefined }
      },
    },
    {
      name: 'job_context',
      description: "Change what the job's LLM runs are given: add an item, set how many of a work item's or a chat's newest comments/messages go in, or remove it. "
        + 'A mail goes in as its whole message and a knowledge note in full. Each run reads the items at its start and inlines them into its prompt; get_job lists them under context.',
      inputSchema: {
        type: 'object', required: ['id', 'op', 'kind', 'item'],
        properties: {
          id: { type: 'string' }, op: { type: 'string', enum: ['add', 'set', 'del'] }, kind: { type: 'string', enum: Object.keys(KINDS) },
          item: { type: 'string', description: 'work item key or id (ACME-512), chat id, mail id, or note id (knowledge_search)' },
          count: { type: 'integer', description: `newest comments or messages; default ${KINDS.work.def}, max ${KINDS.work.max} for work, ${KINDS.chat.max} for a chat; a mail or a note takes none` },
          name: { type: 'string', description: 'label for add' },
        },
      },
      async run(a, s) {
        const { sp, j } = await get(a.id), k = a.kind as keyof typeof KINDS, raw = str(a.item, 'item')
        const id = k === 'work' ? parseWorkId(j.ws, raw) ?? raw : raw
        const op = a.op === 'add' ? 'ctxAdd' : a.op === 'set' ? 'ctxSet' : a.op === 'del' ? 'ctxDel' : String(a.op)
        // a note is named by its title unless a name is given; an unknown one is refused before it lands
        const name = typeof a.name === 'string' ? a.name : k === 'note' && op === 'ctxAdd' ? (await sp.notes.read(id)).title : undefined
        return command(s, j.id, { op, k, id, ...(a.count !== undefined ? { n: a.count } : {}), ...(name !== undefined ? { name } : {}) })
      },
    },
    {
      name: 'return_to',
      description: 'Send a job back to a step it has passed (also a closed job): the pass so far is kept as a round, the steps from that one on start again. Refused while an LLM run is in flight.',
      inputSchema: { type: 'object', required: ['id', 'step', 'why'], properties: { id: { type: 'string' }, step: { type: 'string', description: 'step id or exact title' }, why: { type: 'string' } } },
      async run(a, s) { return command(s, a.id, { op: 'returnTo', step: a.step, why: a.why }) },
    },
    {
      name: 'create_job', description: 'Create a job from a playbook (see list_playbooks) in a workspace. It starts as ready; start it with job_command op start.',
      inputSchema: {
        type: 'object', required: ['title', 'playbook'],
        properties: {
          title: { type: 'string' }, playbook: { type: 'string', description: 'playbook id' }, ws: wsArg,
          key: { type: 'string', description: 'work item or ticket key, e.g. ACME-512' },
          project: { type: 'string', description: `project name; default: that workspace's first project (${perWs((sp) => sp.page.pack.prj[0])})` },
          chat: { type: 'string', description: 'chat id to link' }, mail: { type: 'string', description: 'mail id to link' },
          description: { type: 'string', description: "Markdown, in English: what the job is for; every LLM run gets it as the user's part of its prompt. Change it later with job_command op describe" },
        },
      },
      async run(a, s) {
        const sp = spaces.pick(a.ws)
        const j = await sp.jobs.create({
          t: str(a.title, 'title'), pb: str(a.playbook, 'playbook'), key: typeof a.key === 'string' && a.key.trim() ? a.key.trim() : 'NEW',
          prj: typeof a.project === 'string' && a.project ? a.project : sp.page.pack.prj[0], ws: sp.id,
          ...(typeof a.chat === 'string' ? { chat: a.chat } : {}), ...(typeof a.mail === 'string' ? { mail: a.mail } : {}),
          ...(typeof a.description === 'string' ? { d: a.description } : {}),
        }, 'session')
        s.undo.push({ id: j.id, created: true })
        return brief(sp.ctx(), j, sp.id)
      },
    },
    {
      name: 'start_item',
      description: 'Start a board item of a workspace: in the tracker assign it to the user and move it from its ready column to its dev column '
        + `(${perWs((sp) => { const c = columns(sp.page.board); return `${c.ready} to ${c.dev.column}` })}), then create and start its job, or return the job if one is open. `
        + 'Undo cancels a job this created; the tracker change stays.',
      inputSchema: {
        type: 'object', required: ['key'],
        properties: {
          key: { type: 'string', description: 'work item key, e.g. ACME-603' }, ws: wsArg,
          playbook: { type: 'string', description: `playbook id; default the workspace's board start (${perWs((sp) => sp.page.board.start)})` },
        },
      },
      async run(a, s) {
        const sp = spaces.pick(a.ws)
        const r = await sp.start(str(a.key, 'key'), typeof a.playbook === 'string' && a.playbook.trim() ? a.playbook.trim() : undefined, 'session')
        if (r.created) { s.undo.push({ id: r.job.id, created: true }); s.undo.splice(0, s.undo.length - MAX_UNDO) }
        return { ...brief(sp.ctx(), r.job, sp.id), created: r.created }
      },
    },
    {
      name: 'undo', description: "Take back this session's last change. A command is undone only if the job has not changed since; a job this session created is cancelled.",
      inputSchema: { type: 'object', properties: {} },
      async run(_, s) {
        const u = s.undo.pop()
        if (!u) throw new HttpError(400, 'bad_state', 'nothing to undo in this session')
        const sp = spaces.byJob(u.id), x = sp.ctx()
        if ('created' in u) {
          const r = await sp.jobs.cmd(u.id, { op: 'close', st: 'cancelled', note: 'created by mistake; undone' }, undefined, 'session')
          return { undone: `created ${u.id}`, job: brief(x, r.job, sp.id) }
        }
        return { undone: `last change to ${u.id}`, job: brief(x, await sp.jobs.undo(u.id, u.v, u.prev), sp.id) }
      },
    },
    {
      name: 'knowledge_search',
      description: "Search a workspace's knowledge notes: how its tools, systems and machines work. Up to 20 notes, best first, each with a snippet; an empty q lists them all. Read one in full with knowledge_read.",
      inputSchema: {
        type: 'object', required: ['q'],
        properties: { q: { type: 'string' }, tags: { type: 'array', items: { type: 'string' }, description: 'only notes carrying every one of these tags' }, ws: wsArg },
      },
      async run(a) { return spaces.pick(a.ws).notes.search(typeof a.q === 'string' ? a.q : '', strs(a.tags)) },
    },
    {
      name: 'knowledge_read', description: 'One knowledge note in full by its id: title, tags, the playbooks whose runs read it, v and its Markdown text.',
      inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, ws: wsArg } },
      async run(a) { return spaces.pick(a.ws).notes.read(str(a.id, 'id')) },
    },
    {
      name: 'knowledge_propose',
      description: 'Propose a new knowledge note, or a change to one: note = its id, text = the whole new text in Markdown. It waits in the console\'s Approvals; '
        + 'the user accepts, edits or rejects it, and nothing is written before that. Tags and playbooks left out of a change keep the note\'s.',
      inputSchema: {
        type: 'object', required: ['title', 'text', 'reason'],
        properties: {
          note: { type: 'string', description: 'id of the note to change; leave out for a new note' }, title: { type: 'string' }, text: { type: 'string' },
          reason: { type: 'string', description: 'why, in one line' }, tags: { type: 'array', items: { type: 'string' } },
          playbooks: { type: 'array', items: { type: 'string' }, description: 'playbook ids whose every run should read the note in full' }, ws: wsArg,
        },
      },
      async run(a) {
        const p = await spaces.pick(a.ws).notes.propose({
          ...(a.note !== undefined ? { note: str(a.note, 'note') } : {}), title: str(a.title, 'title'), text: str(a.text, 'text'), reason: str(a.reason, 'reason'),
          tags: strs(a.tags), playbooks: strs(a.playbooks), by: 'session',
        })
        return { proposal: p.id, title: p.title, waits: 'in Approvals, for the user' }
      },
    },
    {
      name: 'list_playbooks', description: 'Playbooks a job can follow, with the workspace each belongs to (none: any workspace), what context their jobs need, their phases and step ids.',
      inputSchema: { type: 'object', properties: {} },
      async run() {
        const PB = spaces.ctx().PB
        // a once playbook is one job's own steps, not one to follow
        return Object.entries(PB).filter(([, p]) => !p.once).map(([id, p]) => ({ id, ws: p.ws, name: p.n, about: p.d, ...(p.needs ? { needs: p.needs } : {}), phases: p.ph.map((h) => `${h.c} ${h.n}: ${h.s.map((s) => `${s.id} ${s.t}`).join('; ')}`) }))
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
        const name = (m.params?.clientInfo as { name?: unknown } | undefined)?.name
        made.sid = randomUUID()
        const s = session(made.sid)
        if (typeof name === 'string' && name.trim()) s.client = name.trim().slice(0, 60)
        return reply({
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0], capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'work-console', version: o.version || '1.0.0' },
          instructions: 'Work Console jobs and knowledge. Read a job with get_job before changing it. Every change applies at once, shows live in the console and is journaled under your client\'s name; undo takes back this session\'s last change. '
            + 'A step taken up by hand: read it with step_context, do it, hand the result in with submit_draft. '
            + 'Knowledge notes say how a workspace\'s tools, systems and machines work: search them before guessing, and propose what is missing with knowledge_propose; the user decides. '
            + 'A job id names its workspace; create_job, start_item and the knowledge tools take ws, which may be left out while one workspace is registered.',
        })
      }
      case 'ping': return reply({})
      case 'tools/list': return reply({ tools: o.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
      case 'tools/call': {
        const t = byName.get(String(m.params?.name))
        if (!t) return error(-32602, `no tool ${m.params?.name}`)
        try {
          const r = await t.run((m.params?.arguments as Record<string, unknown>) || {}, session(sid))
          return reply({ content: t.raw ? r : [{ type: 'text', text: JSON.stringify(r, null, 1) }] })
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
