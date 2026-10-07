import { test } from 'node:test'
import assert from 'node:assert/strict'
import '../testkit.ts'
import { buildForm, ctxAdd, ctxDel, ctxSet, dueWall, mergeBuild, njJob, njOnce, njPlaybook, njStart, njSteps, shownCtx, stepsOn, wallDue } from './njForm.ts'
import type { BuildForm, Nj } from './njForm.ts'
import { FMT } from './pbFormat.ts'
import type { PbFile } from './pbFormat.ts'
import type { Playbook } from './types.ts'

const pb = (n: string, ws?: string, once?: 1) => ({ n, d: '', ws, ph: [{ c: 'A', n: 'One', s: [{ id: `${n}/a`, t: 'Do', m: 'you', x: 'done' }] }], ...(once ? { once } : {}) }) as unknown as Playbook
const PB: Record<string, Playbook> = { action: pb('Action'), 'dev-item': pb('Dev item', 'acme'), 'once-x': pb('X', 'acme', 1) }
const PBS = ['action', 'dev-item'], PRJ = ['platform', 'web', 'ops']
const file = (name = 'Weekly report', text = '{reply}'): PbFile => ({
  name, phases: [{ code: 'DO', name: 'Do', steps: [
    { id: 'draft', title: 'Draft it', who: 'llm', doneWhen: 'drafted', output: 'reply' },
    { id: 'send', title: 'Send it', who: 'you', doneWhen: 'sent', messages: [{ via: 'chat', text }] }] }],
})
const start = (o: Parameters<typeof njStart>[1] = {}) => njStart('acme', o, PBS, PRJ, PB)
const answer = (o: Partial<BuildForm> = {}): BuildForm => ({ t: '', key: '', prj: '', pb: '', d: '', ctx: [], due: '', npb: null, why: [], ...o })
const opts = (say = ['make it weekly']) => ({ say, pbs: PBS, prjs: PRJ })
const ok = (f: Nj | string) => { assert.equal(typeof f, 'object', String(f)); return f as Nj }

test('njStart: a playbook the workspace offers, else its own first; the first project; where the job comes from', () => {
  const f = start()
  assert.equal(f.pb, 'dev-item'); assert.equal(f.prj, 'platform'); assert.equal(f.ctx, null); assert.deepEqual(f.say, [])
  const g = start({ t: 'Reply', pb: 'action', prj: 'web', chat: 'c4', chatName: 'Sam', src: 'Slack · Sam', due: '2026-10-05T21:00:00.000Z' })
  assert.deepEqual([g.t, g.pb, g.prj, g.chat, g.chatName, g.src, g.due], ['Reply', 'action', 'web', 'c4', 'Sam', 'Slack · Sam', '2026-10-05T21:00:00.000Z'])
  assert.equal(start({ pb: 'once-x', prj: 'mars' }).pb, 'dev-item', "one job's own steps are never offered")
  assert.equal(start({ prj: 'mars' }).prj, 'platform')
  assert.equal('mail' in start(), false, 'nothing it does not come from')
})

test('the context follows the key and the chat until it is changed; steps go to the builder only while picked', () => {
  const f = { ...start({ chat: 'c4', chatName: 'Sam' }), key: 'ACME-12' }
  const ctx = [{ k: 'work', id: 'ACME-12', n: 10, name: 'ACME-12' }, { k: 'chat', id: 'c4', n: 10, name: 'Sam' }]
  assert.deepEqual(shownCtx(f), ctx)
  assert.deepEqual(buildForm(f), { t: '', key: 'ACME-12', prj: 'platform', pb: 'dev-item', d: '', ctx, due: '', npb: null, why: [] })
  const s = njSteps(f, file(), PB)
  assert.equal(stepsOn(s), true); assert.equal(s.pb, 'weekly-report')
  assert.deepEqual(buildForm(s).npb, { once: false, file: file() })
  const c = { ...s, pb: 'action' }
  assert.equal(stepsOn(c), false); assert.equal(buildForm(c).npb, null); assert.equal(buildForm(c).pb, 'action')
  assert.ok(c.npb, 'the steps stay for a switch back')
})

