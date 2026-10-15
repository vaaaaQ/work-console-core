import { test } from 'node:test'
import assert from 'node:assert/strict'
import { approveText, redoText, replyPrompt, buildPrompt, blockersText, manualText, contextText } from './prompt.ts'
import { apply, freshJob } from '../../src/model/transitions.ts'
import { demoCtx } from '../testkit.ts'
import type { Cmd, Flow } from '../../src/model/types.ts'

test('a reply prompt carries the text and one line by intent', () => {
  assert.match(replyPrompt('make it shorter', 'revise', 'Valery'), /^Valery replied to your draft:\n\nmake it shorter\n\nChange the draft .*submit_draft with the whole new text\.$/s)
  assert.match(replyPrompt('ok, ship it', 'accept'), /^the user replied.*accepted as it is then\.$/s)
  const ask = replyPrompt('why X?', 'ask')
  assert.match(ask, /Answer in text/); assert.match(ask, /Do not call submit_draft/)
})

test('an approval is the numbered commands, and its reply prompt ends with the approve tail', () => {
  const q = approveText(['git push origin job/x', 'npm run deploy\n  -- --env dev'])
  assert.equal(q, 'Approved, run exactly these commands, in this order:\n1. git push origin job/x\n2. npm run deploy\n  -- --env dev')
  const p = replyPrompt(q, 'approve', 'Valery')
  assert.ok(p.startsWith(`Valery replied to your draft:\n\n${q}\n\n`))
  assert.ok(p.endsWith('Run exactly these commands, in this order, and nothing else that needs approval. Stop at the first that fails. '
    + 'Then call submit_draft with what each one printed. If one failed, set outcome failed. A further command that needs approval goes in commands again.'))
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

test('## Sources goes in after the context, and the bridge line points to it', () => {
  const x = demoCtx(), j = freshJob(x, 'J-1', { t: 'T', key: 'NEW', pb: 'action', prj: 'p', ws: 'acme' })
  const p = buildPrompt(x, j, 'dr', 'go', { sources: '## Sources\n### Talk (talk, browser tab)' })
  assert.ok(p.indexOf('\n## Sources\n') > p.indexOf('## Job '))
  assert.match(p, /the bridge tools \(bridge_snapshot, bridge_get\); the packs behind them are under ## Sources, and bridge_get takes pack where a concept has more than one/)
  assert.doesNotMatch(buildPrompt(x, j, 'dr', 'go', {}), /\n## Sources\n/)
})

test('a hand-made session and the context text carry ## Sources after the context, like the run prompt', () => {
  const x = demoCtx(), j = freshJob(x, 'J-1', { t: 'T', key: 'NEW', pb: 'action', prj: 'p', ws: 'acme' }), sources = '## Sources\n### Talk (talk, browser tab)'
  for (const t of [manualText(x, j, 'dr', 'go', { sources }), contextText(x, j, 'dr', 'go', { sources })]) {
    assert.ok(t.indexOf('\n## Sources\n### Talk') > t.indexOf('## Job '))
    assert.ok(t.indexOf('\n## Sources\n') < t.indexOf('## Instruction'))
  }
  for (const t of [manualText(x, j, 'dr', 'go', {}), contextText(x, j, 'dr', 'go', {})]) assert.doesNotMatch(t, /## Sources/)
})

test('a reply prompt with blocker on says when to call open_blocker', () => {
  assert.match(replyPrompt('wait for Imre', 'revise', 'Valery', true), /open_blocker/)
  assert.doesNotMatch(replyPrompt('shorter', 'revise'), /open_blocker/)
})

test('a step whose draft a later step sends is told to submit the message alone', () => {
  const x = demoCtx(), j = freshJob(x, 'J-1', { t: 'T', key: 'NEW', pb: 'action', prj: 'p', ws: 'acme' })
  assert.match(buildPrompt(x, j, 'dr', 'go', { me: 'Valery' }), /the draft is the message "Send it" sends, word for word: submit_draft carries that message alone.*Remarks for Valery go in journal\(\)/)
  assert.doesNotMatch(buildPrompt(x, j, 'tr', 'go', {}), /word for word/)
})

test('a restarted step whose message went out in an earlier round is told the old text and to say what changed', () => {
  const x = demoCtx()
  let j = apply(x, freshJob(x, 'J-1', { t: 'T', key: 'NEW', pb: 'action', prj: 'p', ws: 'acme' }), { op: 'start' }).job
  for (const c of [{ op: 'stepDone', step: 'tr' }, { op: 'stepDone', step: 'dr' }, { op: 'sent', step: 'sn', i: 0, t: 'Use v1.', to: 'team' }] as Cmd[]) j = apply(x, j, c).job
  assert.doesNotMatch(buildPrompt(x, j, 'dr', 'go', {}), /Sent in round/, 'no earlier round')
  j = apply(x, j, { op: 'stepReopen', step: 'tr', why: 'the PO wants v2' }).job
  const p = buildPrompt(x, j, 'dr', 'go', { me: 'Valery' })
  assert.match(p, /## Sent in an earlier round\n### Send it, message 1\nSent in round 1 on \S+: Use v1\./)
  assert.match(p, /- A message this step's draft goes into went out in an earlier round.*resend.*says briefly what changed since then.*the PO wants v2/)
  assert.match(manualText(x, j, 'dr', 'go', {}), /Sent in round 1 on \S+: Use v1\./)
  assert.match(buildPrompt(x, j, 'sn', 'go', {}), /Sent in round 1/, "the step that sends it")
  assert.doesNotMatch(buildPrompt(x, j, 'tr', 'go', {}), /Sent in round|what changed/, 'a step no message of which went out')
})

test('a hand-made session on a step whose draft a later step sends is told to submit the message alone', () => {
  const x = demoCtx(), j = freshJob(x, 'J-1', { t: 'T', key: 'NEW', pb: 'action', prj: 'p', ws: 'acme' })
  const t = manualText(x, j, 'dr', 'go', { me: 'Valery' })
  assert.match(t, /the draft is the message "Send it" sends, word for word: submit_draft's output carries that message alone.*Remarks for Valery go in this session, not in the draft\./)
  assert.doesNotMatch(t, /journal\(\)/)
  assert.doesNotMatch(manualText(x, j, 'tr', 'go', {}), /word for word/)
})

test('a run and a hand-made session are told to link what the draft names, right before submitting, and never to guess a URL', () => {
  const x = demoCtx(), j = freshJob(x, 'J-1', { t: 'T', key: 'NEW', pb: 'action', prj: 'p', ws: 'acme' })
  for (const t of [buildPrompt(x, j, 'tr', 'go', {}), manualText(x, j, 'tr', 'go', {})]) {
    assert.match(t, /- Before you submit, check each thing the draft names as evidence \(a build, pipeline run, release .*PR, commit, work item, chat, mail or page\)/)
    assert.match(t, /write it as a Markdown link with the name as its text: \[build 286944\]\(url\)/)
    assert.match(t, /Never guess one\. Where you know no URL, leave the plain name\./)
    const links = t.indexOf('- Before you submit'), submit = t.search(/- Finish by calling submit_draft/)
    assert.ok(links > 0 && links < submit, 'the links line comes right before the submit line')
  }
})

test('a step whose draft is sent is told to put links on the names in the message, not as bare URLs', () => {
  const x = demoCtx(), j = freshJob(x, 'J-1', { t: 'T', key: 'NEW', pb: 'action', prj: 'p', ws: 'acme' })
  for (const t of [buildPrompt(x, j, 'dr', 'go', {}), manualText(x, j, 'dr', 'go', {})])
    assert.match(t, /word for word.*Links go on the names in the message itself \(the visible text is the name\), never as a list of bare URLs\./)
  assert.doesNotMatch(buildPrompt(x, j, 'tr', 'go', {}), /bare URLs/)
})

test('a run and a hand-made session are told to report a step that is not done, with return_to, instead of a draft that only says so', () => {
  const x = demoCtx(), j = freshJob(x, 'J-1', { t: 'T', key: 'NEW', pb: 'action', prj: 'p', ws: 'acme' })
  for (const t of [buildPrompt(x, j, 'tr', 'go', {}), manualText(x, j, 'tr', 'go', {})]) {
    assert.match(t, /If the step is not finished, or a check or a test failed, .*outcome not_done or failed/)
    assert.match(t, /return_to/)
    assert.match(t, /never marks the step done/)
  }
})

test('the save_source_file line only where runs can save source files', () => {
  const x = demoCtx(), j = freshJob(x, 'J-1', { t: 'T', key: 'NEW', pb: 'action', prj: 'p', ws: 'acme' })
  assert.match(buildPrompt(x, j, 'dr', 'go', { files: true }), /save_source_file\(concept, id, file\)/)
  assert.doesNotMatch(buildPrompt(x, j, 'dr', 'go', {}), /save_source_file/)
})
