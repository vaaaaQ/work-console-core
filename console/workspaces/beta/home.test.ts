import '../../src/testkit.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homeCal, homeNeeds } from '../../src/model/home.ts'
import { JOBS, initFlow } from '../../src/model/world.ts'
import { install } from '../../src/workspace.ts'
import acme from '../acme/page.ts'
import beta from './page.ts'

test('Home holds rows labelled Acme and Beta once both workspaces are installed', () => {
  install([{ page: acme }, { page: beta }]); JOBS.forEach(initFlow)
  const need = homeNeeds(), cal = homeCal(), labels = (l: { label: string | null }[]) => [...new Set(l.map((r) => r.label))].sort()
  assert.deepEqual(labels(need), ['Acme', 'Beta'])
  assert.deepEqual(labels(cal), ['Acme', 'Beta'])
  assert.ok([...need, ...cal].every((r) => r.label === (r.ws === 'acme' ? 'Acme' : 'Beta')))
})
