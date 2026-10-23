import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as T from '../../src/model/transitions.ts'
import { Bus, HttpError } from '../events.ts'
import type { Ev } from '../events.ts'
import { Jobs } from '../jobs/jobs.ts'
import { fileStore } from '../store/file.ts'
import { demoCtx, demoSeed, fakeSdk } from '../testkit.ts'
import { GatewayError } from '../bridge/wire.ts'
import type { ActReq, ActRes, ConceptReply } from '../bridge/wire.ts'
import { notesStore } from '../knowledge/notes.ts'
import { resolveContext } from './context.ts'
import { buildPrompt } from './prompt.ts'
import { Runner, safeName } from './runner.ts'
import { tempDir } from '../testdirs.ts'

const tick = () => new Promise((r) => setTimeout(r, 20))
async function until(f: () => boolean | Promise<boolean>) { const t0 = Date.now(); while (!(await f())) { if (Date.now() - t0 > 2000) throw new Error('timed out'); await tick() } }

function setup(open = { v: true }, extra: Partial<ConstructorParameters<typeof Runner>[0]> = {}) {
  const dir = tempDir('run')
  const store = fileStore(join(dir, 's.json'), demoSeed)
  const bus = new Bus(), evs: Ev[] = []
  bus.on((e) => evs.push(e))
  const jobs = new Jobs({ store, bus, ctx: demoCtx, gate: () => open.v })
  const { sdk, sessions } = fakeSdk()
  const mk = () => new Runner({ store, jobs, bus, sdk, cwd: dir, gate: () => open.v, artifactsDir: join(dir, 'arts'), ctx: demoCtx, ...extra })
  return { store, jobs, bus, evs, sessions, runner: mk(), mk, open, dir }
}
/** a fresh action job, started: its first step tr is current */
async function started(jobs: Jobs) {
  const j = await jobs.create({ t: 'Auto', key: 'K-1', pb: 'action', prj: 'p', ws: 'acme' })
  return (await jobs.cmd(j.id, { op: 'start' }, j.v)).job
}
/** four open steps without a run, on different jobs where possible */
async function targets(jobs: Jobs, n: number) {
  const x = demoCtx(), out: { job: string; step: string }[] = []
  for (const j of await jobs.all()) {
    if (T.isClosed(j) || j.st === 'recurring') continue
    for (const s of T.steps(x, j.pb)) if (j.flow[s.id] && T.isLive(j.flow[s.id]) && !j.flow[s.id].run && out.length < n) out.push({ job: j.id, step: s.id })
  }
  assert.ok(out.length >= n, 'the demo has enough open steps')
  return out
}
const code = (status: number, c?: string) => (e: unknown) => e instanceof HttpError && e.status === status && (!c || e.code === c)
const state = async (r: Runner, id: string) => (await r.get(id))!.state

test('four asks: three run, one waits, and it starts when a slot frees', async () => {
  const { runner, sessions, jobs } = setup(), t = await targets(jobs, 4)
  const rs = []
  for (const x of t) rs.push(await runner.ask(x.job, x.step, 'do it'))
  await until(() => sessions.length === 3)
  assert.equal(await state(runner, rs[3].id), 'queued')
  assert.match(sessions[0].prompt, /do it/)
  assert.ok((await jobs.get(t[0].job))!.flow[t[0].step].run, 'the step shows a run')
  await sessions[0].tools.submitDraft('the draft'); sessions[0].end()
  await until(() => sessions.length === 4)
  assert.equal(await state(runner, rs[0].id), 'draft')
  assert.equal(await state(runner, rs[3].id), 'running')
})

test('submit_draft: run draft, step waits with the draft; a second draft is refused', async () => {
  const { runner, sessions, jobs } = setup(), [t] = await targets(jobs, 1), seen: string[] = []
  runner.onSettled((r) => seen.push(r.state))
  const r = await runner.ask(t.job, t.step, 'draft please')
  await until(() => sessions.length === 1)
  await sessions[0].tools.submitDraft('Here is the answer.')
  await assert.rejects(sessions[0].tools.submitDraft('again'))
  sessions[0].end()
  await until(() => seen.length > 0)
  await tick(); await tick()
  const f = (await jobs.get(t.job))!.flow[t.step]
  assert.equal(f.s, 'wait'); assert.equal(f.dr!.t, 'Here is the answer.'); assert.equal(f.run, null)
  assert.equal((await runner.get(r.id))!.ended != null, true)
  assert.deepEqual(seen, ['draft'])
})

test('a session that ends without a draft fails with a reason; a result error is the reason', async () => {
  const { runner, sessions, jobs } = setup(), [a, b] = await targets(jobs, 2)
  const r1 = await runner.ask(a.job, a.step, 'q'), r2 = await runner.ask(b.job, b.step, 'q'), seen: string[] = []
  runner.onSettled((r) => seen.push(r.state))
  await until(() => sessions.length === 2)
  sessions[0].end()
  sessions[1].end(false, 'rate_limit')
  await until(() => seen.length === 2)
  assert.equal((await runner.get(r1.id))!.reason, 'the session ended without a draft')
  assert.deepEqual([(await runner.get(r2.id))!.state, (await runner.get(r2.id))!.reason], ['failed', 'rate_limit'])
  assert.equal((await jobs.get(a.job))!.flow[a.step].run, null)
})

test('cancel: a running run aborts the SDK; a queued one never starts', async () => {
  const { runner, sessions, jobs } = setup(), t = await targets(jobs, 4)
  const rs = []
  for (const x of t) rs.push(await runner.ask(x.job, x.step, 'q'))
  await until(() => sessions.length === 3)
  const c = await runner.cancel(rs[0].id)
  assert.equal(c.state, 'cancelled')
  assert.ok(sessions[0].abort.signal.aborted)
  assert.equal((await jobs.get(t[0].job))!.flow[t[0].step].run, null)
  await until(() => sessions.length === 4) // the freed slot goes to the queued run
  const r5 = (await targets(jobs, 1))[0]
  const q = await runner.ask(r5.job, r5.step, 'q')
  assert.equal((await runner.cancel(q.id)).state, 'cancelled')
  await tick()
  assert.equal(sessions.length, 4)
  await assert.rejects(runner.cancel(q.id), code(409))
})

test('recover turns running and queued runs into interrupted', async () => {
  const { runner, sessions, jobs, mk } = setup(), t = await targets(jobs, 4)
  const rs = []
  for (const x of t) rs.push(await runner.ask(x.job, x.step, 'q'))
  await until(() => sessions.length === 3)
  const after = mk() // a restarted backend over the same store
  await after.recover()
  for (const r of rs) assert.equal(await state(after, r.id), 'interrupted')
  assert.equal((await jobs.get(t[3].job))!.flow[t[3].step].run, null)
})

test('resume continues the stored session; without a session it is 409', async () => {
  const { runner, sessions, jobs, open, evs } = setup(), [a, b] = await targets(jobs, 2)
  const r = await runner.ask(a.job, a.step, 'q')
  await until(() => sessions.length === 1)
  sessions[0].push({ k: 'session', id: 'sess-1' })
  await tick()
  assert.equal((await runner.get(r.id))!.session, 'sess-1')
  await runner.interruptAll('the bridge went away')
  assert.equal(await state(runner, r.id), 'interrupted')
  open.v = false
  await assert.rejects(runner.resume(r.id), code(503))
  open.v = true
  const back = await runner.resume(r.id)
  assert.equal(back.state, 'queued')
  await until(() => sessions.length === 2)
  assert.equal(sessions[1].resume, 'sess-1')
  assert.ok((await jobs.get(a.job))!.jr.some((e) => /Resumed the LLM run/.test(e.o)))

  const r2 = await runner.ask(b.job, b.step, 'q')
  await until(() => sessions.length === 3)
  sessions[2].end()
  await until(() => evs.some((e) => e.kind === 'run' && e.run.id === r2.id && e.run.state === 'failed'))
  assert.equal(await state(runner, r2.id), 'failed')
  await assert.rejects(runner.resume(r2.id), code(409, 'no_session'))
})

test('with autoResume an interrupted run is due once: resumeDue continues its session signed console, a second interruption waits', async () => {
  const s = setup(undefined, { autoResume: true }), j = await started(s.jobs)
  const r = await s.runner.ask(j.id, 'tr', 'q', { auto: true })
  assert.equal((await s.jobs.get(j.id))!.jr[0].a, 'console')
  await until(() => s.sessions.length === 1)
  s.sessions[0].push({ k: 'session', id: 'sess-1' })
  await tick()
  await s.runner.interruptAll('the bridge went away')
  assert.deepEqual([await state(s.runner, r.id), (await s.runner.get(r.id))!.ar], ['interrupted', 'due'])
  assert.equal((await s.jobs.get(j.id))!.jr[0].n, 'nothing; it resumes by itself when the console is back.')
  await s.runner.resumeDue()
  await until(() => s.sessions.length === 2)
  assert.equal(s.sessions[1].resume, 'sess-1')
  assert.equal((await s.runner.get(r.id))!.ar, 'used')
  const line = (await s.jobs.get(j.id))!.jr[0]
  assert.deepEqual([line.a, line.o, line.c], ['console', 'Resumed the LLM run for “Understand the request”.', 'LLM run continues its session by itself.'])
  await s.runner.interruptAll('the bridge went away again')
  assert.deepEqual([await state(s.runner, r.id), (await s.runner.get(r.id))!.ar], ['interrupted', 'used'])
  assert.equal((await s.jobs.get(j.id))!.jr[0].n, 'resume it when the console is back.')
  await s.runner.resumeDue(); await tick()
  assert.equal(s.sessions.length, 2, 'it waits for the user')
})

test('a due run that never started a session starts afresh with the same instruction; a queued one waits its turn', async () => {
  const s = setup(undefined, { autoResume: true, max: 1 }), a = await started(s.jobs), b = await started(s.jobs)
  const ra = await s.runner.ask(a.id, 'tr', 'first'), rb = await s.runner.ask(b.id, 'tr', 'second')
  await until(() => s.sessions.length === 1)
  await s.runner.interruptAll('the bridge went away')
  assert.deepEqual([(await s.runner.get(ra.id))!.ar, (await s.runner.get(rb.id))!.ar], ['due', 'due'])
  await s.runner.resumeDue()
  await until(() => s.sessions.length === 2)
  assert.equal(s.sessions[1].resume, undefined)
  assert.match(s.sessions[1].prompt, /first/)
  assert.equal(await state(s.runner, rb.id), 'queued')
  const line = (await s.jobs.get(a.id))!.jr[0]
  assert.deepEqual([line.a, line.o, line.c], ['console', 'Asked the LLM for “Understand the request”.', 'LLM run started by itself.'])
})

test('resumeDue uses up and skips a due run whose job closed, whose step moved on, or that has a newer run', async () => {
  const s = setup(undefined, { autoResume: true }), js = [await started(s.jobs), await started(s.jobs), await started(s.jobs), await started(s.jobs)]
  const rs = []
  for (const j of js) rs.push(await s.runner.ask(j.id, 'tr', 'q'))
  await until(() => s.sessions.length === 3)
  await s.runner.interruptAll('the bridge went away')
  const [a, b, c] = js
  await s.jobs.cmd(a.id, { op: 'close', st: 'cancelled' }, (await s.jobs.get(a.id))!.v)
  await s.jobs.cmd(b.id, { op: 'stepDone', step: 'tr' }, (await s.jobs.get(b.id))!.v)
  const newer = await s.runner.ask(c.id, 'tr', 'again')
  await until(() => s.sessions.length === 4)
  await s.runner.cancel(newer.id)
  await s.runner.resumeDue()
  await until(() => s.sessions.length === 5)
  await tick()
  assert.equal(s.sessions.length, 5, 'only the fourth resumes')
  assert.deepEqual(await Promise.all(rs.map(async (r) => [await state(s.runner, r.id), (await s.runner.get(r.id))!.ar])),
    [['interrupted', 'used'], ['interrupted', 'used'], ['interrupted', 'used'], ['running', 'used']])
})

