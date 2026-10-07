import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redoText, replyPrompt, buildPrompt, blockersText } from './prompt.ts'
import { freshJob } from '../../src/model/transitions.ts'
import { demoCtx } from '../testkit.ts'
import type { Flow } from '../../src/model/types.ts'

test('a reply prompt carries the text and one line by intent', () => {
  assert.match(replyPrompt('make it shorter', 'revise', 'Valery'), /^Valery replied to your draft:\n\nmake it shorter\n\nChange the draft .*submit_draft with the whole new text\.$/s)
  assert.match(replyPrompt('ok, ship it', 'accept'), /^the user replied.*accepted as it is then\.$/s)
  const ask = replyPrompt('why X?', 'ask')
  assert.match(ask, /Answer in text/); assert.match(ask, /Do not call submit_draft/)
})

test('a redo carries the ask, the rejected draft clipped and why', () => {
  const t = redoText('Do: A.\nDone when: B.', 'x'.repeat(9000), ' wrong scope ')
  assert.match(t, /^Do: A\.\nDone when: B\.\n\n## Rejected draft\nx+…\n\n## Why\nwrong scope$/)
  assert.ok(t.length < 6200)
  assert.match(redoText('Do: A.', 'short', 'no'), /## Rejected draft\nshort\n\n## Why\nno$/)
})

test('blockersText: closed blockers with plan and outcome, then the open ones', () => {
  const f = { w: [
    { j: 'J-7', t: 'Ask Imre', st: 'done', plan: 'if yes, set it', out: 'Yes, use kv-1' },
    { j: 'J-8', st: 'open', plan: 'wait for QA' },
    { j: 'J-9', t: 'Server', st: 'cancelled' },
  ] } as unknown as Flow
  assert.equal(blockersText(f), [
    '### J-7 Ask Imre: done\nPlan: if yes, set it\nOutcome: Yes, use kv-1',
    '### J-9 Server: cancelled\nOutcome: none given',
    '- J-8 is still open; plan: wait for QA',
  ].join('\n\n'))
  assert.equal(blockersText(undefined), '')
})

test('the Blockers section sits before Earlier outputs', () => {
  const x = demoCtx(), j = freshJob(x, 'J-1', { t: 'T', key: 'NEW', pb: 'action', prj: 'p', ws: 'acme' })
  j.flow.tr.out = 'triaged'
  j.flow.dr.w = [{ j: 'J-7', t: 'Ask Imre', st: 'done', out: 'yes' }]
  const p = buildPrompt(x, j, 'dr', 'go', {})
  assert.ok(p.indexOf('## Blockers') > 0 && p.indexOf('## Blockers') < p.indexOf('## Earlier outputs'))
})

test('a reply prompt with blocker on says when to call open_blocker', () => {
  assert.match(replyPrompt('wait for Imre', 'revise', 'Valery', true), /open_blocker/)
  assert.doesNotMatch(replyPrompt('shorter', 'revise'), /open_blocker/)
})
