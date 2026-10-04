import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FMT } from '../../src/model/pbFormat.ts'
import type { PbFile } from '../../src/model/pbFormat.ts'
import { DESC_MAX } from '../../src/model/transitions.ts'
import type { Playbook, Step } from '../../src/model/types.ts'
import type { ConceptReply } from '../bridge/wire.ts'
import { Bus, HttpError } from '../events.ts'
import type { Ev } from '../events.ts'
import { notesStore } from '../knowledge/notes.ts'
import { acme, demoCtx } from '../testkit.ts'
import { FORM_SCHEMA, SYSTEM, buildIn, buildPrompt, buildTools, builder, checkForm, dueAt, formOut, freeKey, nowLine, toolLine } from './builder.ts'
import type { BuildForm, BuilderOpts, SourceReader } from './builder.ts'
import type { AskEvent, AskTool, Sdk } from './sdk.ts'

const HOME = 'America/Sao_Paulo'
/** a Sunday, 14:05 at home */
const NOW = new Date('2026-10-04T17:05:00Z')
const step = (id: string, t: string, m: Step['m']): Step => ({ id, t, m, x: 'done' })
/** the demo catalog with what dev-item's jobs need, beside a playbook of another workspace and one job's own steps */
function catalog(): Record<string, Playbook> {
  const PB = demoCtx().PB
  PB['dev-item'] = { ...PB['dev-item'], needs: 'the work item and its chat' }
  PB['beta-flow'] = { ws: 'beta', n: 'Beta flow', ph: [{ c: 'B', n: 'Beta', s: [step('b1', 'Beta step', 'you')] }] }
  PB['once-fix-login'] = { ws: 'acme', n: 'Fix login', once: 1, ph: [{ c: 'F', n: 'Fix', s: [step('f1', 'Fix it', 'llm')] }] }
  return PB
}
const PB = catalog()
const empty = (o: Partial<BuildForm> = {}): BuildForm => ({ t: '', key: '', prj: '', pb: '', d: '', ctx: [], due: '', npb: null, why: [], ...o })
const opts = (o: Partial<Parameters<typeof checkForm>[1]> = {}) => ({ ws: 'acme', form: empty(), PB, prj: acme.pack.prj, tz: HOME, ...o })
/** an answer that settles everything, for the tests to change one field of */
const ANS = { title: 'Weekly report', key: 'weekly-report', project: 'ops', playbook: 'action', description: 'Send it.', context: [], due: '', problems: [] }
const NEW = {
  once: false, key: 'weekly-report', name: 'Weekly report', description: 'Collect and send the weekly report',
  phases: [{
    code: 'W', name: 'Write', steps: [
      { id: 'draft', title: 'Draft the report', who: 'llm', doneWhen: 'a draft is ready', output: 'report' },
      { id: 'send', title: 'Send it', who: 'you', doneWhen: 'it is sent', messages: [{ via: 'mail', to: 'team', text: '{report}' }] },
    ],
  }],
}
const NEW_FILE: PbFile = {
  format: FMT, key: 'weekly-report', name: 'Weekly report', description: 'Collect and send the weekly report', workspace: 'acme',
  phases: [{
    code: 'W', name: 'Write', steps: [
      { id: 'draft', title: 'Draft the report', who: 'llm', doneWhen: 'a draft is ready', output: 'report' },
      { id: 'send', title: 'Send it', who: 'you', doneWhen: 'it is sent', messages: [{ via: 'mail', to: 'team', text: '{report}' }] },
    ],
  }],
}
const refused = (status: number, code: string) => (e: unknown) => e instanceof HttpError && e.status === status && e.code === code

/* ===== what the page sends ===== */

