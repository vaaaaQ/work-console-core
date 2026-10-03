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
import { resolveContext } from './context.ts'
import { buildPrompt } from './prompt.ts'
import { Runner, safeName } from './runner.ts'

const tick = () => new Promise((r) => setTimeout(r, 20))
async function until(f: () => boolean) { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > 2000) throw new Error('timed out'); await tick() } }

function setup(open = { v: true }) {
  const dir = mkdtempSync(join(tmpdir(), 'wc-run-'))
  const store = fileStore(join(dir, 's.json'), demoSeed)
  const bus = new Bus(), evs: Ev[] = []
  bus.on((e) => evs.push(e))
  const jobs = new Jobs({ store, bus, ctx: demoCtx, gate: () => open.v })
  const { sdk, sessions } = fakeSdk()
  const mk = () => new Runner({ store, jobs, bus, sdk, cwd: dir, gate: () => open.v, artifactsDir: join(dir, 'arts'), ctx: demoCtx })
  return { store, jobs, bus, evs, sessions, runner: mk(), mk, open, dir }
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
  const { runner, sessions, jobs, open } = setup(), [a, b] = await targets(jobs, 2)
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
  await tick(); await tick()
  assert.equal(await state(runner, r2.id), 'failed')
  await assert.rejects(runner.resume(r2.id), code(409, 'no_session'))
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
  assert.ok(p.indexOf('## Context') > p.indexOf('Instruction: q') && p.indexOf('## Context') < p.indexOf('## How to work'))
  sessions[0].push({ k: 'session', id: 'sess-1' })
  await tick()
  await runner.interruptAll('the bridge went away')
  const n = seen.length
  await runner.resume(r.id)
  await until(() => sessions.length === 2)
  assert.equal(seen.length, n, 'a resumed run reads no context')
})

/* a fixed job, so the prompt text can be compared word for word */
function promptJob() {
  const j = demoSeed().jobs!.find((x) => x.id === 'J-0420')!
  j.jr = [{ ts: '2026-10-01T09:00:00.000Z', a: 'you', o: 'Created the job', c: 'playbook Action', n: 'work on the last step' }]
  return j
}
/* captured from buildPrompt before it took `me` */
const PROMPT_BEFORE_ME = [
  "You are working one step of a job in the user's Work Console.",
  '',
  'Job J-0420: Reply to Sam about rate limiting',
  'Key: CHAT · playbook: Action · project: platform',
  'Step: Send it',
  'Exit criterion: Sent',
  '',
  'Instruction: Draft the reply.',
  '',
  '## Earlier outputs',
  '### Draft the answer',
  'hi Sam,',
  'rate limiting is in review (PR #482), one approval left. I will write here once it is on staging.',
  '',
  '## Journal (latest last)',
  '- 2026-10-01T09:00:00.000Z you: Created the job → playbook Action Next: work on the last step',
  '',
  '## How to work',
  '- The context above was read when this run started. Read anything more yourself with the bridge tools (bridge_snapshot, bridge_get).',
  '- You never send anything to a source (no chat posts, mails, votes, comments or state changes): the user sends after review.',
  '- Write progress with the run tool journal(observed, changed, next) at meaningful points.',
  '- Save files the step expects with add_artifact(name, content), or with add_artifact_file(path) for a file already under your working dir; images show on the page.',
  '- Finish by calling submit_draft(text) exactly once with the draft for the user to review. Without it the run counts as failed.',
].join('\n')

test('a prompt names the user it was given; without one it is the text it always was', () => {
  const x = demoCtx(), j = promptJob()
  assert.equal(buildPrompt(x, j, 'sn', 'Draft the reply.'), PROMPT_BEFORE_ME)
  assert.equal(buildPrompt(x, j, 'sn', 'Draft the reply.', [], 'the user'), PROMPT_BEFORE_ME)
  assert.equal(buildPrompt(x, j, 'sn', 'Draft the reply.', [], ''), PROMPT_BEFORE_ME, 'an empty name is no name')
  const p = buildPrompt(x, j, 'sn', 'Draft the reply.', [], 'Alex')
  assert.match(p, /in Alex's Work Console/)
  assert.match(p, /: Alex sends after review\./)
  assert.match(p, /the draft for Alex to review\./)
  assert.ok(!/the user/.test(p), 'no phrase still says "the user"')
  assert.equal(p, PROMPT_BEFORE_ME.replaceAll("the user's Work Console", "Alex's Work Console").replace('the user sends', 'Alex sends').replace('for the user to review', 'for Alex to review'))
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

test('a workspace without a gateway: the prompt does not point at the bridge tools, and the rest is unchanged', async () => {
  const x = demoCtx(), j = promptJob()
  const line = '\n- The context above was read when this run started. Read anything more yourself with the bridge tools (bridge_snapshot, bridge_get).'
  assert.equal(buildPrompt(x, j, 'sn', 'Draft the reply.', [], undefined, { bridge: false }), PROMPT_BEFORE_ME.replace(line, ''))
  assert.equal(buildPrompt(x, j, 'sn', 'Draft the reply.', [], undefined, { bridge: true }), PROMPT_BEFORE_ME)
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
  const s = setup(), [t] = await targets(s.jobs, 1), seen: { url: string; out: string; width?: number }[] = []
  const screenshot = async (o: { url: string; out: string; width?: number }) => { seen.push(o); writeFileSync(o.out, 'png') }
  const runner = new Runner({ store: s.store, jobs: s.jobs, bus: s.bus, sdk: fakeSdk(s.sessions).sdk, cwd: s.dir, gate: () => true, artifactsDir: join(s.dir, 'arts'), ctx: demoCtx, screenshot })
  await runner.ask(t.job, t.step, 'q')
  await until(() => s.sessions.length === 1)
  const tools = s.sessions[0].tools
  await tools.screenshot!({ url: 'http://127.0.0.1:7420/jobs', name: 'board.jpg', width: 900 })
  assert.equal(seen[0].url, 'http://127.0.0.1:7420/jobs'); assert.equal(seen[0].width, 900)
  assert.equal(seen[0].out, join(s.dir, 'arts', t.job, 'board.png'))
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
