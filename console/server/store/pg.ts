import { randomBytes } from 'node:crypto'
import pg from 'pg'
import type { AgentRec } from '../../src/model/agent.ts'
import type { Job, Playbook, RunRec, Tpl } from '../../src/model/types.ts'
import { GatewayError } from '../bridge/wire.ts'
import type { ConceptReply } from '../bridge/wire.ts'
import type { Bus } from '../events.ts'
import type { Source } from '../workspace.ts'
import { Conflict } from './port.ts'
import type { Mark, Store } from './port.ts'

/* A workspace without a gateway: PostgreSQL is both its availability and its store. Many writers may
   share the database; a write is compare-and-set on v in one statement, so a stale writer gets a
   conflict, never a lost write, and a NOTIFY tells the other writers' consoles what changed. The
   source is up while the database answers; down, the space behaves as if its bridge went away. */

/** url null = no database configured yet: the source stays down and says unset */
export type PgSourceOpts = { url: string | null; unset?: string; password?: () => string; schema?: string; ws: string; bus: Bus; checkMs?: number }
export type PgSource = Source & { store(o: { prefix: string; playbooks: Record<string, Playbook> }): Store }

const SCHEMA = /^[a-z_][a-z0-9_]{0,62}$/
const CHANNEL = 'work_console'
type Kind = 'jobs' | 'runs' | 'playbooks' | 'marks' | 'agent'
type Row = { v: number; doc: Record<string, unknown> }
type Note = { ws: string; kind: Kind; id: string; v: number; by: string }

const clone = <T>(x: T): T => structuredClone(x)
const asJob = (r: Row): Job => ({ ...clone(r.doc), v: r.v }) as unknown as Job
const asMark = (d: Record<string, unknown> | undefined): Mark => ({
  ...(d?.done === true ? { done: true } : {}), ...(typeof d?.job === 'string' ? { job: d.job } : {}),
  ...(d?.hidden === true ? { hidden: true } : {}), ...(typeof d?.name === 'string' ? { name: d.name } : {}),
})

/** a SQLSTATE that says the database is away (connection, operator intervention, resources), or no SQLSTATE at all */
function away(e: unknown) {
  const c = (e as { code?: unknown }).code
  return !(typeof c === 'string' && /^[0-9A-Z]{5}$/.test(c)) || /^(08|53|57)/.test(c)
}

/** pg's parse of a connection string sets the password, null when the url has none, and that beats a password
    option; so with a password function the url goes in as fields, and the function is the password */
export function pgConn(url: string, password?: () => string): pg.ClientConfig {
  if (!password) return { connectionString: url }
  const u = new URL(url)
  if (u.search) throw new Error('a database url read with a password function takes no query')
  return { host: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port || 5432), user: decodeURIComponent(u.username),
    database: decodeURIComponent(u.pathname.slice(1)) || undefined, password }
}

/** the console's tables in schema, made once by whichever console gets there first: every user of the database calls this */
export async function ensureSchema(pool: pg.Pool, schema: string) {
  if (!SCHEMA.test(schema)) throw new Error(`schema ${schema} must match ${SCHEMA}`)
  const c = await pool.connect()
  try {
    await c.query('begin')
    // two consoles creating the schema at once would collide on its catalog row
    await c.query(`select pg_advisory_xact_lock(hashtext('work_console_schema'))`)
    await c.query(`create schema if not exists "${schema}"`)
    await c.query(`create table if not exists "${schema}".docs (ws text not null, kind text not null, id text not null, v integer not null,
      doc jsonb not null, updated timestamptz not null default now(), primary key (ws, kind, id))`)
    await c.query(`create table if not exists "${schema}".seq (ws text primary key, n integer not null)`)
    await c.query('commit')
  } catch (e) { await c.query('rollback').catch(() => {}); throw e } finally { c.release() }
}