test('a build needs an id and at least one say; the form is read leniently', () => {
  const b = buildIn({
    id: 'b-1', say: [' make a job ', '', 3, '  '],
    form: {
      t: 'T', pb: 7,
      ctx: [{ k: 'work', id: ' ACME-7 ', n: 99 }, { k: 'mail', id: 'm1', n: 4 }, { k: 'chat', id: 'c4', name: ' Sam ' }, { k: 'file', id: 'x' }, { k: 'note' }, 'junk'],
      npb: { once: 'yes', file: { name: 'S', phases: [] } },
    },
  })
  assert.deepEqual(b, {
    id: 'b-1', say: ['make a job'],
    form: {
      t: 'T', key: '', prj: '', pb: '', d: '', due: '', why: [],
      ctx: [{ k: 'work', id: 'ACME-7', n: 20 }, { k: 'mail', id: 'm1', n: 1 }, { k: 'chat', id: 'c4', n: 10, name: 'Sam' }],
      npb: { once: false, file: { name: 'S', phases: [] } },
    },
  })
  assert.equal(buildIn({ id: 'b', say: ['x'] }).form.npb, null)
  assert.equal(buildIn({ id: 'b', say: ['x'], form: { npb: { once: true, file: [] } } }).form.npb, null)
  for (const bad of [{ say: ['x'] }, { id: '', say: ['x'] }, { id: 'a b', say: ['x'] }, { id: 'x'.repeat(65), say: ['x'] }, { id: 'b' }, { id: 'b', say: [] }, { id: 'b', say: ['  ', 4] }, { id: 'b', say: 'make a job' }])
    assert.throws(() => buildIn(bad), refused(400, 'bad_args'), JSON.stringify(bad))
})

/* ===== the answer, checked ===== */

test('a catalog playbook, the project and the context as a job keeps them; a day alone is due at 18:00 home time', () => {
  const f = checkForm({
    ...ANS, title: ' Fix the login page ', key: 'ACME-7', project: 'web', playbook: 'dev-item', description: ' Fix it. ',
    context: [{ k: 'work', id: 'ACME-7' }, { k: 'chat', id: 'c4', n: 99, name: ' Sam Rivera ' }, { k: 'mail', id: 'm1', n: 5 }, { k: 'work', id: 'ACME-7', n: 3 }, { k: 'note', id: 'login-flow' }],
    due: '2026-10-09',
  }, opts())
  assert.deepEqual(f, {
    t: 'Fix the login page', key: 'ACME-7', prj: 'web', pb: 'dev-item', d: 'Fix it.', due: '2026-10-09T21:00:00.000Z', npb: null, why: [],
    ctx: [{ k: 'work', id: 'ACME-7', n: 10 }, { k: 'chat', id: 'c4', n: 50, name: 'Sam Rivera' }, { k: 'mail', id: 'm1', n: 1 }, { k: 'note', id: 'login-flow', n: 1 }],
  })
  // the core's playbooks are offered in every workspace
  assert.deepEqual(checkForm(ANS, opts()).why, [])
})

test('what fails a check stays in the form, its problem in why, the session\'s own last', () => {
  const f = checkForm({
    ...ANS, project: 'mobile', playbook: 'nope', description: 'x'.repeat(DESC_MAX + 1),
    context: [{ k: 'work', id: 'hello' }, { k: 'file', id: 'x' }, { k: 'chat', id: '  ' }, { k: 'chat', id: 'c4' }],
    due: 'next friday', problems: [' Which chat? ', '', 7],
  }, opts({ form: empty({ due: '2026-10-08T21:00:00.000Z' }) }))
  assert.equal(f.pb, 'nope'); assert.equal(f.prj, 'mobile'); assert.equal(f.d.length, DESC_MAX + 1)
  assert.deepEqual(f.ctx, [{ k: 'chat', id: 'c4', n: 10 }])
  assert.equal(f.due, '2026-10-08T21:00:00.000Z', 'a due that is not a date keeps the form\'s')
  assert.deepEqual(f.why, [
    "Playbook nope is not one of this workspace's.",
    "Project mobile is not one of this workspace's (platform, web, ops).",
    `The description is longer than ${DESC_MAX} characters.`,
    'Context work hello was left out: hello is not a work item id.',
    'Context file x was left out: unknown context kind file.',
    'Context chat ? was left out: a context item needs an id.',
    'Due “next friday” is not a date.',
    'Which chat?',
  ])
  for (const pb of ['beta-flow', 'once-fix-login'])
    assert.deepEqual(checkForm({ ...ANS, playbook: pb }, opts()).why, [`Playbook ${pb} is not one of this workspace's.`], pb)
  assert.deepEqual(checkForm({ ...ANS, project: '' }, opts()).why, [], 'no project is no problem')
})