test('mergeBuild takes the answer where the user left the form alone and keeps what they changed while it ran', () => {
  const cur0 = start({ t: 'old' }), sent = buildForm(cur0), cur = { ...cur0, t: 'mine' }
  const note = { k: 'note' as const, id: 'n1', n: 1, name: 'Deploys' }
  const got = answer({ t: 'Theirs', key: 'ACME-7', prj: 'web', pb: 'action', d: '# Goal', due: '2026-10-06T21:00:00.000Z', ctx: [note], why: ['No chat named'] })
  const m = mergeBuild(cur, sent, got, opts())
  assert.deepEqual([m.t, m.key, m.prj, m.pb, m.d, m.due], ['mine', 'ACME-7', 'web', 'action', '# Goal', '2026-10-06T21:00:00.000Z'])
  assert.deepEqual(m.ctx, [note]); assert.deepEqual(m.why, ['No chat named']); assert.deepEqual(m.say, ['make it weekly'])

  const busy = ctxDel({ ...cur0, key: 'ACME-1' }, 'work', 'ACME-1'), s2 = buildForm({ ...cur0, key: 'ACME-1' })
  assert.deepEqual(mergeBuild(busy, s2, got, opts()).ctx, [], 'a context changed during the build is kept')
})

test('mergeBuild: an empty title, key or description and a project or playbook the workspace lacks keep the form', () => {
  const cur = { ...start({ t: 'T', key: 'K', due: '2026-10-05T21:00:00.000Z' }), d: 'D' }
  const m = mergeBuild(cur, buildForm(cur), answer({ prj: 'mars', pb: 'nope', why: ['Project mars is not one of this workspace'] }), opts())
  assert.deepEqual([m.t, m.key, m.prj, m.pb, m.d], ['T', 'K', 'platform', 'dev-item', 'D'])
  assert.equal(m.due, '', 'a due the answer drops is dropped')
  assert.deepEqual(m.why, ['Project mars is not one of this workspace'])
})

test('mergeBuild: new steps get picked; a catalog playbook picked over them keeps them; a pick made during the build stays', () => {
  const f = start(), m1 = mergeBuild(f, buildForm(f), answer({ pb: 'weekly-report', npb: { once: true, file: file() } }), opts())
  assert.deepEqual(m1.npb, { key: 'weekly-report', once: true, file: file() }); assert.equal(stepsOn(m1), true)
  const m2 = mergeBuild(m1, buildForm(m1), answer({ pb: 'action' }), opts(['a', 'b']))
  assert.equal(m2.pb, 'action'); assert.equal(stepsOn(m2), false); assert.deepEqual(m2.npb, m1.npb)
  const mine = { ...m1, pb: 'dev-item' }
  assert.equal(mergeBuild(mine, buildForm(m1), answer({ pb: 'action' }), opts()).pb, 'dev-item')
  const same = mergeBuild(m1, buildForm(m1), answer({ pb: 'weekly-report', npb: { once: true, file: file('Renamed') } }), opts())
  assert.equal(same.npb!.file.name, 'Renamed', 'rewritten steps replace the old ones under their key')
})

test("njOnce: one job's steps get once- in front, past a key in use; the pick follows the steps", () => {
  const f = njSteps(start(), file('X'), PB)
  assert.equal(f.pb, 'x')
  const o = njOnce(f, true, PB)
  assert.deepEqual([o.npb!.key, o.npb!.once, o.pb], ['once-x-2', true, 'once-x-2'])
  assert.deepEqual([njOnce(o, false, PB).npb!.key, njOnce(o, false, PB).pb], ['x', 'x'])
  const c = njOnce({ ...f, pb: 'action' }, true, PB)
  assert.equal(c.pb, 'action'); assert.equal(c.npb!.key, 'once-x-2')
  assert.equal(njOnce(o, true, PB), o)
})

test('njSteps: steps edited by hand keep their key and once, and get picked', () => {
  const o = njOnce(njSteps(start(), file('X'), PB), true, PB), e = njSteps({ ...o, pb: 'action' }, file('Renamed'), PB)
  assert.deepEqual([e.npb!.key, e.npb!.once, e.pb, e.npb!.file.name], ['once-x-2', true, 'once-x-2', 'Renamed'])
})

