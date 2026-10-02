import '../testkit.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addPb, blankFile, checkPb, pbToFile, toInternal } from './playbookFile.ts'
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
      assert.deepEqual([r.t, r.m, r.x, r.a, r.msg, r.rv, r.out, r.act], [s.t, s.m, s.x, s.a, s.msg, s.rv, s.out, s.act], `${k}/${s.id}`)
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

test('a step keeps its act through download and re-add; a step without one gets no act key', () => {
  const f = blankFile()
  f.phases[0].steps[1].act = 'time'
  assert.deepEqual(checkPb(f), [])
  addPb({ ...f, key: 'acts' })
  try {
    const out = JSON.parse(JSON.stringify(pbToFile('acts'))), [read, done] = out.phases[0].steps
    assert.equal(done.act, 'time')
    assert.ok(!('act' in read), 'a step without an act is written without the key')
    const { pb } = toInternal(out, 'acts2'), [r, d] = pb.ph[0].s
    assert.equal(d.act, 'time')
    assert.ok(!('act' in r), 'and read back without it')
  } finally { delete PB.acts; delete TPL['acts/tell'] }
})

test('checkPb refuses an act that is not a name', () => {
  for (const act of [42, '', '  ', null, ['time'], { n: 'time' }]) {
    const f = blankFile() as any
    f.phases[0].steps[0].act = act
    const e = checkPb(f)
    assert.ok(e.some((x) => x.includes('step 1 “read”: act must be')), `${JSON.stringify(act)} → ${JSON.stringify(e)}`)
  }
})