test('new steps are saved under a free key: their slug, once- for one job, -2 past a key in use, the own key kept', () => {
  const a = checkForm({ ...ANS, playbook: '', newPlaybook: NEW }, opts())
  assert.equal(a.pb, 'weekly-report')
  assert.deepEqual(a.npb, { once: false, file: NEW_FILE })
  assert.deepEqual(a.why, [])
  assert.equal(checkForm({ ...ANS, playbook: '', newPlaybook: { ...NEW, once: true } }, opts()).pb, 'once-weekly-report')
  assert.equal(checkForm({ ...ANS, playbook: '', newPlaybook: { ...NEW, once: true, key: 'once-weekly' } }, opts()).pb, 'once-weekly')
  assert.equal(checkForm({ ...ANS, playbook: '', newPlaybook: { ...NEW, key: 'once-weekly' } }, opts()).pb, 'weekly', 'a saved playbook never starts with once-')
  assert.equal(checkForm({ ...ANS, playbook: '', newPlaybook: { ...NEW, key: '' } }, opts()).pb, 'weekly-report', 'no key: the name')
  assert.equal(checkForm({ ...ANS, title: 'Tidy up', playbook: '', newPlaybook: { ...NEW, key: '', name: '' } }, opts()).pb, 'tidy-up', 'no name: the title')
  const PB2 = { ...PB, 'weekly-report': PB.action }
  assert.equal(checkForm({ ...ANS, playbook: '', newPlaybook: NEW }, opts({ PB: PB2 })).pb, 'weekly-report-2')
  assert.equal(checkForm({ ...ANS, playbook: '', newPlaybook: NEW }, opts({ taken: (k) => k === 'weekly-report' })).pb, 'weekly-report-2', 'a key another workspace holds')
  // a second say rewrites the form's unsaved steps, which keep their key
  const own = empty({ pb: 'weekly-report-2', npb: { once: false, file: { ...NEW_FILE, key: 'weekly-report-2' } } })
  assert.equal(checkForm({ ...ANS, playbook: '', newPlaybook: NEW }, opts({ PB: PB2, form: own })).pb, 'weekly-report-2')
  assert.equal(checkForm({ ...ANS, playbook: 'weekly-report-2', newPlaybook: NEW }, opts({ PB: PB2, form: own })).pb, 'weekly-report-2')
  assert.equal(freeKey('', false, PB, null), 'steps')
  assert.equal(freeKey('Action', false, PB, null), 'action-2')
})

test('a catalog playbook named beside new steps wins; an unknown one does not; both empty keep the form\'s choice', () => {
  const cat = checkForm({ ...ANS, playbook: 'dev-item', newPlaybook: NEW }, opts())
  assert.equal(cat.pb, 'dev-item'); assert.equal(cat.npb, null)
  const unknown = checkForm({ ...ANS, playbook: 'nope', newPlaybook: NEW }, opts())
  assert.equal(unknown.pb, 'weekly-report'); assert.deepEqual(unknown.npb?.file, NEW_FILE)
  assert.equal(checkForm({ ...ANS, playbook: '' }, opts({ form: empty({ pb: 'dev-item' }) })).pb, 'dev-item')
  const kept = checkForm({ ...ANS, playbook: '' }, opts({ form: empty({ pb: 'once-weekly', npb: { once: true, file: { ...NEW_FILE, key: 'once-weekly', phases: [] } } }) }))
  assert.equal(kept.pb, 'once-weekly'); assert.equal(kept.npb?.once, true)
  assert.deepEqual(kept.why, ['New steps: Add at least one phase.'], 'kept steps are checked again')
  assert.deepEqual(checkForm({ ...ANS, playbook: '' }, opts()).why, ['No playbook yet: name one, or say what its steps are.'])
})

