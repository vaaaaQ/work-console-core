import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redoText, replyPrompt } from './prompt.ts'

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