test('without autoResume nothing is due and resumeDue does nothing', async () => {
  const s = setup(), j = await started(s.jobs)
  const r = await s.runner.ask(j.id, 'tr', 'q')
  await until(() => s.sessions.length === 1)
  s.sessions[0].push({ k: 'session', id: 'sess-1' })
  await tick()
  await s.runner.interruptAll('the bridge went away')
  assert.equal((await s.runner.get(r.id))!.ar, undefined)
  assert.equal((await s.jobs.get(j.id))!.jr[0].n, 'resume it when the console is back.')
  await s.runner.resumeDue(); await tick()
  assert.equal(s.sessions.length, 1)
})

test('a second ask on the same step is 409; with the bridge down an ask is 503', async () => {
  const { runner, jobs, open } = setup(), [t] = await targets(jobs, 1)
  await runner.ask(t.job, t.step, 'q')
  await assert.rejects(runner.ask(t.job, t.step, 'q'), code(409, 'run_exists'))
  open.v = false
  const [u] = await targets(jobs, 1)
  await assert.rejects(runner.ask(u.job, u.step, 'q'), code(503))
})

test('interruptAll stops running sessions and empties the queue', async () => {
  const { runner, sessions, jobs } = setup(), t = await targets(jobs, 4)
  const rs = []
  for (const x of t) rs.push(await runner.ask(x.job, x.step, 'q'))
  await until(() => sessions.length === 3)
  await runner.interruptAll('A down')
  for (const r of rs) assert.equal(await state(runner, r.id), 'interrupted')
  assert.ok(sessions.every((s) => s.abort.signal.aborted))
  await tick()
  assert.equal(sessions.length, 3)
})

test('the feed keeps the last 200 lines and is dropped when the run ends; tools write the job', async () => {
  const { runner, sessions, jobs, evs, dir } = setup(), [t] = await targets(jobs, 1)
  const r = await runner.ask(t.job, t.step, 'q')
  await until(() => sessions.length === 1)
  for (let i = 0; i < 250; i++) sessions[0].push({ k: 'text', t: `line ${i}` })
  sessions[0].push({ k: 'tool', name: 'mcp__bridge__bridge_get', input: '{"concept":"work"}' })
  await until(() => runner.feed(r.id).at(-1)?.startsWith('→ mcp__bridge__bridge_get') === true)
  assert.equal(runner.feed(r.id).length, 200)
  assert.equal(runner.feed(r.id)[0], 'line 51')
  assert.ok(evs.filter((e) => e.kind === 'feed').length >= 251)
  await sessions[0].tools.journal('read the item', 'nothing', 'draft')
  await sessions[0].tools.addArtifact('../analysis.md', '# A')
  const j = (await jobs.get(t.job))!
  assert.ok(j.jr.some((e) => e.o === 'read the item' && e.a === 'LLM'))
  assert.ok(j.flow[t.step].arts.some((a) => a.n === 'analysis.md' && a.link!.endsWith('/analysis.md')))
  assert.equal(readFileSync(join(dir, 'arts', t.job, 'analysis.md'), 'utf8'), '# A')
  await sessions[0].tools.submitDraft('d'); sessions[0].end()
  await until(() => runner.feed(r.id).length === 0)
})

test('safeName keeps artifacts inside the job folder', () => {
  assert.equal(safeName('../../x.md'), 'x.md')
  assert.equal(safeName('a/b\\c.md'), 'c.md')
  assert.equal(safeName('C:notes?.md'), 'C_notes_.md')
  assert.throws(() => safeName('...'))
})

test('safeName prefixes a Windows device name, whatever its case or extension', () => {
  assert.equal(safeName('con.pdf'), '_con.pdf')
  assert.equal(safeName('NUL'), '_NUL')
  assert.equal(safeName('Com1.tar.gz'), '_Com1.tar.gz')
  assert.equal(safeName('lpt9.txt'), '_lpt9.txt')
  assert.equal(safeName('console.pdf'), 'console.pdf')
  assert.equal(safeName('com10.pdf'), 'com10.pdf')
})

test('a run cancelled before its session starts settles as cancelled and never opens one', async () => {
  const { runner, sessions, jobs } = setup(), [t] = await targets(jobs, 1)
  const r = await runner.ask(t.job, t.step, 'q')
  const c = await runner.cancel(r.id)
  assert.equal(c.state, 'cancelled')
  await until(() => !runner['live'].has(r.id))
  assert.equal(await state(runner, r.id), 'cancelled')
  assert.equal(sessions.length, 0)
  assert.equal((await jobs.get(t.job))!.flow[t.step].run, null)
})

test('recover after a reconnect leaves the runs this process still holds', async () => {
  const { runner, jobs, sessions } = setup()
  for (const t of await targets(jobs, 4)) await runner.ask(t.job, t.step, 'go')
  await until(() => sessions.length === 3)
  for (let i = 0; i < 100 && (await runner.all()).filter((r) => r.state === 'running').length < 3; i++) await tick()
  await runner.recover('the bridge went away')
  assert.deepEqual((await runner.all()).map((r) => r.state).sort(), ['queued', 'running', 'running', 'running'])
})

test('a store that fails while a run settles does not take the console down', async () => {
  const dir = tempDir('run')
  const base = fileStore(join(dir, 's.json'), demoSeed), fail = { v: false }
  const store = { ...base, putRun: async (r: Parameters<typeof base.putRun>[0]) => { if (fail.v) throw new Error('B is away'); return base.putRun(r) } }
  const bus = new Bus(), jobs = new Jobs({ store, bus, ctx: demoCtx, gate: () => true })
  const { sdk, sessions } = fakeSdk()
  const runner = new Runner({ store, jobs, bus, sdk, cwd: dir, gate: () => true, artifactsDir: join(dir, 'arts'), ctx: demoCtx })
  const [t, u] = await targets(jobs, 2)
  await runner.ask(t.job, t.step, 'go')
  await until(() => sessions.length === 1)
  fail.v = true
  sessions[0].end(false, 'boom')
  await tick(); await tick()
  fail.v = false
  await runner.ask(u.job, u.step, 'again')
  await until(() => sessions.length === 2)
})

test('interruptAll aborts every live session even when the store rejects every write', async () => {
  const dir = tempDir('run')
  const base = fileStore(join(dir, 's.json'), demoSeed), fail = { v: false }
  const store = { ...base, putRun: async (r: Parameters<typeof base.putRun>[0]) => { if (fail.v) throw new Error('B is away'); return base.putRun(r) } }
  const bus = new Bus(), jobs = new Jobs({ store, bus, ctx: demoCtx, gate: () => true })
  const { sdk, sessions } = fakeSdk()
  const runner = new Runner({ store, jobs, bus, sdk, cwd: dir, gate: () => true, artifactsDir: join(dir, 'arts'), ctx: demoCtx })
  for (const t of await targets(jobs, 2)) await runner.ask(t.job, t.step, 'go')
  await until(() => sessions.length === 2)
  for (let i = 0; i < 100 && (await runner.all()).filter((r) => r.state === 'running').length < 2; i++) await tick()
  fail.v = true
  const log = console.error, logged: string[] = []
  console.error = (...a: unknown[]) => { logged.push(a.join(' ')) }
  try { await runner.interruptAll('the bridge went away'); await tick() } finally { console.error = log }
  assert.deepEqual(sessions.map((s) => s.abort.signal.aborted), [true, true])
  assert.ok(logged.some((l) => /not marked interrupted/.test(l)), 'the failed writes are logged once')
})

