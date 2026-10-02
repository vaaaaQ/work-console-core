import '../testkit.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blankFile, checkPb, pbToFile, toInternal } from './playbookFile.ts'
import { PB, TPL } from './world.ts'

test('the blank template is a valid playbook', () => {
  assert.deepEqual(checkPb(blankFile()), [])
})

test('every built-in playbook survives download and re-add', () => {
  for (const k of Object.keys(PB)) {
    const f = pbToFile(k)
    assert.deepEqual(checkPb(f), [], k)
    const { pb, tpl } = toInternal(JSON.parse(JSON.stringify(f)), k)
    assert.equal(pb.n, PB[k].n)
    PB[k].ph.forEach((ph, i) => ph.s.forEach((s, n) => {
      const r = pb.ph[i].s[n]
      assert.equal(r.fid, s.fid || s.id, `${k}/${s.id}`)
      assert.deepEqual([r.t, r.m, r.x, r.a, r.msg, r.rv, r.out], [s.t, s.m, s.x, s.a, s.msg, s.rv, s.out], `${k}/${s.id}`)
      assert.deepEqual(tpl[r.id], TPL[s.id], `${k}/${s.id} messages`)
    }))
  }
})

test('checkPb names each problem', () => {
  assert.deepEqual(checkPb([]), ['The file must be one JSON object.'])
  const e = checkPb({
    format: 'other', name: ' ', phases: [{ code: 'TOOLONG', name: 'Do', steps: [
      { id: 'a', title: 'One', who: 'bot', doneWhen: 'done' },
      { id: 'a', title: 'Two', who: 'you', doneWhen: 'done', messages: [{ via: 'fax', text: 'hi' }] }] }],
  })
  const has = (s: string) => assert.ok(e.some((x) => x.includes(s)), `${s} in ${JSON.stringify(e)}`)
  has('Unknown format'); has('Add a name.'); has('code must be 1–4'); has('who must be'); has('this id is used twice.'); has('via must be chat, work or mail')
})

test('added playbooks prefix their step ids with the key', () => {
  const { pb, tpl } = toInternal(blankFile(), 'mine')
  assert.equal(pb.ph[0].s[0].id, 'mine/read')
  assert.equal(pb.ph[0].s[0].fid, 'read')
  assert.deepEqual(Object.keys(tpl), ['mine/tell'])
  assert.deepEqual(tpl['mine/tell'][0], ['chat', 'team chat', 'hi all,\n{key} is done.'])
})