export function pgSource(o: PgSourceOpts): PgSource {
  const schema = o.schema ?? 'work_console'
  if (!SCHEMA.test(schema)) throw new Error(`schema ${schema} must match ${SCHEMA}`)
  const t = (name: string) => `"${schema}".${name}`
  const me = randomBytes(6).toString('hex')
  const unset = o.unset || 'no database is configured'
  const conn = o.url ? { ...pgConn(o.url, o.password), connectionTimeoutMillis: 5000 } : null
  const pool = conn && new pg.Pool({ ...conn, max: 5, allowExitOnIdle: true })
  let up = false, timer: ReturnType<typeof setInterval> | undefined, ready: Promise<void> | null = null
  let listener: pg.Client | null = null, checking = false, stopped = false, said = ''

  function set(next: boolean) {
    if (next === up) return
    up = next
    o.bus.emit({ kind: 'bridge', state: up ? 'ok' : 'unavailable', concepts: {}, via: 'store', ...(up ? {} : { why: said }) })
  }
  pool?.on('error', () => { void check() })

  /** the schema, made once per process; a failure is retried at the next call */
  function ensure() {
    ready ??= (async () => {
      if (!pool) throw new Error(unset)
      await ensureSchema(pool, schema)
    })().catch((e) => { ready = null; throw e })
    return ready
  }

  async function q(sql: string, params: unknown[] = []): Promise<Row[]> {
    try {
      await ensure()
      return (await pool!.query(sql, params)).rows as Row[]
    } catch (e) {
      if (!away(e)) throw e
      void check()
      throw new GatewayError(503, 'source_unavailable', `the database is unavailable: ${(e as Error).message}`)
    }
  }

  async function listen() {
    if (listener) return
    const c = new pg.Client(conn!)
    c.on('error', () => { if (listener === c) listener = null; void c.end().catch(() => {}); void check() })
    c.on('notification', (m) => { void heard(m.payload) })
    try {
      await c.connect()
      await c.query(`listen ${CHANNEL}`)
    } catch (e) { void c.end().catch(() => {}); throw e }
    // stopped while connecting: nobody would end this client, and it would keep the process alive
    if (stopped) { void c.end().catch(() => {}); return }
    listener = c
  }

  /** another writer's change, told to this space's bus as if it were its own */
  async function heard(payload: string | undefined) {
    let n: Note
    try { n = JSON.parse(payload || '') } catch { return }
    if (n.ws !== o.ws || n.by === me) return
    try {
      const [r] = await q(`select v, doc from ${t('docs')} where ws = $1 and kind = $2 and id = $3`, [o.ws, n.kind, n.id])
      if (!r) return
      if (n.kind === 'jobs') o.bus.emit({ kind: 'job', job: asJob(r) })
      else if (n.kind === 'runs') o.bus.emit({ kind: 'run', run: clone(r.doc) as unknown as RunRec })
    } catch (e) { console.error(`reading ${n.kind} ${n.id} after a notify:`, (e as Error).message) }
  }

  async function check() {
    if (checking || stopped) return
    checking = true
    try {
      await ensure()
      await pool!.query('select 1')
      await listen()
      said = ''
      set(true)
    } catch (e) {
      if (listener) { const c = listener; listener = null; void c.end().catch(() => {}) }
      // once per new reason, so a wrong url or password shows on the console without a line every check
      const why = (e as Error).message || String((e as { code?: unknown }).code ?? e)
      if (why !== said && !stopped) { said = why; console.error(`${o.ws}: the database is unavailable: ${why}`) }
      set(false)
    } finally { checking = false }
  }

  const none = (c: string): ConceptReply => ({ status: 'unsupported', message: `${o.ws} has no ${c} source` })
  /** v of the row written, the notify sent in the same statement */
  const notify = (kind: Kind) => `pg_notify('${CHANNEL}', json_build_object('ws', $1::text, 'kind', '${kind}', 'id', $2::text, 'v', w.v, 'by', '${me}')::text)`

  function store(so: { prefix: string; playbooks: Record<string, Playbook> }): Store {
    const one = async (kind: Kind, id: string) => (await q(`select v, doc from ${t('docs')} where ws = $1 and kind = $2 and id = $3`, [o.ws, kind, id]))[0]
    const all = (kind: Kind) => q(`select id, v, doc from ${t('docs')} where ws = $1 and kind = $2`, [o.ws, kind]) as Promise<(Row & { id: string })[]>
    /** a write only this console makes: the last one wins */
    const upsert = (kind: Kind, id: string, doc: unknown, merge = false) => q(
      `with w as (insert into ${t('docs')} (ws, kind, id, v, doc) values ($1, '${kind}', $2, 1, $3)
         on conflict (ws, kind, id) do update set v = ${t('docs')}.v + 1, doc = ${merge ? `${t('docs')}.doc || excluded.doc` : 'excluded.doc'}, updated = now()
         returning v) select w.v, ${notify(kind)} from w`, [o.ws, id, JSON.stringify(doc)])
    const remove = (kind: Kind, id: string) => q(`delete from ${t('docs')} where ws = $1 and kind = $2 and id = $3`, [o.ws, kind, id])

    return {
      async jobs() { return (await all('jobs')).map(asJob).sort((a, b) => b.id.localeCompare(a.id)) },
      async job(id) { const r = await one('jobs', id); return r && asJob(r) },
      async putJob(job, expectV) {
        const v = (expectV ?? 0) + 1, doc = JSON.stringify({ ...job, v })
        const rows = expectV === null
          ? await q(`with w as (insert into ${t('docs')} (ws, kind, id, v, doc) values ($1, 'jobs', $2, 1, $3) on conflict do nothing returning v, doc)
              select w.v, w.doc, ${notify('jobs')} from w`, [o.ws, job.id, doc])
          : await q(`with w as (update ${t('docs')} set v = v + 1, doc = $3, updated = now() where ws = $1 and kind = 'jobs' and id = $2 and v = $4 returning v, doc)
              select w.v, w.doc, ${notify('jobs')} from w`, [o.ws, job.id, doc, expectV])
        if (rows[0]) return asJob(rows[0])
        const cur = await one('jobs', job.id)
        throw new Conflict(`job ${job.id} changed elsewhere`, cur && asJob(cur))
      },
      async runs() { return (await all('runs')).map((r) => clone(r.doc) as unknown as RunRec) },
      async putRun(r) { await upsert('runs', r.id, r) },
      async playbooks() {
        const out = clone(so.playbooks)
        for (const r of await all('playbooks')) { if (r.doc.pb) out[r.id] = clone(r.doc.pb as Playbook); else delete out[r.id] }
        return out
      },
      async templates() {
        const out: Record<string, Tpl[]> = {}
        for (const r of await all('playbooks')) if (r.doc.pb && r.doc.tpl) Object.assign(out, clone(r.doc.tpl as Record<string, Tpl[]>))
        return out
      },
      // a built-in playbook is deleted by a tombstone; an added one by removing its row
      async putPlaybook(id, pb, tpl) {
        if (pb) await upsert('playbooks', id, tpl && Object.keys(tpl).length ? { pb, tpl } : { pb })
        else if (so.playbooks[id]) await upsert('playbooks', id, { pb: null })
        else await remove('playbooks', id)
      },
      async marks() { return Object.fromEntries((await all('marks')).map((r) => [r.id, asMark(r.doc)])) },
      // merged as given, so a false clears a flag; asMark keeps only the true ones on read
      async putMark(id, m) { if (m) await upsert('marks', id, m, true); else await remove('marks', id) },
      async agents() { return (await all('agent')).map((r) => clone(r.doc) as unknown as AgentRec) },
      async putAgent(a) { await upsert('agent', a.id, a) },
      async nextJobId() {
        const [r] = await q(`insert into ${t('seq')} (ws, n) values ($1, 1) on conflict (ws) do update set n = ${t('seq')}.n + 1 returning n as v`, [o.ws])
        return `${so.prefix}-${String(r.v).padStart(4, '0')}`
      },
    }
  }

  return {
    available: () => up,
    via: 'store',
    // an unset source knows why before its first check
    why: () => said || (pool ? '' : unset),
    concepts: () => ({}),
    read: async (cs) => Object.fromEntries(cs.map((c) => [c, none(c)])),
    get: async (c) => none(c),
    act: async () => ({ status: 'error', error: { code: 'unsupported', message: `${o.ws} has no gateway to act through` } }),
    state: async () => ({ status: 'unsupported', message: `${o.ws} keeps its state in its own database` }),
    start() {
      stopped = false
      void check()
      timer = setInterval(() => void check(), o.checkMs ?? 10000)
      timer.unref?.()
    },
    stop() {
      stopped = true
      clearInterval(timer)
      if (listener) { const c = listener; listener = null; void c.end().catch(() => {}) }
      void pool?.end().catch(() => {})
    },
    store,
  }
}
