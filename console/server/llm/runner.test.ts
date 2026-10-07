import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as T from '../../src/model/transitions.ts'
import { Bus, HttpError } from '../events.ts'
import type { Ev } from '../events.ts'
import { Jobs } from '../jobs/jobs.ts'
import { fileStore } from '../store/file.ts'
import { demoCtx, demoSeed, fakeSdk } from '../testkit.ts'
import { GatewayError } from '../bridge/wire.ts'
import type { ConceptReply } from '../bridge/wire.ts'
import { notesStore } from '../knowledge/notes.ts'
import { resolveContext } from './context.ts'
import { buildPrompt } from './prompt.ts'
import { Runner, safeName } from './runner.ts'

const tick = () => new Promise((r) => setTimeout(r, 20))
async function until(f: () => boolean | Promise<boolean>) { const t0 = Date.now(); while (!(await f())) { if (Date.now() - t0 > 2000) throw new Error('timed out'); await tick() } }

function setup(open = { v: true }, extra: Partial<ConstructorParameters<typeof Runner>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wc-run-'))
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
  const dir = mkdtempSync(join(tmpdir(), 'wc-run-'))
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
  const dir = mkdtempSync(join(tmpdir(), 'wc-run-'))
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
  '- Save files the step expects with add_artifact(name, content), or with add_artifact_file(path) for a file already under your working dir; images show on the page.',
  '- Finish by calling submit_draft(text) exactly once with the draft for the user to review. Without it the run counts as failed.',
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
  assert.ok(p.endsWith('submit_draft(text) exactly once with the draft for the user to review. Without it the run counts as failed.\n\n'
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
  const out = mkdtempSync(join(tmpdir(), 'wc-out-')), secret = join(out, 'secret.txt')
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
  const out = mkdtempSync(join(tmpdir(), 'wc-out-')); writeFileSync(join(out, 'x.html'), 'x')
  await assert.rejects(tools.screenshot!({ url: pathToFileURL(join(out, 'x.html')).href, name: 'x' }), /outside the work dir/)
  await assert.rejects(tools.screenshot!({ url: 'javascript:alert(1)', name: 'x' }), /only http, https and file urls/)
  assert.equal(seen.length, 2, 'refused before any browser started')
  const plain = setup(), [p] = await targets(plain.jobs, 1)
  await plain.runner.ask(p.job, p.step, 'q')
  await until(() => plain.sessions.length === 1)
  assert.equal(plain.sessions[0].tools.screenshot, undefined)
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
