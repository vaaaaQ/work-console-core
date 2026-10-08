import pg from 'pg'
import { pgConn } from '../store/pg.ts'
import type { Doc, StateDocs } from './state.ts'

/* B's documents as Postgres rows: kind 'state', id '<concept>/<id>', and the job seq in the row with id 'seq'.
   The table is the console's docs table, made here as the pg store makes it. */

const SCHEMA = /^[a-z_][a-z0-9_]{0,62}$/

export function pgDocs(o: { url: string; password?: () => string; schema?: string; ws: string }): StateDocs & { close(): Promise<void> } {
  const schema = o.schema ?? 'work_console'
  if (!SCHEMA.test(schema)) throw new Error(`schema ${schema} must match ${SCHEMA}`)
  const docs = `"${schema}".docs`
  const pool = new pg.Pool({ ...pgConn(o.url, o.password), connectionTimeoutMillis: 5000, max: 2, allowExitOnIdle: true })
  pool.on('error', () => {})
  let ready: Promise<void> | null = null

  const ensure = () => {
    ready ??= (async () => {
      const c = await pool.connect()
      try {
        await c.query('begin')
        await c.query(`select pg_advisory_xact_lock(hashtext('work_console_schema'))`)
        await c.query(`create schema if not exists "${schema}"`)
        await c.query(`create table if not exists ${docs} (ws text not null, kind text not null, id text not null, v integer not null,
          doc jsonb not null, updated timestamptz not null default now(), primary key (ws, kind, id))`)
        await c.query('commit')
      } catch (e) { await c.query('rollback').catch(() => {}); throw e } finally { c.release() }
    })().catch((e) => { ready = null; throw e })
    return ready
  }
  const q = async (sql: string, params: unknown[]) => { await ensure(); return (await pool.query(sql, params)).rows }
  const upsert = (id: string, v: number, doc: unknown) => q(
    `insert into ${docs} (ws, kind, id, v, doc) values ($1, 'state', $2, $3, $4)
     on conflict (ws, kind, id) do update set v = excluded.v, doc = excluded.doc, updated = now()`, [o.ws, id, v, JSON.stringify(doc)])

  return {
    async load() {
      const out: Record<string, Doc[]> = {}
      let seq = 0
      for (const r of await q(`select id, doc from ${docs} where ws = $1 and kind = 'state'`, [o.ws]) as { id: string; doc: Doc & { n?: number } }[]) {
        if (r.id === 'seq') { seq = Number(r.doc.n) || 0; continue }
        const i = r.id.indexOf('/')
        if (i > 0) (out[r.id.slice(0, i)] ??= []).push(r.doc)
      }
      return { docs: out, seq }
    },
    async put(concept, id, doc) {
      if (doc) await upsert(`${concept}/${id}`, doc.v, doc)
      else await q(`delete from ${docs} where ws = $1 and kind = 'state' and id = $2`, [o.ws, `${concept}/${id}`])
    },
    async seq(n) { await upsert('seq', n, { n }) },
    close: () => pool.end(),
  }
}