test("new steps pass Add playbook's checks, an output is one word, and a message names only what a step fills", () => {
  const bad = {
    ...NEW, phases: [{
      code: 'WRITE1', name: 'Write', steps: [
        { id: 'draft', title: 'Draft', who: 'llm', doneWhen: 'drafted', output: 'the report' },
        { id: 'send', title: 'Send', who: 'you', doneWhen: 'sent', messages: [{ via: 'chat', text: 'Hi {po}, {report} and {answer} for {key}' }] },
      ],
    }],
  }
  assert.deepEqual(checkForm({ ...ANS, playbook: '', newPlaybook: bad }, opts()).why, [
    'New steps: Phase 1 (Write): code must be 1–4 letters or digits.',
    'New steps: Step “draft”: output must be one word of letters, digits or _.',
    'New steps: Step “send”: a message names {report}, which no step fills.',
    'New steps: Step “send”: a message names {answer}, which no step fills.',
  ])
})

test('a due as the session writes it: a day alone is 18:00, a time without an offset is home time, one with an offset is kept', () => {
  assert.equal(dueAt('2026-10-09', HOME), Date.parse('2026-10-09T21:00:00Z'))
  assert.equal(dueAt('2026-10-09T09:30', HOME), Date.parse('2026-10-09T12:30:00Z'))
  assert.equal(dueAt('2026-10-09 09:30:15', HOME), Date.parse('2026-10-09T12:30:15Z'))
  assert.equal(dueAt('2026-10-09T09:30:00+02:00', HOME), Date.parse('2026-10-09T07:30:00Z'))
  assert.equal(dueAt('2026-10-09T09:30:00Z', HOME), Date.parse('2026-10-09T09:30:00Z'))
  assert.ok(Number.isNaN(dueAt('friday', HOME)))
})

/* ===== the prompt ===== */

const NOTES = [
  { id: 'login-flow', v: 1, title: 'How login works', tags: ['auth', 'web'], playbooks: ['dev-item'], updated: '', size: 10 },
  { id: 'style', v: 1, title: 'Style', tags: [], playbooks: [], updated: '', size: 1 },
]

