import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { pgDocs } from './pgdocs.ts'
import { StateB } from './state.ts'

/* Needs a throwaway Postgres: WC_TEST_PG_URL=postgres://user:pass@127.0.0.1:<port>/db. Each run takes a fresh schema. */

const url = process.env.WC_TEST_PG_URL
const schema = `wc_state_test_${process.pid}`
after(async () => {
  if (!url) return
  const c = new pg.Client({ connectionString: url })
  await c.connect()
  await c.query(`drop schema if exists "${schema}" cascade`)
  await c.end()
})

test('pgDocs keeps B as rows of kind state: a put, a conflict, a mint, and a reload', { skip: !url && 'WC_TEST_PG_URL is not set' }, async () => {
  const docs = pgDocs({ url: url!, schema, ws: 'w1' })
  const b = new StateB({ docs })
  await b.load()
  assert.equal((await b.put({ concept: 'jobs', id: 'J-0001', doc: { title: 'one' }, expectV: null })).status, 'ok')
  assert.equal((await b.put({ concept: 'jobs', id: 'J-0001', doc: { title: 'two' }, expectV: null })).status, 'conflict')
  await b.put({ concept: 'marks', id: 'chat:c1', doc: { hidden: true }, expectV: null })
  await b.put({ concept: 'marks', id: 'chat:c1', doc: null, expectV: 1 })
  assert.deepEqual((await b.newJobId()).items, { id: 'J-0002' })

  const again = new StateB({ docs: pgDocs({ url: url!, schema, ws: 'w1' }) })
  await again.load()
  assert.deepEqual(again.items('jobs'), b.items('jobs'))
  assert.deepEqual(again.items('marks'), [])
  assert.deepEqual((await again.newJobId()).items, { id: 'J-0003' })

  const other = new StateB({ docs: pgDocs({ url: url!, schema, ws: 'w2' }) })
  await other.load()
  assert.deepEqual(other.items('jobs'), [], 'another workspace sees none of it')

  const c = new pg.Client({ connectionString: url })
  await c.connect()
  const rows = (await c.query(`select kind, id from "${schema}".docs where ws = 'w1' order by id`)).rows
  await c.end()
  assert.deepEqual(rows, [{ kind: 'state', id: 'jobs/J-0001' }, { kind: 'state', id: 'seq' }])
  await docs.close()
})
