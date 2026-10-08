import { test } from 'node:test'
import assert from 'node:assert/strict'
import { manualPrompt, PROVIDERS, providerPick } from './providers.ts'
import type { OpenIn } from './providers.ts'
import type { Sdk } from './sdk.ts'

const base: OpenIn = { dir: 'D:\\w x', job: 'AD-0007', title: 'Fix "it"', step: 'impl', stepTitle: 'Implement' }
const q = (u: string, k: string) => new URL(u).searchParams.get(k)

test('Claude Code: a claude session resumes in its dir as a command', () => {
  const o = PROVIDERS.claude.open({ ...base, run: { provider: 'claude', session: 's-1' } })
  assert.deepEqual(o, { kind: 'command', value: 'cd "D:\\w x"; claude --resume s-1' })
})

test('Claude Code: no run, no session or another provider\'s run opens a new session through the link', () => {
  for (const run of [undefined, { provider: 'claude' as const }, { provider: 'cursor' as const, session: 'c-1' }]) {
    const o = PROVIDERS.claude.open({ ...base, run })
    assert.equal(o.kind, 'link')
    assert.ok(o.value.startsWith('claude-cli://open?'), o.value)
    assert.equal(q(o.value, 'cwd'), 'D:\\w x')
    assert.equal(q(o.value, 'q'), manualPrompt(base))
  }
})

test('Cursor: always the prompt link, whatever ran before', () => {
  for (const run of [undefined, { provider: 'claude' as const, session: 's-1' }]) {
    const o = PROVIDERS.cursor.open({ ...base, run })
    assert.equal(o.kind, 'link')
    assert.ok(o.value.startsWith('cursor://anysphere.cursor-deeplink/prompt?text='), o.value)
    assert.equal(q(o.value, 'text'), manualPrompt(base))
  }
})

test('the prompt names the job, the step, the dir and the two tools', () => {
  const p = manualPrompt(base)
  for (const s of ['AD-0007', 'Fix "it"', 'impl', 'Implement', 'D:\\w x', 'step_context', 'submit_draft', 'work-console']) assert.ok(p.includes(s), s)
})

test('a prompt over a link\'s limit is an error, never a clipped link', () => {
  assert.throws(() => PROVIDERS.claude.open({ ...base, title: 'x'.repeat(6000) }), /5000/)
  assert.throws(() => PROVIDERS.cursor.open({ ...base, title: 'x'.repeat(9000) }), /8000/)
})

test('the pick: auto reads the settings each time, a provider without auto is provider_unavailable, one sdk per provider', () => {
  let made = 0
  const s = { auto: 'claude' as 'claude' | 'cursor' }
  const pick = providerPick(() => ({ auto: s.auto, manual: 'claude' }), () => { made++; return {} as Sdk })
  assert.equal(pick.auto(), 'claude')
  assert.equal(pick.get('claude'), pick.get('claude'))
  assert.equal(made, 1)
  s.auto = 'cursor'
  assert.equal(pick.auto(), 'cursor')
  assert.equal(pick.get('cursor'), pick.get('cursor'))
  assert.equal(made, 2)
  const auto = PROVIDERS.cursor.auto
  try {
    delete PROVIDERS.cursor.auto
    assert.throws(() => providerPick(() => ({ auto: 'cursor', manual: 'claude' }), () => ({}) as Sdk).get('cursor'), /^Error: provider_unavailable/)
  } finally { PROVIDERS.cursor.auto = auto }
})