test('the prompt: the workspace, now at home, the catalog with what its jobs need, the note index, the form, then every say', () => {
  const form = empty({ t: 'Old title', pb: 'dev-item', due: '2026-10-09T21:00:00.000Z', ctx: [{ k: 'chat', id: 'c4', n: 10, name: 'Sam Rivera' }] })
  const p = buildPrompt({ page: acme, PB, notes: NOTES, form, say: ['make a job for ACME-7', 'actually it is due friday\nat noon'], now: NOW, tz: HOME, sources: true })
  const at = ['# Workspace', '# Playbooks', '# Knowledge notes', '# Sources', '# The form now', '# What the user said, oldest first'].map((h) => p.indexOf(`${h}\n`))
  assert.ok(at.every((x, i) => x >= 0 && (i === 0 || x > at[i - 1])), String(at))
  for (const l of [
    'acme: Acme (Jira, GitHub, Slack, Jenkins, Zoom, Confluence)', 'Projects: platform, web, ops', "A work item's key looks like ACME-123.",
    'Now: Sunday 2026-10-04 14:05, Sao Paulo time (UTC-03:00)',
    '- action: Action — Short task: reply, triage, one-off request',
    '- dev-item: Dev item — Issue from analysis to QA hand-off', '  needs: the work item and its chat',
    '  AN Analysis: Read the issue (LLM); Read the linked docs (LLM); Questions to the PO (you)',
    '- login-flow: How login works · tags auth, web · read by every run of dev-item', '- style: Style',
    'source_list lists the work items, chats and mail with their ids; source_get reads one.',
  ]) assert.ok(p.split('\n').includes(l), l)
  assert.ok(!p.includes('beta-flow') && !p.includes('once-fix-login'), 'no playbook of another workspace, no one job\'s steps')
  assert.ok(!p.includes('The user is'), 'Acme names no user')
  assert.deepEqual(JSON.parse(p.split('```json\n')[1].split('\n```')[0]), {
    title: 'Old title', key: '', project: '', playbook: 'dev-item', description: '', context: [{ k: 'chat', id: 'c4', n: 10, name: 'Sam Rivera' }], due: '2026-10-09T18:00:00-03:00',
  })
  assert.ok(p.endsWith('# What the user said, oldest first\n1. make a job for ACME-7\n2. actually it is due friday\n   at noon'))
  const bare = buildPrompt({ page: { ...acme, me: 'Sam Rivera' }, PB: {}, notes: [], form: empty(), say: ['x'], now: NOW, tz: HOME, sources: false })
  for (const l of ['The user is Sam Rivera.', 'This workspace has no sources to read: context can name notes, and ids the user said.'])
    assert.ok(bare.split('\n').includes(l), l)
  assert.match(bare, /# Playbooks\nnone\n/); assert.match(bare, /# Knowledge notes\nnone\n/)
})

test('now in any zone, with its offset; the form as the prompt shows it reads back as the same form', () => {
  assert.equal(nowLine(NOW, 'Asia/Kolkata'), 'Sunday 2026-10-04 22:35, Kolkata time (UTC+05:30)')
  assert.equal(nowLine(NOW, 'UTC'), 'Sunday 2026-10-04 17:05, UTC time (UTC+00:00)')
  const f = checkForm({ ...ANS, playbook: '', newPlaybook: NEW, due: '2026-10-09T09:30', context: [{ k: 'work', id: 'ACME-7', n: 3, name: 'ACME-7' }] }, opts())
  const shown = formOut(f, HOME)
  assert.equal(shown.playbook, ''); assert.equal(shown.newPlaybook?.key, 'weekly-report'); assert.equal(shown.due, '2026-10-09T09:30:00-03:00')
  assert.deepEqual(checkForm({ ...shown, problems: [] }, opts({ form: f })), f)
})

/* ===== the tools ===== */

function reader(lists: Record<string, ConceptReply>, items: Record<string, ConceptReply> = {}) {
  const r = {
    reads: [] as string[][],
    async read(cs: string[]) { r.reads.push(cs); return Object.fromEntries(cs.map((c) => [c, lists[c] ?? { status: 'not_found' }])) },
    async get(c: string, id: string): Promise<ConceptReply> { return items[`${c}/${id}`] ?? { status: 'not_found', message: `no ${c} ${id}` } },
  }
  return r satisfies SourceReader
}
const tool = (ts: AskTool[], name: string) => ts.find((t) => t.name === name)!
async function notes() {
  const kn = notesStore(join(mkdtempSync(join(tmpdir(), 'wc-build-')), 'kn'))
  await kn.save(null, { title: 'How login works', tags: ['auth', 'web'], playbooks: ['dev-item'], text: 'The login page calls the auth service.' }, null)
  await kn.save(null, { title: 'Style', tags: [], playbooks: [], text: 'Short sentences.' }, null)
  return kn
}
const WORK = [
  { id: 'ACME-1', type: 'Bug', title: 'Login fails', state: 'Active', assignedTo: 'Sam Rivera', changedAt: '2026-10-01T10:00:00Z' },
  { id: 'ACME-2', type: 'Task', title: 'Write the\n release notes', state: 'New', assignedTo: '', changedAt: '2026-10-03T10:00:00Z' },
]

test('the knowledge tools search and read the notes; without a gateway there are no others', async () => {
  const kn = await notes(), ts = buildTools({ ws: 'acme', notes: kn, source: null, key: (id) => id })
  assert.deepEqual(ts.map((t) => t.name), ['knowledge_search', 'knowledge_read'])
  assert.match(await tool(ts, 'knowledge_search').run({ q: 'login' }), /^- how-login-works: How login works \(tags auth, web\) The login page/)
  assert.equal(await tool(ts, 'knowledge_search').run({ q: 'zzz' }), 'no note matches')
  assert.ok((await tool(ts, 'knowledge_read').run({ id: 'how-login-works' })).startsWith('# How login works\nid how-login-works · v1 · tags auth, web · playbooks dev-item\n\nThe login page'))
  await assert.rejects(tool(ts, 'knowledge_read').run({ id: 'nope' }), /does not exist/)
})

test('source_list: newest first, one line each with its id, q keeping lines with every word, at most 50', async () => {
  const src = reader({
    work: { status: 'ok', items: WORK },
    chat: { status: 'ready', items: [{ id: 'c4', name: 'Sam Rivera', kind: 'dm', unread: 2, lastAt: '2026-10-04T09:00:00Z', lastFrom: 'Sam', lastPreview: 'can you look\nat the login?' }] },
    mail: { status: 'stale', message: 'the mailbox is signed out' },
  })
  const key = (id: string) => { if (id === 'ACME-2') throw new Error('no key'); return id === 'ACME-1' ? 'LOGIN-1' : id }
  const ts = buildTools({ ws: 'acme', notes: await notes(), source: src, key }), list = tool(ts, 'source_list')
  assert.deepEqual(ts.map((t) => t.name), ['knowledge_search', 'knowledge_read', 'source_list', 'source_get'])
  assert.equal(await list.run({ kind: 'work' }), [
    '- ACME-2: Write the release notes · Task · New · unassigned · changed 2026-10-03T10:00:00Z',
    '- ACME-1 (LOGIN-1): Login fails · Bug · Active · Sam Rivera · changed 2026-10-01T10:00:00Z',
  ].join('\n'))
  assert.equal(await list.run({ kind: 'work', q: 'LOGIN sam' }), '- ACME-1 (LOGIN-1): Login fails · Bug · Active · Sam Rivera · changed 2026-10-01T10:00:00Z')
  assert.equal(await list.run({ kind: 'work', q: 'zzz' }), 'no work items match')
  assert.equal(await list.run({ kind: 'chat' }), '- c4: Sam Rivera (dm) · 2 unread · last 2026-10-04T09:00:00Z Sam: can you look at the login?')
  assert.equal(await list.run({ kind: 'mail' }), 'unavailable: the mailbox is signed out')
  assert.deepEqual(src.reads, [['work'], ['work'], ['work'], ['chat'], ['mail']], 'one concept per call')
  const many = Array.from({ length: 60 }, (_, i) => ({ id: `ACME-${i + 1}`, title: 'T', changedAt: new Date(Date.UTC(2026, 8, 1) + i * 3600e3).toISOString() }))
  const big = tool(buildTools({ ws: 'acme', notes: await notes(), source: reader({ work: { status: 'ok', items: many } }), key: (id) => id }), 'source_list')
  const lines = (await big.run({ kind: 'work' })).split('\n')
  assert.equal(lines.length, 51); assert.match(lines[0], /^- ACME-60: /); assert.equal(lines[50], '(10 more; narrow with q)')
  assert.equal(await tool(buildTools({ ws: 'acme', notes: await notes(), source: reader({ mail: { status: 'ok', items: [] } }), key: (id) => id }), 'source_list').run({ kind: 'mail' }), 'no mail')
})

test('source_get reads one item as a run of the job would get it', async () => {
  const src = reader({}, {
    'work/ACME-7': { status: 'ok', items: { type: 'Bug', title: 'Login fails', state: 'Active', assignedTo: 'Sam Rivera', description: 'It fails.', comments: [{ author: 'Sam', at: '2026-10-01T10:00:00Z', text: 'still broken' }] } },
    'mail/m1': { status: 'ok', items: { body: 'Hello there' } },
  })
  const get = tool(buildTools({ ws: 'acme', notes: await notes(), source: src, key: (id) => id }), 'source_get')
  assert.ok((await get.run({ kind: 'work', id: 'ACME-7' })).startsWith('Work item ACME-7 (last 10 comments)\n\nBug ACME-7: Login fails\nState Active · assigned to Sam Rivera'))
  assert.match(await get.run({ kind: 'work', id: 'ACME-7', n: 3 }), /^Work item ACME-7 \(last 3 comments\)/)
  assert.match(await get.run({ kind: 'work', id: 'ACME-7', n: 99 }), /^Work item ACME-7 \(last 20 comments\)/)
  assert.equal(await get.run({ kind: 'mail', id: 'm1' }), 'Mail m1 (the whole message)\n\nHello there')
  assert.equal(await get.run({ kind: 'chat', id: 'c9' }), 'unavailable: no chat c9')
  await assert.rejects(get.run({ kind: 'work', id: 'hello' }), /not a work item id/)
})

test('a tool call as the page shows it', () => {
  assert.equal(toolLine('knowledge_search', { q: 'login' }), 'Searching notes for “login”')
  assert.equal(toolLine('knowledge_search', {}), 'Listing notes')
  assert.equal(toolLine('knowledge_search', { q: 'a'.repeat(100) }), `Searching notes for “${'a'.repeat(59)}…”`)
  assert.equal(toolLine('knowledge_read', { id: 'login-flow' }), 'Reading note login-flow')
  assert.equal(toolLine('source_list', { kind: 'chat' }), 'Listing chats')
  assert.equal(toolLine('source_list', { kind: 'work', q: 'login' }), 'Listing work items matching “login”')
  assert.equal(toolLine('source_get', { kind: 'work', id: 'ACME-7' }), 'Reading work item ACME-7')
  assert.equal(toolLine('source_get', { kind: 'mail', id: 'm1' }), 'Reading mail m1')
  assert.equal(toolLine('source_get', { kind: 'nope', id: 'x' }), 'Using source_get')
  assert.equal(toolLine('StructuredOutput', {}), 'Using StructuredOutput')
})

test("the answer's schema: every field required, nothing else allowed, the context kinds the console knows", () => {
  assert.deepEqual(FORM_SCHEMA.required, ['title', 'key', 'project', 'playbook', 'description', 'context', 'due', 'problems'])
  assert.equal(FORM_SCHEMA.additionalProperties, false)
  assert.deepEqual(FORM_SCHEMA.properties.context.items.properties.k.enum, ['work', 'chat', 'mail', 'note'])
  assert.equal(FORM_SCHEMA.properties.newPlaybook.additionalProperties, false)
})

/* ===== a build ===== */

type AskOpts = Parameters<NonNullable<Sdk['ask']>>[0]
/** an SDK whose ask plays the script; start is never called by a build */
function askSdk(script: (o: AskOpts) => AsyncIterable<AskEvent>) {
  const calls: AskOpts[] = []
  const sdk: Sdk = { start: () => { throw new Error('a build starts no run') }, ask: (o) => { calls.push(o); return script(o) } }
  return { calls, sdk }
}
/** waits until the ask is aborted, then fails as the SDK does */
const hang = (o: AskOpts) => new Promise<never>((_ok, no) => o.abort.signal.addEventListener('abort', () => no(new Error('aborted')), { once: true }))
const ANSWER = { ...ANS, title: 'Fix login', key: 'ACME-7', project: 'web', playbook: 'dev-item', description: 'Fix it', context: [{ k: 'work', id: 'ACME-7' }] }
function setup(sdk: Sdk, o: Partial<BuilderOpts> = {}) {
  const bus = new Bus(), evs: Ev[] = [], dir = mkdtempSync(join(tmpdir(), 'wc-build-'))
  bus.on((e) => evs.push(e))
  const build = builder({ ws: 'acme', page: acme, sdk, notes: notesStore(join(dir, 'kn')), source: null, ctx: () => ({ ...demoCtx(), PB }), bus, cwd: join(dir, 'run'), now: () => NOW, ...o })
  return { build, evs, dir }
}
const B = { id: 'b1', say: ['fix the login, ACME-7'], form: empty() }

test('a build: one ask with the prompt, the schema and only its own tools; each tool call is a build event; the answer comes back checked', async () => {
  const { calls, sdk } = askSdk(async function* () {
    yield { k: 'tool', name: 'knowledge_search', input: { q: 'login' } }
    yield { k: 'tool', name: 'source_list', input: { kind: 'work', q: 'login' } }
    yield { k: 'result', ok: true, out: ANSWER }
  })
  const { build, evs, dir } = setup(sdk, { source: reader({}) })
  assert.deepEqual(await build(B, { tz: HOME }), {
    t: 'Fix login', key: 'ACME-7', prj: 'web', pb: 'dev-item', d: 'Fix it', ctx: [{ k: 'work', id: 'ACME-7', n: 10 }], due: '', npb: null, why: [],
  })
  assert.equal(calls.length, 1)
  const c = calls[0]
  assert.equal(c.system, SYSTEM); assert.equal(c.schema, FORM_SCHEMA)
  assert.deepEqual(c.tools.map((t) => t.name), ['knowledge_search', 'knowledge_read', 'source_list', 'source_get'])
  assert.match(c.prompt, /^1\. fix the login, ACME-7$/m)
  assert.match(c.prompt, /^Now: Sunday 2026-10-04 14:05, Sao Paulo time \(UTC-03:00\)$/m)
  assert.equal(c.cwd, join(dir, 'run')); assert.ok(existsSync(c.cwd), 'the session runs in a folder of its own')
  assert.deepEqual(evs, [
    { kind: 'build', id: 'b1', t: 'Started' },
    { kind: 'build', id: 'b1', t: 'Searching notes for “login”', tool: 'knowledge_search' },
    { kind: 'build', id: 'b1', t: 'Listing work items matching “login”', tool: 'source_list' },
  ])
})

test('a workspace without a gateway: no source tools, and the prompt says so; notes that fail to list leave the index empty', async () => {
  const { calls, sdk } = askSdk(async function* () { yield { k: 'result', ok: true, out: ANSWER } })
  const broken = { list: async () => { throw new Error('disk gone') }, search: async () => [], read: async () => { throw new Error('disk gone') } }
  await setup(sdk, { notes: broken }).build(B, { tz: HOME })
  assert.deepEqual(calls[0].tools.map((t) => t.name), ['knowledge_search', 'knowledge_read'])
  assert.match(calls[0].prompt, /This workspace has no sources to read/)
  assert.match(calls[0].prompt, /# Knowledge notes\nnone\n/)
})

test('new steps take a key no workspace holds', async () => {
  const { sdk } = askSdk(async function* () { yield { k: 'result', ok: true, out: { ...ANSWER, playbook: '', newPlaybook: NEW } } })
  const f = await setup(sdk).build(B, { tz: HOME, taken: (k) => k === 'weekly-report' })
  assert.equal(f.pb, 'weekly-report-2'); assert.equal(f.npb?.file.key, 'weekly-report-2')
})

test('the ends of a build: no ask, a page gone before or during it, too slow, signed out, failed', async () => {
  await assert.rejects(setup({ start: () => { throw new Error('no') } }).build(B, { tz: HOME }), refused(501, 'no_builder'))

  const gone = new AbortController(); gone.abort()
  const early = askSdk(async function* (o) { await hang(o) }), e = setup(early.sdk)
  await assert.rejects(e.build(B, { tz: HOME, signal: gone.signal }), refused(499, 'aborted'))
  assert.equal(early.calls.length, 0); assert.deepEqual(e.evs, [])

  let asked!: () => void
  const on = new Promise<void>((r) => { asked = r }), page = new AbortController()
  const mid = askSdk(async function* (o) { asked(); await hang(o) })
  const p = setup(mid.sdk).build(B, { tz: HOME, signal: page.signal })
  await on; page.abort()
  await assert.rejects(p, refused(499, 'aborted'))
  assert.equal(mid.calls[0].abort.signal.aborted, true, 'the session is stopped')

  await assert.rejects(setup(askSdk(async function* (o) { await hang(o) }).sdk, { timeoutMs: 30 }).build(B, { tz: HOME }), refused(504, 'timeout'))
  // an answer that came in before the abort is still the answer
  const late = await setup(askSdk(async function* (o) { yield { k: 'result', ok: true, out: ANSWER }; await hang(o) }).sdk, { timeoutMs: 30 }).build(B, { tz: HOME })
  assert.equal(late.pb, 'dev-item')

  const said = (r: AskEvent) => setup(askSdk(async function* () { yield r }).sdk).build(B, { tz: HOME })
  await assert.rejects(said({ k: 'result', ok: false, error: 'signin_required: 401 Unauthorized' }), refused(503, 'signin_required'))
  await assert.rejects(said({ k: 'result', ok: false, error: 'max turns' }), (x: unknown) => refused(502, 'build_failed')(x) && (x as Error).message === 'max turns')
  await assert.rejects(setup(askSdk(async function* () { /* nothing */ }).sdk).build(B, { tz: HOME }), /the builder ended without a form/)
  await assert.rejects(setup(askSdk(async function* () { throw new Error('spawn failed') }).sdk).build(B, { tz: HOME }), (x: unknown) => refused(502, 'build_failed')(x) && /spawn failed/.test((x as Error).message))
})