test("njPlaybook: the steps as the workspace's playbook, hidden when once; problems hold it back", () => {
  const p = njPlaybook(njOnce(njSteps(start(), file(), PB), true, PB))
  assert.deepEqual(p.errs, [])
  assert.equal(p.key, 'once-weekly-report'); assert.equal(p.file.format, FMT); assert.equal(p.file.workspace, 'acme'); assert.equal(p.file.key, p.key)
  assert.equal(p.pb!.once, 1); assert.equal(p.pb!.ws, 'acme'); assert.equal(p.pb!.custom, 1)
  assert.deepEqual(p.tpl, { 'once-weekly-report/send': [['chat', '', '{reply}']] })
  assert.equal(njPlaybook(njSteps(start(), file(), PB)).pb!.once, undefined)
  const bad = njPlaybook(njSteps(start(), file('Bad', 'hi {nope}'), PB))
  assert.equal(bad.pb, null); assert.match(bad.errs.join('\n'), /names \{nope\}, which no step fills/)
})

test('njJob: a description and a context only when there are; NEW for no key; where the job comes from goes along', () => {
  const f = { ...start({ chat: 'c4', chatName: 'Sam', src: 'Slack', due: '2026-10-05T21:00:00.000Z' }), t: ' Reply ' }
  assert.deepEqual(njJob(f), { t: 'Reply', key: 'NEW', pb: 'dev-item', prj: 'platform', ws: 'acme', src: 'Slack', chat: 'c4', chatName: 'Sam', due: '2026-10-05T21:00:00.000Z' })
  const g = ctxDel({ ...f, d: '  # Why  ' }, 'chat', 'c4')
  assert.equal(njJob(g).d, '# Why'); assert.deepEqual(njJob(g).ctx, [], 'an emptied list is kept as empty')
})

test('the context list: work items by key, no doubles, counts in range, the defaults kept when it is first changed', () => {
  const f = start({ chat: 'c4', chatName: 'Sam' })
  assert.equal(ctxAdd(f, 'work', 'acme-12'), 'acme-12 is not a work item.')
  assert.equal(ctxAdd(f, 'chat', ' '), 'Pick a chat.')
  const w = ok(ctxAdd(f, 'work', ' ACME-12 ', 5))
  assert.deepEqual(w.ctx, [{ k: 'chat', id: 'c4', n: 10, name: 'Sam' }, { k: 'work', id: 'ACME-12', n: 5, name: 'ACME-12' }])
  assert.equal(ctxAdd(w, 'work', 'ACME-12'), 'That work item is already in the context.')
  assert.match(String(ctxAdd(w, 'work', 'ACME-1', 99)), /1–20/)
  const n = ok(ctxAdd(w, 'note', 'n1', undefined, 'Deploys'))
  assert.deepEqual(n.ctx!.at(-1), { k: 'note', id: 'n1', n: 1, name: 'Deploys' })
  assert.equal(ctxSet(n, 'work', 'ACME-12', 15).ctx![1].n, 15)
  assert.equal(ctxSet(n, 'work', 'ACME-12', 0), n); assert.equal(ctxSet(n, 'note', 'n1', 2), n)
  assert.deepEqual(ctxDel(n, 'chat', 'c4').ctx!.map((c) => c.id), ['ACME-12', 'n1'])
})

test('due: the field shows and takes the home zone’s wall time', () => {
  assert.equal(dueWall('2026-10-05T21:00:00.000Z'), '2026-10-05T18:00')
  assert.equal(wallDue('2026-10-05T18:00'), '2026-10-05T21:00:00.000Z')
  assert.equal(wallDue('2026-10-05T18:00:30'), '2026-10-05T21:00:00.000Z')
  for (const x of ['', 'nope']) assert.equal(dueWall(x), '')
  for (const x of ['', '2026-10-05', '18:00']) assert.equal(wallDue(x), '')
})

test('buildForm carries the blocker; mergeBuild keeps a plan edited during the build and takes the link', () => {
  const bl = { j: 'A-6', step: 'tr', plan: '', link: null }
  const f0: Nj = { ...start(), bl }
  const sent = buildForm(f0)
  assert.deepEqual(sent.bl, bl)
  const got = { ...sent, bl: { j: 'A-6', step: 'dr', plan: 'from the builder', link: { j: 'A-7', why: 'same' } } }
  assert.deepEqual(mergeBuild(f0, sent, got, { say: ['x'], pbs: ['action'], prjs: ['ops'] }).bl, got.bl)
  const edited = { ...f0, bl: { ...bl, plan: 'mine' } }
  assert.deepEqual(mergeBuild(edited, sent, got, { say: ['x'], pbs: ['action'], prjs: ['ops'] }).bl, { ...bl, plan: 'mine', link: { j: 'A-7', why: 'same' } })
})