test("a new run's prompt carries the job's context; an unreadable item is a line, a resumed run reads none", async () => {
  const { store, jobs, bus, sessions, dir } = setup(), [t] = await targets(jobs, 1), seen: string[] = []
  await jobs.cmd(t.job, { op: 'ctxAdd', k: 'work', id: 'ACME-999' })
  await jobs.cmd(t.job, { op: 'ctxAdd', k: 'chat', id: 'c-gone', name: 'Old chat' })
  const b = {
    get: async (concept: string, id: string): Promise<ConceptReply> => {
      seen.push(`${concept}/${id}`)
      if (concept === 'chat') throw new GatewayError(504, 'timeout', 'the chat read timed out')
      return { status: 'ok', rev: 1, items: { title: 'Limiter ignores the token header', comments: [{ author: 'Ann', at: '2026-09-30T09:00:00Z', text: 'still there' }] } }
    },
  }
  const runner = new Runner({ store, jobs, bus, sdk: fakeSdk(sessions).sdk, cwd: dir, gate: () => true, artifactsDir: join(dir, 'arts'), ctx: demoCtx, context: (j) => resolveContext(b, j) })
  const r = await runner.ask(t.job, t.step, 'q')
  await until(() => sessions.length === 1)
  const p = sessions[0].prompt
  assert.match(p, /## Context\n[\s\S]*### Work item ACME-999 \(last 10 comments\)\nWork item ACME-999: Limiter ignores the token header\n[\s\S]*- 2026-09-30 09:00Z Ann: still there/)
  assert.match(p, /### Chat Old chat \(last 10 messages\) — unavailable\nthe chat read timed out/)
  const at = (h: string) => p.indexOf(h)
  assert.ok(at('## Job') < at('## Context') && at('## Context') < at('## How to work') && at('## How to work') < at('## Instruction (from the user)\nq'))
  sessions[0].push({ k: 'session', id: 'sess-1' })
  await tick()
  await runner.interruptAll('the bridge went away')
  const n = seen.length
  await runner.resume(r.id)
  await until(() => sessions.length === 2)
  assert.equal(seen.length, n, 'a resumed run reads no context')
})

test("a new run gets the pictures its context's text names, before its prompt; context() gives them again; a resumed run gets none", async () => {
  const { store, jobs, bus, sessions, dir } = setup(), [t] = await targets(jobs, 1)
  await jobs.cmd(t.job, { op: 'ctxAdd', k: 'work', id: 'ACME-999', name: 'Limiter' })
  const b = {
    get: async (concept: string, id: string): Promise<ConceptReply> => concept === 'image'
      ? { status: 'ok', rev: 1, items: { name: 'banner.png', mime: 'image/png', data: 'UE5H', width: 1, height: 1 } }
      : { status: 'ok', rev: 1, items: id === 'ACME-999'
        ? { title: 'Limiter', description: 'The banner: [image 1]', comments: [], images: [{ ref: 'r1', name: 'banner.png', from: 'description' }] }
        : { title: 'Its own item', comments: [] } },
  }
  const runner = new Runner({ store, jobs, bus, sdk: fakeSdk(sessions).sdk, cwd: dir, gate: () => true, artifactsDir: join(dir, 'arts'), ctx: demoCtx, context: (j) => resolveContext(b, j) })
  const r = await runner.ask(t.job, t.step, 'q')
  await until(() => sessions.length === 1)
  const pic = { label: '[image 1] Limiter, description: banner.png', mime: 'image/png', data: 'UE5H' }
  assert.deepEqual(sessions[0].images, [pic])
  assert.match(sessions[0].prompt, /Description:\nThe banner: \[image 1\]\n/)
  assert.match(sessions[0].prompt, /\n- \[image N\] in the text is the picture labelled \[image N\] before this text\.\n/)
  const again = await sessions[0].tools.context!()
  assert.deepEqual(again.images, [pic])
  assert.match(again.text, /The banner: \[image 1\]/)
  sessions[0].push({ k: 'session', id: 'sess-1' })
  await tick()
  await runner.interruptAll('the bridge went away')
  await runner.resume(r.id)
  await until(() => sessions.length === 2)
  assert.equal(sessions[1].images, undefined, 'a resumed session already has them')
})

/* a fixed job, so the prompt text can be compared word for word */
function promptJob() {
  const j = demoSeed().jobs!.find((x) => x.id === 'J-0420')!
  j.jr = [{ ts: '2026-10-01T09:00:00.000Z', a: 'you', o: 'Created the job', c: 'playbook Action', n: 'work on the last step' }]
  return j
}
/* the whole prompt of a job without context, notes or a description */
const PROMPT = [
  "You are working one step of a job in the user's Work Console.",
  '',
  '## Job J-0420: Reply to Sam about rate limiting',
  'Key: CHAT · playbook: Action · project: platform',
  'Step: Send it',
  'Exit criterion: Sent',
  '',
  '## Earlier outputs',
  '### Draft the answer',
  'hi Sam,',
  'rate limiting is in review (PR #482), one approval left. I will write here once it is on staging.',
  '',
  '## Journal (oldest first)',
  '- 2026-10-01T09:00:00.000Z you: Created the job → playbook Action Next: work on the last step',
  '',
  '## How to work',
  '- Everything above was read for this step when the run started: work from it, and use tools only for what it does not cover.',
  '- Read anything else from the sources with the bridge tools (bridge_snapshot, bridge_get).',
  '- context() returns these sections again, read anew, when a long run needs them back.',
  '- You never send anything to a source (no chat posts, mails, votes, comments or state changes): the user sends after review.',
  '- Write progress with the run tool journal(observed, changed, next) at meaningful points.',
  "- If something only the user can decide holds part of the step, ask it with ask_question, one question per call, rather than only in the draft's text; then finish the draft as far as it goes.",
  '- Save files the step expects with add_artifact(name, content), or with add_artifact_file(path) for a file already under your working dir; images show on the page.',
  '- Before you submit, check each thing the draft names as evidence (a build, pipeline run, release or its failed stage or log, a PR, commit, work item, chat, mail or page). Where you know its URL, write it as a Markdown link with the name as its text: [build 286944](url), not "build 286944" with the URL next to it or left out. A URL you know is one you fetched while working, one the context or knowledge above gives, or one you build from a pattern a knowledge note gives. Never guess one. Where you know no URL, leave the plain name.',
  '- Finish by calling submit_draft(text) exactly once with the draft for the user to review. Without it the run counts as failed.',
  '- If the step is not finished, or a check or a test failed, call submit_draft with outcome not_done or failed, and name in return_to the earlier step the job should go back to, if any (id or exact title), with why: accepting such a draft never marks the step done.',
  '',
  '## Instruction (from the user)',
  'Draft the reply.',
].join('\n')

test('a prompt names the user it was given; without one it says the user', () => {
  const x = demoCtx(), j = promptJob()
  assert.equal(buildPrompt(x, j, 'sn', 'Draft the reply.'), PROMPT)
  assert.equal(buildPrompt(x, j, 'sn', 'Draft the reply.', { me: 'the user' }), PROMPT)
  assert.equal(buildPrompt(x, j, 'sn', 'Draft the reply.', { me: '' }), PROMPT, 'an empty name is no name')
  const p = buildPrompt(x, j, 'sn', 'Draft the reply.', { me: 'Alex' })
  assert.match(p, /in Alex's Work Console/)
  assert.match(p, /: Alex sends after review\./)
  assert.match(p, /the draft for Alex to review\./)
  assert.match(p, /## Instruction \(from Alex\)\nDraft the reply\.$/)
  assert.ok(!/the user/.test(p), 'no phrase still says "the user"')
  assert.equal(p, PROMPT.replaceAll('the user', 'Alex'))
})

test("the user's part comes last, the description before the instruction; the journal is the latest 20, oldest first", () => {
  const x = demoCtx(), j = promptJob()
  j.d = 'Sam asked twice.\n\n- keep it short'
  j.jr = Array.from({ length: 25 }, (_, i) => ({ ts: `2026-10-01T09:${String(24 - i).padStart(2, '0')}:00.000Z`, a: 'you', o: `entry ${24 - i}`, c: '-', n: '-' }))
  const p = buildPrompt(x, j, 'sn', 'Draft the reply.')
  assert.ok(p.endsWith('submit_draft(text) exactly once with the draft for the user to review. Without it the run counts as failed.\n'
    + '- If the step is not finished, or a check or a test failed, call submit_draft with outcome not_done or failed, and name in return_to the earlier step the job should go back to, if any (id or exact title), with why: accepting such a draft never marks the step done.\n\n'
    + '## Description (from the user)\nSam asked twice.\n\n- keep it short\n\n## Instruction (from the user)\nDraft the reply.'), p.slice(-400))
  assert.match(p, /## Journal \(oldest first; the latest 20 of 25\)\n- 2026-10-01T09:05:00\.000Z you: entry 5 → - Next: -\n/)
  assert.ok(p.indexOf('entry 5 ') < p.indexOf('entry 24 '))
  assert.doesNotMatch(p, /entry 4 /)
})

test("a runner told who the user is puts the name in a new run's prompt", async () => {
  const named = setup(), [t] = await targets(named.jobs, 1)
  const runner = new Runner({ store: named.store, jobs: named.jobs, bus: named.bus, sdk: fakeSdk(named.sessions).sdk, cwd: named.dir, gate: () => true, artifactsDir: join(named.dir, 'arts'), ctx: demoCtx, me: 'Alex' })
  await runner.ask(t.job, t.step, 'q')
  await until(() => named.sessions.length === 1)
  assert.match(named.sessions[0].prompt, /in Alex's Work Console/)
  assert.match(named.sessions[0].prompt, /the draft for Alex to review/)
  const plain = setup(), [u] = await targets(plain.jobs, 1)
  await plain.runner.ask(u.job, u.step, 'q')
  await until(() => plain.sessions.length === 1)
  assert.match(plain.sessions[0].prompt, /in the user's Work Console/)
  const blank = setup(), [v] = await targets(blank.jobs, 1)
  await new Runner({ store: blank.store, jobs: blank.jobs, bus: blank.bus, sdk: fakeSdk(blank.sessions).sdk, cwd: blank.dir, gate: () => true, artifactsDir: join(blank.dir, 'arts'), ctx: demoCtx, me: '' }).ask(v.job, v.step, 'q')
  await until(() => blank.sessions.length === 1)
  assert.match(blank.sessions[0].prompt, /in the user's Work Console/)
})

test("a run's request_access is signed by its job and step, at most 3 a run; without access there is none", async () => {
  const s = setup(), [t] = await targets(s.jobs, 1), seen: string[] = []
  const access = async (_add: unknown, reason: string, by: string) => { seen.push(`${by} ${reason}`); return 'asked' }
  const runner = new Runner({ store: s.store, jobs: s.jobs, bus: s.bus, sdk: fakeSdk(s.sessions).sdk, cwd: s.dir, gate: () => true, artifactsDir: join(s.dir, 'arts'), ctx: demoCtx, access })
  await runner.ask(t.job, t.step, 'q')
  await until(() => s.sessions.length === 1)
  const tools = s.sessions[0].tools
  for (let i = 0; i < 3; i++) assert.equal(await tools.requestAccess!({ hosts: ['a.example'] }, `r${i}`), 'asked')
  await assert.rejects(tools.requestAccess!({ hosts: ['a.example'] }, 'r3'), /already asked 3 times/)
  assert.deepEqual(seen, [0, 1, 2].map((i) => `${t.job}/${t.step} r${i}`))
  const plain = setup(), [u] = await targets(plain.jobs, 1)
  await plain.runner.ask(u.job, u.step, 'q')
  await until(() => plain.sessions.length === 1)
  assert.equal(plain.sessions[0].tools.requestAccess, undefined)
})

test("a run's knowledge tools search and read its workspace's notes, and a proposal is signed by the run; without notes there are none", async () => {
  const s = setup(), [t] = await targets(s.jobs, 1)
  const notes = notesStore(join(s.dir, 'kn'))
  await notes.save(null, { title: 'Tracker REST', tags: ['tracker'], playbooks: [], text: 'Use a token header.' }, null)
  const runner = new Runner({ store: s.store, jobs: s.jobs, bus: s.bus, sdk: fakeSdk(s.sessions).sdk, cwd: s.dir, gate: () => true, artifactsDir: join(s.dir, 'arts'), ctx: demoCtx, notes })
  await runner.ask(t.job, t.step, 'q')
  await until(() => s.sessions.length === 1)
  const tools = s.sessions[0].tools
  assert.deepEqual((await tools.knowledgeSearch!('token')).map((h) => h.id), ['tracker-rest'])
  assert.equal((await tools.knowledgeRead!('tracker-rest')).text, 'Use a token header.')
  const pid = await tools.knowledgePropose!({ note: 'tracker-rest', title: 'Tracker REST', text: 'Use a token header; it expires hourly.', reason: 'the run hit an expired token' })
  const [p] = await notes.proposals()
  assert.deepEqual([p.id, p.note, p.baseV, p.by], [pid, 'tracker-rest', 1, `run ${t.job}/${t.step}`])
  assert.equal((await notes.read('tracker-rest')).v, 1, 'a proposal writes nothing')
  assert.match(s.sessions[0].prompt, /propose a knowledge note or a change with knowledge_propose/)
  assert.doesNotMatch(s.sessions[0].prompt, /before guessing/, 'the prompt carries the context; it does not send the run off to read')
  const plain = setup(), [u] = await targets(plain.jobs, 1)
  await plain.runner.ask(u.job, u.step, 'q')
  await until(() => plain.sessions.length === 1)
  assert.equal(plain.sessions[0].tools.knowledgeSearch, undefined)
  assert.doesNotMatch(plain.sessions[0].prompt, /knowledge_/)
})

test("a run's prompt carries the job's notes and its playbook's in full, once each, under Knowledge; context() gives the sections again, read anew", async () => {
  const s = setup(), [t] = await targets(s.jobs, 1), pb = (await s.jobs.get(t.job))!.pb
  const notes = notesStore(join(s.dir, 'kn'))
  await notes.save(null, { title: 'Tracker REST', tags: [], playbooks: [], text: 'Use a token header.' }, null)
  await notes.save(null, { title: 'Release rules', tags: [], playbooks: [pb], text: 'Tag after merge.' }, null)
  await notes.save(null, { title: 'Both ways', tags: [], playbooks: [pb], text: 'Attached twice.' }, null)
  await notes.save(null, { title: 'Elsewhere', tags: [], playbooks: ['some-other-playbook'], text: 'Not for this job.' }, null)
  await s.jobs.cmd(t.job, { op: 'ctxAdd', k: 'note', id: 'tracker-rest', name: 'Tracker REST' })
  await s.jobs.cmd(t.job, { op: 'ctxAdd', k: 'note', id: 'both-ways', name: 'Both ways' })
  const b = { get: async (): Promise<ConceptReply> => { throw new GatewayError(504, 'timeout', 'no bridge in this test') } }
  const runner = new Runner({ store: s.store, jobs: s.jobs, bus: s.bus, sdk: fakeSdk(s.sessions).sdk, cwd: s.dir, gate: () => true, artifactsDir: join(s.dir, 'arts'), ctx: demoCtx, notes,
    context: (j) => resolveContext(b, j, undefined, notes) })
  await runner.ask(t.job, t.step, 'q')
  await until(() => s.sessions.length === 1)
  const p = s.sessions[0].prompt, k0 = p.indexOf('## Knowledge')
  assert.equal(p.slice(k0, p.indexOf('\n## ', k0)), "## Knowledge\n### Tracker REST (note tracker-rest, this job's)\nUse a token header.\n\n"
    + "### Both ways (note both-ways, this job's)\nAttached twice.\n\n### Release rules (note release-rules, the playbook's)\nTag after merge.\n")
  assert.doesNotMatch(p, /Not for this job/)
  assert.doesNotMatch(p, /### Note /, 'notes are not listed under Context')
  assert.ok(p.indexOf('## Context') < k0 && k0 < p.indexOf('## How to work'))
  const tools = s.sessions[0].tools
  await tools.journal('Found the limiter', 'nothing yet', 'read the PR')
  const c = await tools.context!(), again = c.text
  assert.deepEqual(c.images, [])
  assert.ok(again.startsWith(`## Job ${t.job}: `), again.slice(0, 80))
  assert.match(again, /: Found the limiter → nothing yet Next: read the PR\n/)
  assert.match(again, /### Release rules \(note release-rules, the playbook's\)\nTag after merge\./)
  assert.ok(again.endsWith('## Instruction (from the user)\nq'))
  assert.doesNotMatch(again, /## How to work/)
})

test('a workspace without a gateway: the prompt does not point at the bridge tools, and the rest is unchanged', async () => {
  const x = demoCtx(), j = promptJob()
  const line = '\n- Read anything else from the sources with the bridge tools (bridge_snapshot, bridge_get).'
  assert.equal(buildPrompt(x, j, 'sn', 'Draft the reply.', { bridge: false }), PROMPT.replace(line, ''))
  assert.equal(buildPrompt(x, j, 'sn', 'Draft the reply.', { bridge: true }), PROMPT)
  const s = setup(), [t] = await targets(s.jobs, 1)
  await new Runner({ store: s.store, jobs: s.jobs, bus: s.bus, sdk: fakeSdk(s.sessions).sdk, cwd: s.dir, gate: () => true, artifactsDir: join(s.dir, 'arts'), ctx: demoCtx, bridge: false }).ask(t.job, t.step, 'q')
  await until(() => s.sessions.length === 1)
  assert.ok(!/bridge_/.test(s.sessions[0].prompt))
})

test("## Sources is read at each start: the run prompt, context() and a hand-made session's step text all carry it", async () => {
  const s = setup(), [t] = await targets(s.jobs, 1)
  let n = 0
  const runner = new Runner({ store: s.store, jobs: s.jobs, bus: s.bus, sdk: fakeSdk(s.sessions).sdk, cwd: s.dir, gate: () => true, artifactsDir: join(s.dir, 'arts'), ctx: demoCtx,
    sources: () => `## Sources\n### Talk (read ${++n})` })
  await runner.ask(t.job, t.step, 'q')
  await until(() => s.sessions.length === 1)
  assert.match(s.sessions[0].prompt, /\n## Sources\n### Talk \(read 1\)/)
  assert.match((await s.sessions[0].tools.context!()).text, /\n## Sources\n### Talk \(read 2\)/)
  assert.match((await runner.stepText(t.job, t.step)).text, /\n## Sources\n### Talk \(read 3\)/)
})

test("a run works in its job's own dir; when the dir cannot be made the run fails saying why", async () => {
  const s = setup(), [a, b] = await targets(s.jobs, 2)
  let fail = false
  const workDir = { dir: async (j: { id: string }) => { if (fail) throw new Error('boom'); return join(s.dir, j.id) } }
  const runner = new Runner({ store: s.store, jobs: s.jobs, bus: s.bus, sdk: fakeSdk(s.sessions).sdk, cwd: s.dir, gate: () => true, artifactsDir: join(s.dir, 'arts'), ctx: demoCtx, workDir })
  await runner.ask(a.job, a.step, 'q')
  await until(() => s.sessions.length === 1)
  assert.equal(s.sessions[0].cwd, join(s.dir, a.job))
  assert.match(s.sessions[0].prompt, new RegExp(`^Work dir: .*${a.job}$`, 'm'), 'no branch named, none shown')
  fail = true
  const rb = await runner.ask(b.job, b.step, 'q')
  await until(() => s.evs.some((e) => e.kind === 'run' && e.run.id === rb.id && e.run.state === 'failed'))
  assert.equal((await runner.get(rb.id))!.reason, 'no work dir: boom')
  assert.equal(s.sessions.length, 1, 'no session started without its dir')
})

test('add_artifact_file keeps a file from under the run dir; outside it, through a link out, missing, a dir or over 20 MB are refused', async () => {
  const { runner, sessions, jobs, dir } = setup(), [t] = await targets(jobs, 1)
  await runner.ask(t.job, t.step, 'q')
  await until(() => sessions.length === 1)
  const tools = sessions[0].tools, png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
  mkdirSync(join(dir, 'shots')); writeFileSync(join(dir, 'shots', 'home.png'), png)
  await tools.addArtifactFile('shots/home.png')
  await tools.addArtifactFile(join(dir, 'shots', 'home.png'), 'again.png')
  const arts = (await jobs.get(t.job))!.flow[t.step].arts.map((a) => a.n)
  assert.ok(arts.includes('home.png') && arts.includes('again.png'), arts.join())
  assert.deepEqual(readFileSync(join(dir, 'arts', t.job, 'home.png')), png)
  const out = tempDir('out'), secret = join(out, 'secret.txt')
  writeFileSync(secret, 's')
  await assert.rejects(tools.addArtifactFile(relative(dir, secret)), /outside the work dir/)
  await assert.rejects(tools.addArtifactFile(secret), /outside the work dir/)
  symlinkSync(out, join(dir, 'out'), 'junction')
  await assert.rejects(tools.addArtifactFile('out/secret.txt'), /outside the work dir/)
  await assert.rejects(tools.addArtifactFile('nope.png'), /no such file/)
  await assert.rejects(tools.addArtifactFile('shots'), /not a file/)
  writeFileSync(join(dir, 'big.bin'), ''); truncateSync(join(dir, 'big.bin'), (20 << 20) + 1)
  await assert.rejects(tools.addArtifactFile('big.bin'), /over 20 MB/)
  assert.equal((await jobs.get(t.job))!.flow[t.step].arts.length, arts.length, 'nothing refused was kept')
})

test('screenshot keeps a png of a page as the step\'s artifact; a file outside the run dir or a script url is refused; no tool without the option', async () => {
  const s = setup(), [t] = await targets(s.jobs, 1), seen: { url: string; out: string; width?: number; fileRoot?: string }[] = []
  const screenshot = async (o: { url: string; out: string; width?: number; fileRoot?: string }) => { seen.push(o); writeFileSync(o.out, 'png') }
  const runner = new Runner({ store: s.store, jobs: s.jobs, bus: s.bus, sdk: fakeSdk(s.sessions).sdk, cwd: s.dir, gate: () => true, artifactsDir: join(s.dir, 'arts'), ctx: demoCtx, screenshot })
  await runner.ask(t.job, t.step, 'q')
  await until(() => s.sessions.length === 1)
  const tools = s.sessions[0].tools
  await tools.screenshot!({ url: 'http://127.0.0.1:7420/jobs', name: 'board.jpg', width: 900 })
  assert.equal(seen[0].url, 'http://127.0.0.1:7420/jobs'); assert.equal(seen[0].width, 900)
  assert.equal(seen[0].out, join(s.dir, 'arts', t.job, 'board.png'))
  assert.equal(seen[0].fileRoot, s.dir, 'the page reads files from the run dir only')
  writeFileSync(join(s.dir, 'page.html'), '<h1>x</h1>')
  await tools.screenshot!({ url: pathToFileURL(join(s.dir, 'page.html')).href, name: 'page' })
  const arts = (await s.jobs.get(t.job))!.flow[t.step].arts.map((a) => a.n)
  assert.deepEqual(arts.filter((n) => n.endsWith('.png')).sort(), ['board.png', 'page.png'])
  const out = tempDir('out'); writeFileSync(join(out, 'x.html'), 'x')
  await assert.rejects(tools.screenshot!({ url: pathToFileURL(join(out, 'x.html')).href, name: 'x' }), /outside the work dir/)
  await assert.rejects(tools.screenshot!({ url: 'javascript:alert(1)', name: 'x' }), /only http, https and file urls/)
  assert.equal(seen.length, 2, 'refused before any browser started')
  const plain = setup(), [p] = await targets(plain.jobs, 1)
  await plain.runner.ask(p.job, p.step, 'q')
  await until(() => plain.sessions.length === 1)
  assert.equal(plain.sessions[0].tools.screenshot, undefined)
})

test('signin_needed ends the run on a draft that asks the user to sign in, and the run record keeps the site and page; no tool without the browser', async () => {
  const s = setup(), [t] = await targets(s.jobs, 1)
  const runner = new Runner({ store: s.store, jobs: s.jobs, bus: s.bus, sdk: fakeSdk(s.sessions).sdk, cwd: s.dir, gate: () => true, artifactsDir: join(s.dir, 'arts'), ctx: demoCtx, browser: true })
  const r = await runner.ask(t.job, t.step, 'q')
  await until(() => s.sessions.length === 1)
  const tools = s.sessions[0].tools
  await assert.rejects(tools.signinNeeded!({ site: 'Telegram', url: 'javascript:alert(1)' }), /only http and https/)
  await tools.signinNeeded!({ site: 'Telegram', url: 'https://web.telegram.example/' })
  await assert.rejects(tools.signinNeeded!({ site: 'Telegram', url: 'https://web.telegram.example/' }), /draft was already submitted/)
  s.sessions[0].end()
  await until(async () => (await runner.get(r.id))?.ended != null)
  const rec = (await runner.get(r.id))!
  assert.equal(rec.state, 'draft')
  assert.deepEqual(rec.signin, { site: 'Telegram', url: 'https://web.telegram.example/' })
  const dr = (await s.jobs.get(t.job))!.flow[t.step].dr!
  assert.match(dr.t, /^Sign in to Telegram again/)
  assert.match(dr.t, /Sign in/); assert.match(dr.t, /reply/)
  const plain = setup(), [p] = await targets(plain.jobs, 1)
  await plain.runner.ask(p.job, p.step, 'q')
  await until(() => plain.sessions.length === 1)
  assert.equal(plain.sessions[0].tools.signinNeeded, undefined)
})

test('job tools create jobs in the run\'s workspace and start them; at most 5 a run, other prefixes refused, none without the option', async () => {
  const s = setup(), [t] = await targets(s.jobs, 1)
  const runner = new Runner({ store: s.store, jobs: s.jobs, bus: s.bus, sdk: fakeSdk(s.sessions).sdk, cwd: s.dir, gate: () => true, artifactsDir: join(s.dir, 'arts'), ctx: demoCtx,
    jobTools: { ws: 'acme', pb: 'action', prj: ['p', 'q'], prefix: 'J' } })
  await runner.ask(t.job, t.step, 'q')
  await until(() => s.sessions.length === 1)
  const tools = s.sessions[0].tools
  const a = await tools.createJob!({ title: 'Tidy the docs' }), ja = (await s.jobs.get(a))!
  assert.deepEqual([ja.st, ja.pb, ja.prj, ja.ws, ja.jr[0].a], ['ready', 'action', 'p', 'acme', 'LLM'])
  assert.equal(ja.jr[0].o, `Created the job from ${t.job}.`)
  const b = await tools.createJob!({ title: 'Fix the build', project: 'q', start: true })
  assert.equal((await s.jobs.get(b))!.st, 'active')
  await assert.rejects(tools.createJob!({ title: 'x', project: 'zz' }), /unknown project zz/)
  await assert.rejects(tools.createJob!({ title: 'x', playbook: 'nope' }), /unknown playbook nope/)
  await tools.startJob!(a)
  assert.equal((await s.jobs.get(a))!.st, 'active')
  await assert.rejects(tools.startJob!('B-0001'), /not a job of this workspace/)
  for (let i = 0; i < 3; i++) await tools.createJob!({ title: `more ${i}` })
  await assert.rejects(tools.createJob!({ title: 'sixth' }), /already created 5 jobs/)
  const plain = setup(), [p] = await targets(plain.jobs, 1)
  await plain.runner.ask(p.job, p.step, 'q')
  await until(() => plain.sessions.length === 1)
  assert.equal(plain.sessions[0].tools.createJob, undefined)
  assert.equal(plain.sessions[0].tools.startJob, undefined)
})

/** a runner whose runs may call the given acts on a fake source that answers from `answer` and records each call */
async function actRun(allowed: string[], answer: (a: ActReq) => ActRes = () => ({ status: 'ok' })) {
  const s = setup(), [t] = await targets(s.jobs, 1), calls: ActReq[] = []
  const runner = new Runner({ store: s.store, jobs: s.jobs, bus: s.bus, sdk: fakeSdk(s.sessions).sdk, cwd: s.dir, gate: () => true, artifactsDir: join(s.dir, 'arts'), ctx: demoCtx,
    acts: { allowed, act: async (a) => { calls.push(a); return answer(a) } } })
  await runner.ask(t.job, t.step, 'q')
  await until(() => s.sessions.length === 1)
  const badges = async () => (await s.jobs.get(t.job))!.flow[t.step].b.filter((b) => b.k === 'p' && b.o)
  return { s, t, calls, tools: s.sessions[0].tools, badges }
}

test('act: a run calls an act its workspace lets runs call, with a fresh action id each time, and no step is flagged', async () => {
  const { calls, tools, badges } = await actRun(['chat.post'])
  assert.match(await tools.act!('chat.post', { chat: '-100', text: 'hi' }), /^sent chat.post/)
  await tools.act!('chat.post', { chat: '-100', text: 'again' })
  assert.deepEqual(calls.map((c) => [c.action, c.args]), [['chat.post', { chat: '-100', text: 'hi' }], ['chat.post', { chat: '-100', text: 'again' }]])
  assert.ok(calls[0].actionId && calls[0].actionId !== calls[1].actionId)
  assert.deepEqual(await badges(), [])
})

test('act: an act runs may not call is refused before the source, and the step shows what was not sent and why', async () => {
  const { calls, tools, badges } = await actRun(['chat.post'])
  await assert.rejects(tools.act!('mail.send', { to: ['x@y.example'], text: 'hello there' }), /mail\.send is not an act runs may call here/)
  assert.deepEqual(calls, [])
  const [b] = await badges()
  assert.match(b.t, /^Not sent \(mail\.send\)/); assert.match(b.t, /not an act runs may call/); assert.match(b.t, /hello there/)
})

test('act: a target out of the scope is refused by the source; the run sees why and the step is flagged with the text', async () => {
  const { calls, tools, badges } = await actRun(['chat.post'], (a) => (a.args.chat === '-100' ? { status: 'ok' } : { status: 'error', error: { code: 'out_of_scope', message: 'chat "-200" is not in scope' } }))
  await assert.rejects(tools.act!('chat.post', { chat: '-200', text: 'to the wrong chat' }), /out_of_scope: chat "-200" is not in scope/)
  assert.equal(calls.length, 1)
  const [b] = await badges()
  assert.match(b.t, /^Not sent \(chat.post\)/); assert.match(b.t, /out_of_scope/); assert.match(b.t, /to the wrong chat/)
})

test('act: an unknown outcome is flagged as maybe sent, never retried', async () => {
  const { calls, tools, badges } = await actRun(['chat.post'], () => ({ status: 'outcome_unknown', error: { code: 'outcome_unknown', message: 'no server confirmation' } }))
  await assert.rejects(tools.act!('chat.post', { chat: '-100', text: 'x' }), /may or may not have been sent/)
  assert.equal(calls.length, 1)
  assert.match((await badges())[0].t, /may or may not have been sent/)
})

test('act: at most 10 a run; the 11th is refused and flagged', async () => {
  const { calls, tools, badges } = await actRun(['chat.post'])
  for (let i = 0; i < 10; i++) await tools.act!('chat.post', { chat: '-100', text: `m${i}` })
  await assert.rejects(tools.act!('chat.post', { chat: '-100', text: 'm10' }), /already called 10 acts/)
  assert.equal(calls.length, 10)
  assert.equal((await badges()).length, 1)
})

test('act: a workspace that lets runs call no act gives them no act tool', async () => {
  const none = await actRun([])
  assert.equal(none.tools.act, undefined)
  const s = setup(), [t] = await targets(s.jobs, 1)
  await s.runner.ask(t.job, t.step, 'q')
  await until(() => s.sessions.length === 1)
  assert.equal(s.sessions[0].tools.act, undefined)
})

/** a started job whose first step holds a draft from a run with session S1 */
async function withDraft(s: ReturnType<typeof setup>) {
  const j = await started(s.jobs), step = T.atOf(demoCtx(), j)!
  const r = await s.runner.ask(j.id, step, 'go')
  await until(() => s.sessions.length === 1)
  s.sessions[0].push({ k: 'session', id: 'S1' })
  await s.sessions[0].tools.submitDraft('v1'); s.sessions[0].end()
  await until(async () => (await s.runner.get(r.id))?.ended != null)
  return { job: j.id, step, r }
}

test('a revise reply resumes the session with the reply prompt and replaces the draft', async () => {
  const s = setup(), d = await withDraft(s)
  const r = await s.runner.reply(d.job, d.step, 'shorter', 'revise')
  assert.equal(r.parent, d.r.id); assert.equal(r.intent, 'revise')
  await until(() => s.sessions.length === 2)
  assert.equal(s.sessions[1].resume, 'S1'); assert.match(s.sessions[1].prompt, /replied to your draft:\n\nshorter/)
  assert.equal((await s.jobs.get(d.job))!.flow[d.step].dr!.t, 'v1', 'the draft stays while it runs')
  await s.sessions[1].tools.submitDraft('v2'); s.sessions[1].end()
  await until(async () => (await s.runner.get(r.id))?.ended != null)
  const f = (await s.jobs.get(d.job))!.flow[d.step]
  assert.equal(f.dr!.t, 'v2'); assert.equal(f.s, 'wait'); assert.equal(await state(s.runner, r.id), 'draft')
})

test('an ask reply keeps the answer, ends answered and leaves the draft', async () => {
  const s = setup(), d = await withDraft(s), seen: string[] = []
  s.runner.onSettled((x) => seen.push(x.state))
  const r = await s.runner.reply(d.job, d.step, 'why X?', 'ask')
  await until(() => s.sessions.length === 2)
  s.sessions[1].push({ k: 'text', t: 'thinking' }); s.sessions[1].end(true, undefined, 'Because of Y.')
  await until(() => seen.includes('answered'))
  const rec = (await s.runner.get(r.id))!
  assert.equal(rec.a, 'Because of Y.'); assert.ok(rec.ended)
  const j = (await s.jobs.get(d.job))!, f = j.flow[d.step]
  assert.equal(f.dr!.t, 'v1'); assert.equal(f.run, null); assert.equal(f.s, 'wait')
  assert.ok(j.jr.some((e) => /answered: Because of Y\./.test(e.c) && e.a === 'LLM'))
})

test('an ask reply with no text fails; a draft in an ask turn counts as revise', async () => {
  const s = setup(), d = await withDraft(s)
  const r = await s.runner.reply(d.job, d.step, 'hm', 'ask')
  await until(() => s.sessions.length === 2); s.sessions[1].end()
  await until(async () => (await s.runner.get(r.id))?.ended != null)
  const rec = (await s.runner.get(r.id))!
  assert.equal(rec.state, 'failed'); assert.match(rec.reason!, /without an answer/)
  assert.equal((await s.jobs.get(d.job))!.flow[d.step].dr!.t, 'v1', 'a failed reply keeps the draft')
  const r2 = await s.runner.reply(d.job, d.step, 'and?', 'ask')
  await until(() => s.sessions.length === 3)
  assert.equal(s.sessions[2].resume, 'S1', 'a failed reply without a session does not break the chain')
  await s.sessions[2].tools.submitDraft('v3'); s.sessions[2].end()
  await until(async () => (await s.runner.get(r2.id))?.ended != null)
  assert.equal(await state(s.runner, r2.id), 'draft'); assert.equal((await s.jobs.get(d.job))!.flow[d.step].dr!.t, 'v3')
})

test("an accept reply revises, then accepts on the replier's word", async () => {
  const s = setup(), d = await withDraft(s)
  const r = await s.runner.reply(d.job, d.step, 'fine, fix the typo', 'accept', { via: 'session' })
  await until(() => s.sessions.length === 2)
  await s.sessions[1].tools.submitDraft('v2'); s.sessions[1].end()
  await until(async () => (await s.runner.get(r.id))?.ended != null)
  const j = (await s.jobs.get(d.job))!
  assert.equal(j.flow[d.step].out, 'v2'); assert.equal(j.flow[d.step].s, 'done')
  const e = j.jr.find((x) => /as said in the reply/.test(x.o))!
  assert.equal(e.a, 'Claude Code')
  assert.ok(j.jr.some((x) => /Replied to the LLM draft/.test(x.o) && x.a === 'Claude Code'))
})

/** a started job whose first step holds a draft from session S1 that waits for two commands */
async function withCommands(s: ReturnType<typeof setup>) {
  const j = await started(s.jobs), step = T.atOf(demoCtx(), j)!
  const r = await s.runner.ask(j.id, step, 'go')
  await until(() => s.sessions.length === 1)
  s.sessions[0].push({ k: 'session', id: 'S1' })
  await s.sessions[0].tools.submitDraft('Push and deploy.', { cm: ['git push', 'npm run deploy'] }); s.sessions[0].end()
  await until(async () => (await s.runner.get(r.id))?.ended != null)
  return { job: j.id, step, r, at: (await s.jobs.get(j.id))!.flow[step].dr!.at }
}

test('an approve reply builds its text from the stored commands, ignores the text sent, resumes the session and does not accept', async () => {
  const s = setup({ v: true }, { me: 'Valery' }), d = await withCommands(s)
  const r = await s.runner.reply(d.job, d.step, 'rm -rf /', 'approve', { at: d.at })
  const q = 'Approved, run exactly these commands, in this order:\n1. git push\n2. npm run deploy'
  assert.equal(r.q, q); assert.equal(r.intent, 'approve'); assert.equal(r.parent, d.r.id)
  await until(() => s.sessions.length === 2)
  assert.equal(s.sessions[1].resume, 'S1')
  assert.match(s.sessions[1].prompt, /^Valery replied to your draft:\n\nApproved, run exactly these commands, in this order:\n1\. git push\n2\. npm run deploy\n\nRun exactly these commands/)
  assert.doesNotMatch(s.sessions[1].prompt, /rm -rf/)
  const j = (await s.jobs.get(d.job))!
  assert.match(j.jr[0].o, /^Approved 2 commands for “.+”: git push; npm run deploy$/)
  await s.sessions[1].tools.submitDraft('git push: ok\nnpm run deploy: ok'); s.sessions[1].end()
  await until(async () => (await s.runner.get(r.id))?.ended != null)
  const f = (await s.jobs.get(d.job))!.flow[d.step]
  assert.equal(f.s, 'wait', 'the person reads the output and accepts it'); assert.equal(f.dr!.t, 'git push: ok\nnpm run deploy: ok')
  assert.equal(f.dr!.ap, 1); assert.equal(f.dr!.cm, undefined)
  assert.equal(await state(s.runner, r.id), 'draft')
})

test('an interrupted approve turn never resumes by itself: the person sees where the commands stopped and resumes it', async () => {
  const s = setup(undefined, { autoResume: true }), d = await withCommands(s)
  const r = await s.runner.reply(d.job, d.step, '', 'approve', { at: d.at })
  await until(() => s.sessions.length === 2)
  s.sessions[1].push({ k: 'session', id: 'S1' })
  await tick()
  await s.runner.interruptAll('the bridge went away')
  assert.deepEqual([await state(s.runner, r.id), (await s.runner.get(r.id))!.ar], ['interrupted', undefined])
  assert.equal((await s.jobs.get(d.job))!.jr[0].n, 'resume it when the console is back.')
  await s.runner.resumeDue(); await tick()
  assert.equal(s.sessions.length, 2, 'nothing ran by itself')
  // the person resumes it by hand, in the same session, still an approval
  await s.runner.resume(r.id)
  await until(() => s.sessions.length === 3)
  assert.equal(s.sessions[2].resume, 'S1')
  assert.equal((await s.jobs.get(d.job))!.flow[d.step].run!.ap, 1)
})

test('an approve reply is refused without commands, on a stale draft, and from a session or the console', async () => {
  const s = setup(), d = await withCommands(s)
  await assert.rejects(s.runner.reply(d.job, d.step, '', 'approve', { at: '2020-01-01T00:00:00.000Z' }), code(409, 'stale'))
  await assert.rejects(s.runner.reply(d.job, d.step, '', 'approve', {}), code(409, 'stale'))
  await assert.rejects(s.runner.reply(d.job, d.step, '', 'approve', { at: d.at, via: 'session' }), code(403, 'not_yours'))
  await assert.rejects(s.runner.reply(d.job, d.step, '', 'approve', { at: d.at, via: 'console' }), code(403, 'not_yours'))
  assert.equal(s.sessions.length, 1, 'nothing ran')
  const t = setup(), p = await withDraft(t), at = (await t.jobs.get(p.job))!.flow[p.step].dr!.at
  await assert.rejects(t.runner.reply(p.job, p.step, '', 'approve', { at }), code(409, 'no_commands'))
})

test('the console approves only within the job\'s one-time approval: every command on it runs, one off it is 403; a session never', async () => {
  const s = setup(), d = await withCommands(s)
  const give = async (cmds: string[]) => { const j = (await s.jobs.get(d.job))!; await s.store.putJob({ ...j, ok: { at: 'x', by: 'you', cmds } }, j.v ?? null) }
  await give(['git push'])
  await assert.rejects(s.runner.reply(d.job, d.step, '', 'approve', { at: d.at, via: 'console' }), code(403, 'not_yours'))
  await give(['npm run deploy', 'git push', 'git status'])
  await assert.rejects(s.runner.reply(d.job, d.step, '', 'approve', { at: d.at, via: 'session' }), code(403, 'not_yours'))
  assert.equal(s.sessions.length, 1, 'nothing ran')
  const r = await s.runner.reply(d.job, d.step, 'ignored', 'approve', { at: d.at, via: 'console' })
  assert.equal(r.via, 'console'); assert.equal(r.q, 'Approved, run exactly these commands, in this order:\n1. git push\n2. npm run deploy')
  await until(() => s.sessions.length === 2)
  assert.equal((await s.jobs.get(d.job))!.flow[d.step].run!.ap, 'ok')
})

test('a draft handed in by hand is never approved, not even in the session of an earlier LLM run on the step', async () => {
  const s = setup(), d = await withDraft(s)
  // the LLM's draft is rejected; a person then hands in a draft with commands through MCP
  await s.jobs.cmd(d.job, { op: 'rejectDraft', step: d.step }, undefined, 'page')
  await s.jobs.cmd(d.job, { op: 'draftIn', step: d.step, t: 'Push it.', cm: ['git push'] }, undefined, 'session')
  const dr = (await s.jobs.get(d.job))!.flow[d.step].dr!
  assert.deepEqual([dr.cm, dr.hd], [['git push'], 1])
  await assert.rejects(s.runner.reply(d.job, d.step, '', 'approve', { at: dr.at }), code(409, 'no_session'))
  assert.equal(s.sessions.length, 1, 'nothing ran in S1')
})

test('submit_draft with an outcome stores it; a bad return_to is refused and the run may hand in again', async () => {
  const { runner, sessions, jobs } = setup(), j = await started(jobs), step = T.atOf(demoCtx(), j)!
  const r = await runner.ask(j.id, step, 'deploy')
  await until(() => sessions.length === 1)
  await assert.rejects(sessions[0].tools.submitDraft('The step is not done.', { o: 'not_done', rt: step }), /not been passed/)
  await sessions[0].tools.submitDraft('The step is not done.', { o: 'not_done', why: 'the build broke' })
  sessions[0].end()
  await until(async () => (await runner.get(r.id))?.ended != null)
  const f = (await jobs.get(j.id))!.flow[step]
  assert.deepEqual([f.dr!.o, f.dr!.why], ['not_done', 'the build broke'])
  assert.equal(await state(runner, r.id), 'draft')
})

test('submit_draft with facts keeps them on the draft; a bad fact is refused and the run may hand in again', async () => {
  const { runner, sessions, jobs } = setup(), j = await started(jobs), step = T.atOf(demoCtx(), j)!
  const r = await runner.ask(j.id, step, 'build')
  await until(() => sessions.length === 1)
  await assert.rejects(sessions[0].tools.submitDraft('built', { fx: [{ kind: 'branch', repo: 'core', name: 'job/x', sha: 'HEAD' }] }), /facts: fact 1 \(branch\): sha is a commit hash/)
  await sessions[0].tools.submitDraft('built', { fx: [{ kind: 'branch', repo: 'core', name: 'job/x', sha: 'abcdef1' }] })
  sessions[0].end()
  await until(async () => (await runner.get(r.id))?.ended != null)
  const f = (await jobs.get(j.id))!.flow[step]
  assert.deepEqual(f.dr!.fx!.map((x) => [x.kind, x.step]), [['branch', step]])
})

test('an accept reply whose new draft reports failed does not close the step', async () => {
  const s = setup(), d = await withDraft(s)
  const r = await s.runner.reply(d.job, d.step, 'run the smoke test and accept', 'accept', { via: 'session' })
  await until(() => s.sessions.length === 2)
  await s.sessions[1].tools.submitDraft('The smoke test failed.', { o: 'failed' }); s.sessions[1].end()
  await until(async () => (await s.runner.get(r.id))?.ended != null)
  const f = (await s.jobs.get(d.job))!.flow[d.step]
  assert.equal(f.s, 'cur'); assert.equal(f.m, 'reported failed'); assert.equal(f.out, 'The smoke test failed.')
})

test('an accept reply accepts as soon as its draft is in, while the session still winds down', async () => {
  const s = setup(), d = await withDraft(s)
  await s.runner.reply(d.job, d.step, 'ok', 'accept')
  await until(() => s.sessions.length === 2)
  await s.sessions[1].tools.submitDraft('v2')
  const f = (await s.jobs.get(d.job))!.flow[d.step]
  assert.equal(f.out, 'v2'); assert.equal(f.s, 'done')
  s.sessions[1].end()
})

test('an accept that cannot be saved leaves the revised draft waiting and pushes it once', async () => {
  const s = setup(), d = await withDraft(s), seen: string[] = []
  s.runner.onSettled((x) => seen.push(x.state))
  const cmd = s.jobs.cmd.bind(s.jobs)
  s.jobs.cmd = (id, c, ...rest) => (c.op === 'acceptDraft' ? Promise.reject(new Error('lost')) : cmd(id, c, ...rest))
  const r = await s.runner.reply(d.job, d.step, 'ok', 'accept')
  await until(() => s.sessions.length === 2)
  await s.sessions[1].tools.submitDraft('v2')
  assert.deepEqual(seen, ['draft'])
  s.sessions[1].end()
  await until(async () => (await s.runner.get(r.id))?.ended != null)
  assert.deepEqual(seen, ['draft'])
  assert.equal((await s.jobs.get(d.job))!.flow[d.step].dr!.t, 'v2')
})

test('an accept reply on a blocked step keeps the revised draft and journals why it was not accepted', async () => {
  const s = setup(), d = await withDraft(s)
  const b = await s.jobs.create({ t: 'Ask Imre', key: 'NEW', pb: 'action', prj: 'p', ws: 'acme' })
  await s.jobs.cmd(d.job, { op: 'waitAdd', step: d.step, j: b.id })
  const r = await s.runner.reply(d.job, d.step, 'fine as it is', 'accept')
  await until(() => s.sessions.length === 2)
  await s.sessions[1].tools.submitDraft('v2'); s.sessions[1].end()
  await until(async () => (await s.runner.get(r.id))?.ended != null)
  const j = (await s.jobs.get(d.job))!, e = j.jr.find((x) => x.o.startsWith('Did not accept the revised draft'))!
  assert.equal(j.flow[d.step].dr!.t, 'v2'); assert.equal(j.flow[d.step].s, 'wait')
  assert.equal(e.a, 'console'); assert.match(e.c, new RegExp(`waits for ${b.id}`))
})

test('an accept reply on a step with an open question keeps the revised draft and journals the questions', async () => {
  const s = setup(), d = await withDraft(s)
  await s.jobs.cmd(d.job, { op: 'noteAdd', step: d.step, k: 'q', t: 'which mailbox?' })
  const r = await s.runner.reply(d.job, d.step, 'fine as it is', 'accept')
  await until(() => s.sessions.length === 2)
  await s.sessions[1].tools.submitDraft('v2'); s.sessions[1].end()
  await until(async () => (await s.runner.get(r.id))?.ended != null)
  const j = (await s.jobs.get(d.job))!, e = j.jr.find((x) => x.o.startsWith('Did not accept the revised draft'))!
  assert.equal(j.flow[d.step].dr!.t, 'v2'); assert.equal(j.flow[d.step].s, 'wait')
  assert.equal(e.a, 'console'); assert.match(e.c, /has 1 open question/); assert.equal(e.n, 'answer it, or accept the draft anyway.')
})

test('ask_question: an open question on the run\'s step, signed LLM; the same open one is not added twice; at most 10 a run', async () => {
  const s = setup(), [t] = await targets(s.jobs, 1)
  await s.runner.ask(t.job, t.step, 'q')
  await until(() => s.sessions.length === 1)
  const ask = s.sessions[0].tools.askQuestion!
  const title = T.stepOf(demoCtx(), (await s.jobs.get(t.job))!, t.step)!.t
  const before = (await s.jobs.get(t.job))!.flow[t.step].b.length
  assert.equal(await ask(' Which mailbox? '), `question ${before + 1} is open on “${title}”`)
  const j = (await s.jobs.get(t.job))!
  const b = j.flow[t.step].b.at(-1)!
  assert.deepEqual([b.k, b.t, b.o], ['q', 'Which mailbox?', 1])
  assert.equal(j.jr[0].a, 'LLM'); assert.equal(j.jr[0].o, `Question on “${title}”: Which mailbox?`)
  assert.equal(await ask('Which mailbox?'), `question ${before + 1} is open on “${title}”`)
  assert.equal((await s.jobs.get(t.job))!.flow[t.step].b.length, before + 1)
  for (let i = 2; i <= 10; i++) await ask(`question ${i}?`)
  await assert.rejects(ask('an eleventh?'), /this run already asked 10 questions/)
  await assert.rejects(ask('  '), /a question needs text/)
  assert.equal((await s.jobs.get(t.job))!.flow[t.step].b.length, before + 10, 'the repeat did not count')
  s.sessions[0].end()
})

test('ask_question in parallel: 12 at once add 10 and refuse 2; the same text at once adds 1', async () => {
  const s = setup(), [a, b] = await targets(s.jobs, 2)
  await s.runner.ask(a.job, a.step, 'q'); await s.runner.ask(b.job, b.step, 'q')
  await until(() => s.sessions.length === 2)
  const qs = async (x: { job: string; step: string }) => (await s.jobs.get(x.job))!.flow[x.step].b.filter((n) => n.k === 'q').length
  const before = await qs(a)
  const got = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => s.sessions[0].tools.askQuestion!(`question ${i}?`)))
  assert.equal(got.filter((r) => r.status === 'fulfilled').length, 10)
  assert.ok(got.filter((r) => r.status === 'rejected').every((r) => /already asked 10 questions/.test(String((r as PromiseRejectedResult).reason))))
  assert.equal(await qs(a), before + 10)
  const beforeB = await qs(b)
  const same = await Promise.all(Array.from({ length: 5 }, () => s.sessions[1].tools.askQuestion!('Which mailbox?')))
  assert.equal(new Set(same).size, 1)
  assert.equal(await qs(b), beforeB + 1)
  // a failed add gives its place back
  const cmd = s.jobs.cmd.bind(s.jobs)
  s.jobs.cmd = (id, c, ...rest) => (c.op === 'noteAdd' ? Promise.reject(new Error('lost')) : cmd(id, c, ...rest))
  await assert.rejects(s.sessions[1].tools.askQuestion!('lost?'), /lost/)
  s.jobs.cmd = cmd
  for (let i = 0; i < 9; i++) await s.sessions[1].tools.askQuestion!(`more ${i}?`)
  await assert.rejects(s.sessions[1].tools.askQuestion!('one too many?'), /already asked 10 questions/)
  s.sessions[0].end(); s.sessions[1].end()
})

test('ask_question clips a long question to 1000 characters on one line', async () => {
  const s = setup(), [t] = await targets(s.jobs, 1)
  await s.runner.ask(t.job, t.step, 'q')
  await until(() => s.sessions.length === 1)
  await s.sessions[0].tools.askQuestion!(`Which\n\nmailbox ${'x'.repeat(3000)}`)
  const b = (await s.jobs.get(t.job))!.flow[t.step].b.at(-1)!
  assert.equal(b.t.length, 1000); assert.match(b.t, /^Which mailbox x+…$/)
  s.sessions[0].end()
})

test("a reply waits until the draft's session has wound down", async () => {
  const s = setup(), d = await withDraft(s)
  const r = await s.runner.reply(d.job, d.step, 'shorter', 'revise')
  await until(() => s.sessions.length === 2)
  await s.sessions[1].tools.submitDraft('v2')
  await assert.rejects(s.runner.reply(d.job, d.step, 'again', 'revise'), code(409, 'busy'))
  s.sessions[1].end()
  await until(async () => (await s.runner.get(r.id))?.ended != null)
  await s.runner.reply(d.job, d.step, 'again', 'revise')
  await until(() => s.sessions.length === 3)
})

test('a reply is refused without a draft, while a run is on, or without a session', async () => {
  const s = setup(), d = await withDraft(s)
  await s.runner.reply(d.job, d.step, 'a', 'revise')
  await assert.rejects(s.runner.reply(d.job, d.step, 'b', 'revise'), code(409, 'busy'))
  const t = setup(), j = await started(t.jobs), step = T.atOf(demoCtx(), j)!
  await assert.rejects(t.runner.reply(j.id, step, 'x', 'revise'), code(409, 'no_draft'))
  const r = await t.runner.ask(j.id, step, 'go'); await until(() => t.sessions.length === 1)
  await t.sessions[0].tools.submitDraft('v1'); t.sessions[0].end()
  await until(async () => (await t.runner.get(r.id))?.ended != null)
  await assert.rejects(t.runner.reply(j.id, step, 'x', 'revise'), code(409, 'no_session'))
  await assert.rejects(t.runner.reply(j.id, step, ' ', 'revise'), code(400, 'bad_args'))
  await assert.rejects(t.runner.reply(j.id, step, 'x', 'nope' as never), code(400, 'bad_args'))
  t.open.v = false
  await assert.rejects(t.runner.reply(j.id, step, 'x', 'revise'), code(503))
})

test('a reply interrupted before it started resumes with the reply, not the generic prompt', async () => {
  const s = setup({ v: true }, { max: 1 }), d = await withDraft(s)
  const other = (await targets(s.jobs, 4)).find((x) => x.job !== d.job)!
  await s.runner.ask(other.job, other.step, 'busy'); await until(() => s.sessions.length === 2)
  const r = await s.runner.reply(d.job, d.step, 'shorter', 'revise')
  await s.runner.interruptAll('A went away')
  assert.equal(await state(s.runner, r.id), 'interrupted')
  assert.equal((await s.jobs.get(d.job))!.flow[d.step].dr!.t, 'v1')
  await s.runner.resume(r.id)
  await until(() => s.sessions.length === 3)
  assert.equal(s.sessions[2].resume, 'S1'); assert.match(s.sessions[2].prompt, /replied to your draft:\n\nshorter/)
})

test('reject with a reason redoes the step in a fresh session with the draft and why', async () => {
  const s = setup(), d = await withDraft(s)
  const res = await s.jobs.cmd(d.job, { op: 'rejectDraft', step: d.step, why: 'wrong scope' })
  const out = await s.runner.redoRejected(res.prev, { op: 'rejectDraft', step: d.step, why: 'wrong scope' })
  assert.ok(out.run); await until(() => s.sessions.length === 2)
  assert.equal(s.sessions[1].resume, undefined)
  assert.match(s.sessions[1].prompt, /## Rejected draft\nv1\n\n## Why\nwrong scope/)
  assert.deepEqual(await s.runner.redoRejected(res.prev, { op: 'rejectDraft', step: d.step }), {})
  s.open.v = false
  const no = await s.runner.redoRejected(res.prev, { op: 'rejectDraft', step: d.step, why: 'again' })
  assert.match(no.redo!, /bridge is unavailable/)
})

test('settle waits for the end, or returns the record as it is at the timeout', async () => {
  const s = setup(), d = await withDraft(s)
  const r = await s.runner.reply(d.job, d.step, 'why?', 'ask')
  assert.equal((await s.runner.settle(r.id, 50)).ended, undefined)
  await until(() => s.sessions.length === 2)
  const p = s.runner.settle(r.id, 2000)
  s.sessions[1].end(true, undefined, 'Y.')
  assert.equal((await p).state, 'answered')
})

test('a reply run can open the blocker builder: the run is answered, the draft stays, the step asks the user', async () => {
  const s = setup(), d = await withDraft(s)
  const r = await s.runner.reply(d.job, d.step, 'wait for Imre to confirm', 'revise')
  await until(() => s.sessions.length === 2)
  assert.match(s.sessions[1].prompt, /open_blocker/)
  assert.ok(s.sessions[1].tools.openBlocker)
  await s.sessions[1].tools.openBlocker!('wait for Imre to confirm'); s.sessions[1].end()
  await until(async () => (await s.runner.get(r.id))?.ended != null)
  const rec = (await s.runner.get(r.id))!, j = (await s.jobs.get(d.job))!
  assert.equal(rec.state, 'answered'); assert.equal(rec.a, 'Opened the blocker builder: wait for Imre to confirm')
  assert.equal(j.flow[d.step].bb!.say, 'wait for Imre to confirm'); assert.equal(j.flow[d.step].dr!.t, 'v1')
  assert.equal(j.flow[d.step].run ?? null, null)
})

test('a first run has no open_blocker', async () => {
  const s = setup(), j = await started(s.jobs)
  await s.runner.ask(j.id, T.atOf(demoCtx(), j)!, 'go')
  await until(() => s.sessions.length === 1)
  assert.equal(s.sessions[0].tools.openBlocker, undefined)
  s.sessions[0].end()
})

test('a reply that ends in text without a draft is an answer', async () => {
  const s = setup(), d = await withDraft(s)
  const r = await s.runner.reply(d.job, d.step, 'make a blocker', 'revise')
  await until(() => s.sessions.length === 2)
  s.sessions[1].end(true, undefined, 'Which step should wait, and for whom?')
  await until(async () => (await s.runner.get(r.id))?.ended != null)
  const rec = (await s.runner.get(r.id))!
  assert.equal(rec.state, 'answered'); assert.equal(rec.a, 'Which step should wait, and for whom?')
  assert.equal((await s.jobs.get(d.job))!.flow[d.step].dr!.t, 'v1')
})

test('open_blocker after submit_draft is refused: the run stays a draft and no blocker is made', async () => {
  const s = setup(), d = await withDraft(s)
  const r = await s.runner.reply(d.job, d.step, 'wait for Imre to confirm', 'revise')
  await until(() => s.sessions.length === 2)
  await s.sessions[1].tools.submitDraft('v2')
  await assert.rejects(() => s.sessions[1].tools.openBlocker!('wait for Imre'), /draft was already submitted/)
  s.sessions[1].end()
  await until(async () => (await s.runner.get(r.id))?.ended != null)
  const rec = (await s.runner.get(r.id))!, j = (await s.jobs.get(d.job))!
  assert.equal(rec.state, 'draft'); assert.equal(j.flow[d.step].bb, undefined)
})

test('a second open_blocker in one run is refused', async () => {
  const s = setup(), d = await withDraft(s)
  await s.runner.reply(d.job, d.step, 'wait for Imre to confirm', 'revise')
  await until(() => s.sessions.length === 2)
  await s.sessions[1].tools.openBlocker!('wait for Imre')
  await assert.rejects(() => s.sessions[1].tools.openBlocker!('again'), /already opened/)
  s.sessions[1].end()
})

test('providers: a run records the auto provider; its reply stays on it after auto changes; a new ask takes the new auto', async () => {
  const a = fakeSdk(), b = fakeSdk(), cur = { v: 'claude' as 'claude' | 'cursor' }
  const pick = { auto: () => cur.v, get: (id: 'claude' | 'cursor') => { if (id === 'claude') return a.sdk; if (cur.v === 'cursor' && id === 'cursor') return b.sdk; throw new Error('provider_unavailable: Cursor cannot run by itself') } }
  const { runner, jobs } = setup({ v: true }, { sdk: pick }), [t, u] = await targets(jobs, 2)
  const r = await runner.ask(t.job, t.step, 'draft please')
  assert.equal(r.provider, 'claude')
  await until(() => a.sessions.length === 1)
  a.sessions[0].push({ k: 'session', id: 's-1' }); await a.sessions[0].tools.submitDraft('v1'); a.sessions[0].end()
  await until(async () => (await state(runner, r.id)) === 'draft')
  cur.v = 'cursor'
  const re = await runner.reply(t.job, t.step, 'shorter', 'revise')
  assert.equal(re.provider, 'claude', 'the reply continues the claude session')
  await until(() => a.sessions.length === 2)
  assert.equal(a.sessions[1].resume, 's-1')
  assert.equal(b.sessions.length, 0)
  a.sessions[1].end()
  await until(async () => (await runner.get(re.id))!.ended != null)
  // a new ask takes the new auto
  const n = await runner.ask(u.job, u.step, 'other')
  assert.equal(n.provider, 'cursor')
  await until(() => b.sessions.length === 1)
  b.sessions[0].end()
  await until(async () => (await state(runner, n.id)) === 'failed')
})

test('providers: a hand-edited auto without auto fails the run as provider_unavailable', async () => {
  const pick = { auto: () => 'cursor' as const, get: () => { throw new Error('provider_unavailable: Cursor cannot run by itself') } }
  const { runner, jobs } = setup({ v: true }, { sdk: pick }), [t] = await targets(jobs, 1)
  const r = await runner.ask(t.job, t.step, 'x')
  await until(async () => (await state(runner, r.id)) === 'failed')
  assert.match((await runner.get(r.id))!.reason!, /^provider_unavailable/)
})

/** a run whose source answers files from `answer` and records each call */
async function fileRun(answer: (concept: string, id: string, file: string, pack?: string) => ConceptReply) {
  const calls: unknown[][] = []
  const s = setup({ v: true }, { files: async (...a) => { calls.push(a); return answer(...a) } }), [t] = await targets(s.jobs, 1)
  await s.runner.ask(t.job, t.step, 'q')
  await until(() => s.sessions.length === 1)
  const arts = async () => (await s.jobs.get(t.job))!.flow[t.step].arts.map((a) => a.n)
  return { s, t, calls, tools: s.sessions[0].tools, arts }
}
const pdf = Buffer.from('%PDF-1.4 acta')
const okFile = (name = 'acta.pdf', bytes = pdf): ConceptReply => ({ status: 'ok', items: { name, mime: 'application/pdf', size: bytes.length, base64: bytes.toString('base64') } })

test('save_source_file keeps the file as an artifact and copies it under .source-files, which git ignores', async () => {
  const { s, t, calls, tools, arts } = await fileRun(() => okFile())
  assert.equal(await tools.saveSourceFile!({ concept: 'chat', id: '-100', file: '20', pack: 'telegram-web' }), `saved acta.pdf (1 KB) as an artifact; a copy is at .source-files/${t.job}/acta.pdf`)
  assert.deepEqual(calls, [['chat', '-100', '20', 'telegram-web']])
  assert.ok((await arts()).includes('acta.pdf'))
  assert.deepEqual(readFileSync(join(s.dir, 'arts', t.job, 'acta.pdf')), pdf)
  assert.deepEqual(readFileSync(join(s.dir, '.source-files', t.job, 'acta.pdf')), pdf)
  assert.equal(readFileSync(join(s.dir, '.source-files', '.gitignore'), 'utf8'), '*\n')
})

test('save_source_file: a name from the source stays inside the job folder and .source-files', async () => {
  const { s, t, tools } = await fileRun(() => okFile('../../a:b.pdf'))
  assert.match(await tools.saveSourceFile!({ concept: 'chat', id: '-100', file: '20' }), /^saved a_b\.pdf /)
  assert.ok(existsSync(join(s.dir, 'arts', t.job, 'a_b.pdf')) && existsSync(join(s.dir, '.source-files', t.job, 'a_b.pdf')))
})

test('save_source_file: two jobs sharing one cwd keep their copies apart', async () => {
  const s = setup({ v: true }, { files: async (_c, _i, f) => okFile('acta.pdf', Buffer.from(`from ${f}`)) }), all = await targets(s.jobs, 8), ts = [all[0], all.find((x) => x.job !== all[0].job)!]
  assert.ok(ts[1], 'two different jobs')
  await Promise.all(ts.map((t) => s.runner.ask(t.job, t.step, 'q')))
  await until(() => s.sessions.length === 2)
  await Promise.all(s.sessions.map((x, i) => x.tools.saveSourceFile!({ concept: 'chat', id: '-100', file: String(i) })))
  for (const t of ts) assert.ok(existsSync(join(s.dir, '.source-files', t.job, 'acta.pdf')))
  assert.notDeepEqual(readFileSync(join(s.dir, '.source-files', ts[0].job, 'acta.pdf')), readFileSync(join(s.dir, '.source-files', ts[1].job, 'acta.pdf')))
})

test('save_source_file: what the source refuses comes back as code and message, and nothing is kept', async () => {
  const { tools, arts } = await fileRun(() => ({ status: 'too_large', message: 'tg: a.mp4 is 48.2 MB, the limit is 20 MB' }))
  const before = await arts()
  await assert.rejects(tools.saveSourceFile!({ concept: 'chat', id: '-100', file: '25' }), /^Error: too_large: tg: a\.mp4 is 48\.2 MB, the limit is 20 MB$/)
  assert.deepEqual(await arts(), before)
})

test('save_source_file: a rate limit says when to retry', async () => {
  const { tools } = await fileRun(() => ({ status: 'rate_limited', message: 'tg: rate limited', retryAfter: 7 }))
  await assert.rejects(tools.saveSourceFile!({ concept: 'chat', id: '-100', file: '1' }), /^Error: rate_limited: tg: rate limited; retry after 7 s$/)
})

test('save_source_file: an answer over 20 MB or without bytes is refused before anything is written', async () => {
  const big = Buffer.alloc((20 << 20) + 1)
  const { s, t, tools, arts } = await fileRun((_c, _i, f) => (f === 'big' ? okFile('big.bin', big) : { status: 'ok', items: { name: 'x.pdf' } }))
  const before = await arts()
  await assert.rejects(tools.saveSourceFile!({ concept: 'chat', id: '-100', file: 'big' }), /big\.bin is over 20 MB/)
  await assert.rejects(tools.saveSourceFile!({ concept: 'chat', id: '-100', file: 'none' }), /sent no file/)
  assert.deepEqual(await arts(), before)
  assert.ok(!existsSync(join(s.dir, '.source-files', t.job, 'big.bin')))
})

test('save_source_file: at most 100 a run', async () => {
  const { calls, tools } = await fileRun(() => okFile())
  for (let i = 0; i < 100; i++) await tools.saveSourceFile!({ concept: 'chat', id: '-100', file: String(i) })
  await assert.rejects(tools.saveSourceFile!({ concept: 'chat', id: '-100', file: '100' }), /this run already saved 100 files/)
  assert.equal(calls.length, 100)
})

test('save_source_file: no tool, and no prompt line, without a source that serves files', async () => {
  const s = setup(), [t] = await targets(s.jobs, 1)
  await s.runner.ask(t.job, t.step, 'q')
  await until(() => s.sessions.length === 1)
  assert.equal(s.sessions[0].tools.saveSourceFile, undefined)
  assert.doesNotMatch(s.sessions[0].prompt, /save_source_file/)
  const f = await fileRun(() => okFile())
  assert.match(f.s.sessions[0].prompt, /save_source_file/)
})

test("an MCP server's refused or failed tool is a problem on the step; the run's calls of tools that change things go in the journal", async () => {
  const s = setup(), [t] = await targets(s.jobs, 1)
  await s.runner.ask(t.job, t.step, 'q')
  await until(() => s.sessions.length === 1)
  const tools = s.sessions[0].tools
  await tools.mcpProblem!('Refused mcp__ssh__sudo {}: it is not ticked. Not retried.')
  await tools.mcpActs!(['mcp__ssh__run', 'mcp__ssh__run', 'mcp__ssh__upload'])
  const j = (await s.jobs.get(t.job))!
  assert.deepEqual(j.flow[t.step].b.filter((b) => b.k === 'p').map((b) => b.t), ['Refused mcp__ssh__sudo {}: it is not ticked. Not retried.'])
  const last = j.jr[0]
  assert.deepEqual([last.a, last.o, last.c], ['console', 'The run called 3 MCP tools that change things.', 'mcp__ssh__run ×2, mcp__ssh__upload'])
})

const ASK = { srv: 'ssh', msg: 'Run rm -rf /tmp/ad26 on e2e?', schema: { type: 'object', properties: { ok: { type: 'boolean' }, why: { type: 'string' } }, required: ['ok'] }, title: 'Destructive command' }

test("a server's question waits on the run as cf until the person answers; the answer goes back to the server and into the journal", async () => {
  const s = setup(), [t] = await targets(s.jobs, 1)
  const r = await s.runner.ask(t.job, t.step, 'q')
  await until(() => s.sessions.length === 1)
  const answer = s.sessions[0].tools.elicit!(ASK, new AbortController().signal)
  await until(async () => !!(await s.runner.get(r.id))!.cf)
  const cf = (await s.runner.get(r.id))!.cf!
  assert.deepEqual({ ...cf, id: 'x', at: 'y' }, { ...ASK, id: 'x', at: 'y' })
  assert.ok(s.evs.some((e) => e.kind === 'run' && e.run.cf?.id === cf.id), 'the page hears of it')
  await assert.rejects(s.runner.elicitAnswer(r.id, { cf: 'other', action: 'accept', content: { ok: true } }), code(409, 'bad_state'))
  await assert.rejects(s.runner.elicitAnswer(r.id, { cf: cf.id, action: 'accept', content: { ok: 'yes' } }), code(400, 'bad_args'))
  await assert.rejects(s.runner.elicitAnswer(r.id, { cf: cf.id, action: 'accept', content: {} }), /ok is required/)
  const back = await s.runner.elicitAnswer(r.id, { cf: cf.id, action: 'accept', content: { ok: true } })
  assert.equal(back.cf, undefined, 'the page is answered with the question gone')
  assert.deepEqual(await answer, { action: 'accept', content: { ok: true } })
  assert.equal((await s.runner.get(r.id))!.cf, undefined)
  await assert.rejects(s.runner.elicitAnswer(r.id, { cf: cf.id, action: 'accept', content: { ok: true } }), code(409, 'bad_state'))
  const j = (await s.jobs.get(t.job))!, last = j.jr[0]
  assert.deepEqual([last.o, last.c], ['Confirmed what the MCP server ssh asked.', 'Run rm -rf /tmp/ad26 on e2e?'])
})

test("a declined question is a problem on the step; a question the run's end cuts off goes from the record", async () => {
  const s = setup(), [t] = await targets(s.jobs, 1)
  const r = await s.runner.ask(t.job, t.step, 'q')
  await until(() => s.sessions.length === 1)
  const a = s.sessions[0].tools.elicit!(ASK, new AbortController().signal)
  await until(async () => !!(await s.runner.get(r.id))!.cf)
  await s.runner.elicitAnswer(r.id, { cf: (await s.runner.get(r.id))!.cf!.id, action: 'decline' })
  assert.deepEqual(await a, { action: 'decline' })
  const j = (await s.jobs.get(t.job))!
  assert.deepEqual(j.flow[t.step].b.filter((b) => b.k === 'p').map((b) => b.t), ['Declined what the MCP server ssh asked: Run rm -rf /tmp/ad26 on e2e? Not retried.'])
  const ac = new AbortController(), b = s.sessions[0].tools.elicit!(ASK, ac.signal)
  await until(async () => !!(await s.runner.get(r.id))!.cf)
  ac.abort()
  await assert.rejects(b)
  await until(async () => !(await s.runner.get(r.id))!.cf)
})
