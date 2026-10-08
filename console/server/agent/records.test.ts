import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import type { AgentRec } from '../../src/model/agent.ts'
import { fileStore } from '../store/file.ts'
import type { Store } from '../store/port.ts'
import { agentRecords } from './records.ts'
import { tempDir } from '../testdirs.ts'

const rec = (id: string, t = 'hi'): AgentRec => ({
  id, ws: 'w1', provider: 'claude', turns: [{ at: '2026-10-08T10:00:00Z', who: 'you', t }], commits: [], status: 'idle',
  created: '2026-10-08T10:00:00Z', updated: '2026-10-08T10:00:00Z',
})

test('a store that keeps agent records keeps them across a reopen', async () => {
  const dir = tempDir('agent'), path = join(dir, 'state.json')
  const r = agentRecords(fileStore(path), join(dir, 'unused.json'))
  await r.put(rec('a1')); await r.put(rec('a2')); await r.put(rec('a1', 'again'))
  const again = await agentRecords(fileStore(path), join(dir, 'unused.json')).all()
  assert.deepEqual(again.map((a) => [a.id, a.turns[0].t]), [['a1', 'again'], ['a2', 'hi']])
})

test('a store without agent records falls back to a file of its own', async () => {
  const dir = tempDir('agent'), file = join(dir, 'agent', 'w1.json')
  const bare = {} as Store
  await agentRecords(bare, file).put(rec('a1'))
  assert.deepEqual((await agentRecords(bare, file).all()).map((a) => a.id), ['a1'])
})
