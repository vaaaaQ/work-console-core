import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { act, get, load, read, run } from '../../example/test/harness.mjs';
import { contract, withDefaults } from '../../example/test/contract.mjs';
import { A, CONFIG, HOST, ME, P, T, ado, re, routes } from './fixtures.mjs';

const pack = load(new URL('../azure-devops.js', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('../pack.json', import.meta.url), 'utf8'));
const tab = { pack, host: HOST, pathname: '/acme/Road%20Map/' };
const cfg = CONFIG;
const ok = (r) => { assert.equal(r.result.ok, true, r.result.message); assert.deepEqual(r.unmatched, []); return r.result.data; };
const wiqls = (r) => r.requests.filter((q) => q.url.includes('/_apis/wit/wiql')).map((q) => q.body.query);
const refused = (r, code, pattern) => {
  assert.equal(r.result.code, code, r.result.message);
  if (pattern) assert.match(r.result.message, pattern);
};

test('contract', async (t) => {
  await contract(t, {
    dir: new URL('../', import.meta.url), config: cfg, host: HOST, pathname: tab.pathname,
    reads: { work: routes(), review: routes(), ci: routes(), board: routes() },
    gets: { work: { id: '95512', routes: routes() }, review: { id: '101', routes: routes() }, ci: { id: '500', routes: routes() } },
    acts: {
      'work.setState': { args: { id: '95512', state: 'Resolved' }, routes: routes() },
      'work.comment': { args: { id: '95512', text: 'Done.' }, routes: routes() },
      'review.vote': { args: { id: '101', vote: 10 }, routes: routes() },
      'review.comment': { args: { id: '101', text: 'Looks good.' }, routes: routes() },
    },
  });
});

test('work read: mine and the watched, newest first, each linked in its own project; a watched id that is no number is dropped', async () => {
  const r = await run(read('work', { config: cfg, watch: { work: ['95514', '1 OR 1=1', '95512'] } }), { ...tab, routes: routes() });
  const data = ok(r);
  assert.deepEqual(data.map((w) => [w.id, w.state, w.assignedTo]), [['95513', 'New', null], ['95512', 'Active', 'Robin Park']]);
  assert.equal(data[0].link, A + '/Side%20Quest/_workitems/edit/95513');
  assert.equal(data[1].changedAt, '2026-09-30T08:00:00.120Z');
  assert.deepEqual(r.requests.find((q) => q.url.includes('workitemsbatch')).body.ids, [95512, 95513, 95514]);
  assert.equal(wiqls(r)[0], "SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = @Me AND [System.State] NOT IN ('Closed', 'Done', 'Removed') ORDER BY [System.ChangedDate] DESC");
  assert.equal(r.requests[0].url, P + '/_apis/wit/wiql?$top=100&api-version=7.1');
  assert.equal(r.requests[0].credentials, 'include');
  assert.equal(r.requests[0].headers['X-TFS-FedAuthRedirect'], 'Suppress');
});

test('work read: finished states come from config, a quote in one doubled', async () => {
  const r = await run(read('work', { config: { ...cfg, doneStates: ['Shipped', "Won't fix"] } }), { ...tab, routes: routes() });
  ok(r);
  assert.match(wiqls(r)[0], /NOT IN \('Shipped', 'Won''t fix'\)/);
});

test('work get: the header, the text sections with pictures named, the chosen fields the item has, and its pull requests', async () => {
  const fields = ['Microsoft.VSTS.Common.Priority', 'System.Tags', 'System.CreatedBy', 'Custom.RiskNotes', 'Custom.ReleaseTrain',
    'Microsoft.VSTS.Scheduling.StoryPoints', 'Custom.Blocked', 'Custom.Matrix', 'System.CreatedDate'];
  const r = await run(get('work', '95512', { config: { ...cfg, fields } }), { ...tab, routes: routes() });
  const d = ok(r);
  assert.deepEqual([d.type, d.title, d.state, d.assignedTo, d.link, d.area, d.iteration, d.prs],
    ['Bug', 'Duplicate check on save', 'Active', 'Robin Park', P + '/_workitems/edit/95512', 'Road Map\\Apps', 'Road Map\\Sprint 7', ['101']]);
  assert.equal(d.description, 'Steps:\n1. open [image]');
  assert.equal(d.reproSteps, '- Add a name\n- Save');
  assert.equal(d.acceptanceCriteria, 'Save refuses a duplicate');
  assert.deepEqual(d.comments, [{ id: '7', author: 'Sam Diaz', at: '2026-09-30T09:00:00.000Z', text: 'seen [image]' }]);
  assert.deepEqual(d.fields, [
    { ref: 'Microsoft.VSTS.Common.Priority', name: 'Priority', value: 2 },
    { ref: 'System.Tags', name: 'Tags', value: 'ui; export' },
    { ref: 'System.CreatedBy', name: 'Created By', value: 'Sam Diaz' },
    { ref: 'Custom.RiskNotes', name: 'Risk Notes', value: 'Low risk, see [image]' },
    { ref: 'Custom.ReleaseTrain', name: 'Release Train', value: 'Autumn' },
    { ref: 'Custom.Blocked', name: 'Blocked', value: false },
    { ref: 'System.CreatedDate', name: 'Created Date', value: '2026-09-20T10:00:00.123Z' },
  ]);
  assert.equal(d.images, undefined);
  assert.equal(r.requests[0].url, A + '/_apis/wit/workitems/95512?api-version=7.1&$expand=relations');
});

test('work get: without fields in config the standard set, the same as pack.json gives', async () => {
  const bare = ok(await run(get('work', '95512', { config: { org: 'acme', project: 'Road Map' } }), { ...tab, routes: routes() }));
  assert.deepEqual(bare.fields.map((f) => f.name), ['Tags', 'Created By', 'Created Date', 'Priority']);
  const full = ok(await run(get('work', '95512', { config: withDefaults(manifest, { org: 'acme', project: 'Road Map' }) }), { ...tab, routes: routes() }));
  assert.deepEqual(full, bare);
});

test('review read: mine as reviewer and as author plus the watched, active threads counted', async () => {
  const r = await run(read('review', { config: cfg, watch: { review: ['90', '101', 'x;1', '404'] } }), { ...tab, routes: routes() });
  const d = ok(r);
  assert.deepEqual(d.map((p) => [p.id, p.myVote, p.activeThreads]), [['102', null, 1], ['101', 0, 1], ['90', null, 1]]);
  assert.deepEqual(d[1].votes, [{ reviewer: 'Robin Park', vote: 0 }, { reviewer: 'Lee Chan', vote: 10 }]);
  assert.equal(d[0].link, P + '/_git/web%20app/pullrequest/102');
  assert.equal(d[1].createdAt, '2026-09-29T10:00:00.123Z');
  assert.ok(!r.requests.some((q) => q.url.includes('x;1')));
});

test('review get: the header with its policies while active, threads without deleted or system comments', async () => {
  const r = await run(get('review', '101', { config: cfg }), { ...tab, routes: routes() });
  const d = ok(r);
  assert.deepEqual(d.pr, {
    title: 'Fix login', repo: 'web app', link: P + '/_git/web%20app/pullrequest/101', source: 'feature/export', target: 'main', status: 'active',
    draft: false, author: 'Sam Diaz', closedAt: null, votes: [{ reviewer: 'Robin Park', vote: 0 }], merge: 'succeeded',
    policies: [{ name: 'web app CI', status: 'approved', blocking: true }, { name: 'Two reviewers', status: 'queued', blocking: false }],
  });
  assert.deepEqual(d.threads.map((t) => [t.id, t.status, t.file, t.comments.map((c) => c.text)]), [['1', 'active', '/src/a.ts', ['please fix']], ['2', 'fixed', null, ['ok']]]);
  assert.match(r.requests.find((q) => q.url.includes('/policy/evaluations')).url, /artifactId=vstfs%3A%2F%2F%2FCodeReview%2FCodeReviewId%2Fproj-guid%2F101&/);
  const closed = await run(get('review', '90', { config: cfg }), { ...tab, routes: routes() });
  assert.equal(ok(closed).pr.policies, null);
  assert.equal(ok(closed).pr.closedAt, '2026-09-02T10:00:00.000Z');
  assert.ok(!closed.requests.some((q) => q.url.includes('/policy/')));
});

test('ci read: my builds and the watched ones, newest first', async () => {
  const r = await run(read('ci', { config: cfg, watch: { ci: ['501', 'x'] } }), { ...tab, routes: routes() });
  const d = ok(r);
  assert.deepEqual(d.map((b) => [b.id, b.status, b.result, b.branch]), [['501', 'inProgress', null, 'develop'], ['500', 'completed', 'failed', 'feature/x']]);
  assert.equal(d[1].startedAt, '2026-09-30T09:01:00.123Z');
  assert.equal(d[0].link, P + '/_build/results?buildId=501');
});

test('ci get: the tail of the failed step log', async () => {
  const r = await run(get('ci', '500', { config: cfg }), { ...tab, routes: routes() });
  assert.deepEqual(ok(r), { log: 'line 1\nerror TS2304: boom\n' });
  assert.ok(r.requests.some((q) => q.url === P + '/_apis/build/builds/500/logs/5?startLine=700&api-version=7.1'));
});

const AREA = "([System.AreaPath] UNDER 'Road Map\\Apps' OR [System.AreaPath] = 'Road Map\\Ops''Desk')";
const TYPES = "[System.WorkItemType] IN ('User Story', 'Bug')";
const ORDER = ' ORDER BY [System.ChangedDate] DESC';

test('board read: the team area and the board item types scope three lanes; an item in two lanes is mine first', async () => {
  const r = await run(read('board', { config: cfg }), { ...tab, routes: routes() });
  const d = ok(r);
  assert.deepEqual(d.map((b) => [b.id, b.lane, b.column, b.swimlane]), [
    ['96011', 'mine', 'Doing', 'Expedite'], ['96010', 'mine', 'Doing', null],
    ['96020', 'qa', 'Verify', null], ['96021', 'qa', null, null],
    ['96030', 'free', 'New', null],
  ]);
  const [mine, qa, free] = wiqls(r);
  const head = `SELECT [System.Id] FROM WorkItems WHERE ${AREA} AND ${TYPES} AND `;
  assert.equal(mine, head + "[System.AssignedTo] = @Me AND [System.State] NOT IN ('Closed', 'Done', 'Removed')" + ORDER);
  assert.equal(qa, head + "[System.AssignedTo] EVER @Me AND ([System.BoardColumn] EVER 'Verify') AND [System.ChangedDate] >= @Today - 90" + ORDER);
  assert.equal(free, head + "[System.BoardColumn] = 'New' AND [System.AssignedTo] = ''" + ORDER);
  const batch = r.requests.find((q) => q.url.includes('workitemsbatch'));
  assert.deepEqual(batch.body.ids, [96011, 96010, 96020, 96021, 96030]);
  assert.ok(batch.body.fields.includes('System.BoardLane'));
  assert.ok(r.requests.some((q) => q.url === T + '/_apis/work/boards/Stories?api-version=7.1'));
});

test('board read: ready and handoff columns from config with quotes doubled; no handoff means no qa lane', async () => {
  const r = await run(read('board', { config: { ...cfg, ready: 'Ready', handoff: ['Verify', "Won't do"] } }), { ...tab, routes: routes() });
  ok(r);
  const [, qa, free] = wiqls(r);
  assert.match(qa, /\(\[System\.BoardColumn\] EVER 'Verify' OR \[System\.BoardColumn\] EVER 'Won''t do'\)/);
  assert.match(free, /\[System\.BoardColumn\] = 'Ready' AND/);
  const none = await run(read('board', { config: { org: 'acme', project: 'Road Map', board: 'Stories' } }), { ...tab, routes: routes() });
  const d = ok(none);
  assert.equal(wiqls(none).length, 2);
  assert.deepEqual(d.map((b) => [b.id, b.lane]), [['96011', 'mine'], ['96010', 'mine'], ['96030', 'free']]);
});

test('board read: a team from config, and a team field that is not the area path', async () => {
  const team = P + '/Platform';
  const r = await run(read('board', { config: { ...cfg, team: 'Platform' } }), { ...tab, routes: [
    ['GET', re(team + '/_apis/work/boards/Stories?'), { json: ado.board }],
    ['GET', re(team + '/_apis/work/teamsettings/teamfieldvalues?'), { json: { field: { referenceName: 'Custom.Squad' }, values: [{ value: 'Blue', includeChildren: true }] } }],
    ...routes(),
  ] });
  ok(r);
  assert.match(wiqls(r)[0], /WHERE \(\[Custom\.Squad\] = 'Blue'\) AND/);
});

test('board read: a column the board lacks, a team with no area, an unknown board, or no board set', async () => {
  refused(await run(read('board', { config: { ...cfg, ready: 'Backlog' } }), { ...tab, routes: routes() }), 'bad_args', /config\.ready/);
  refused(await run(read('board', { config: { ...cfg, handoff: ['QA'] } }), { ...tab, routes: routes() }), 'bad_args', /config\.handoff/);
  const noArea = await run(read('board', { config: cfg }), { ...tab, routes: [
    ['GET', re(T + '/_apis/work/teamsettings/teamfieldvalues?'), { json: { field: { referenceName: 'System.AreaPath' }, values: [] } }], ...routes()] });
  refused(noArea, 'source_error', /no area/);
  assert.deepEqual(wiqls(noArea), []);
  const badField = await run(read('board', { config: cfg }), { ...tab, routes: [
    ['GET', re(T + '/_apis/work/teamsettings/teamfieldvalues?'), { json: { field: { referenceName: "x] = 1 OR [y" }, values: [{ value: 'a' }] } }], ...routes()] });
  refused(badField, 'source_error');
  assert.deepEqual(wiqls(badField), []);
  refused(await run(read('board', { config: cfg }), { ...tab, routes: [['GET', re(T + '/_apis/work/boards/Stories?'), { status: 404, text: '{}' }], ...routes()] }), 'not_found');
  const noBoard = await run(read('board', { config: { org: 'acme', project: 'Road Map' } }), { ...tab, routes: routes() });
  refused(noBoard, 'bad_args', /config\.board/);
  assert.equal(noBoard.requests.length, 0);
});

test('work.setState: a JSON patch of the state', async () => {
  const r = await run(act('work.setState', { id: '95512', state: 'Resolved' }, { config: cfg }), { ...tab, routes: routes() });
  assert.deepEqual(ok(r), { id: '95512', state: 'Resolved' });
  const [patch] = r.requests;
  assert.equal(patch.method, 'PATCH');
  assert.equal(patch.url, A + '/_apis/wit/workitems/95512?api-version=7.1');
  assert.equal(patch.headers['Content-Type'], 'application/json-patch+json');
  assert.deepEqual(patch.body, [{ op: 'add', path: '/fields/System.State', value: 'Resolved' }]);
  const bad = await run(act('work.setState', { id: '95512; x', state: 'Done' }, { config: cfg }), { ...tab, routes: routes() });
  refused(bad, 'bad_args');
  assert.equal(bad.requests.length, 0);
});

test('work.comment: on the project the item lives in', async () => {
  const r = await run(act('work.comment', { id: '95512', text: 'Done.' }, { config: cfg }), { ...tab, routes: routes() });
  assert.deepEqual(ok(r), { id: '95512', commentId: 8 });
  const post = r.requests.find((q) => q.method === 'POST');
  assert.equal(post.url, A + '/Side%20Quest/_apis/wit/workItems/95512/comments?api-version=7.1-preview.4');
  assert.deepEqual(post.body, { text: 'Done.' });
});

test('review.vote: a PUT on my reviewer entry; a vote outside the scale is refused', async () => {
  const r = await run(act('review.vote', { id: '101', vote: -5 }, { config: cfg }), { ...tab, routes: routes() });
  assert.deepEqual(ok(r), { id: '101', vote: -5 });
  const put = r.requests.find((q) => q.method === 'PUT');
  assert.equal(put.url, P + '/_apis/git/repositories/repo-guid/pullRequests/101/reviewers/' + ME + '?api-version=7.1');
  assert.deepEqual(put.body, { vote: -5 });
  const bad = await run(act('review.vote', { id: '101', vote: 7 }, { config: cfg }), { ...tab, routes: routes() });
  refused(bad, 'bad_args', /vote/);
  assert.equal(bad.requests.length, 0);
});

test('review.comment: a new thread, or a reply in one', async () => {
  const r = await run(act('review.comment', { id: '101', text: 'Looks good.' }, { config: cfg }), { ...tab, routes: routes() });
  assert.deepEqual(ok(r), { id: '101', threadId: '44' });
  assert.deepEqual(r.requests.find((q) => q.method === 'POST').body, { comments: [{ parentCommentId: 0, content: 'Looks good.', commentType: 1 }], status: 1 });
  const reply = await run(act('review.comment', { id: '101', text: 'Fixed.', threadId: '1' }, { config: cfg }), { ...tab, routes: routes() });
  assert.deepEqual(ok(reply), { id: '101', threadId: '1', commentId: 2 });
  const post = reply.requests.find((q) => q.method === 'POST');
  assert.equal(post.url, P + '/_apis/git/repositories/repo-guid/pullRequests/101/threads/1/comments?api-version=7.1');
  assert.deepEqual(post.body, { content: 'Fixed.', parentCommentId: 1, commentType: 1 });
});

test('errors: a lost answer after a write is unknown; before it, a source error', async () => {
  const lost = await run(act('work.setState', { id: '95512', state: 'Resolved' }, { config: cfg }), { ...tab, routes: [['PATCH', re(A + '/_apis/wit/workitems/'), { status: 502 }], ...routes()] });
  refused(lost, 'unknown');
  const net = await run(act('review.comment', { id: '101', text: 'x' }, { config: cfg }), { ...tab, routes: [['POST', re(P + '/_apis/git/'), () => { throw new TypeError('reset'); }], ...routes()] });
  refused(net, 'unknown');
  refused(await run(read('ci', { config: cfg }), { ...tab, routes: [['GET', re(P + '/_apis/build/builds?'), { status: 500 }], ...routes()] }), 'source_error');
});

test('errors: a lost session, a sign-in page served as 200, ADO knowing no user, and a rate limit', async () => {
  refused(await run(read('work', { config: cfg }), { ...tab, routes: [['POST', re(P + '/_apis/wit/wiql?'), { status: 401 }]] }), 'unauthorized');
  refused(await run(read('work', { config: cfg }), { ...tab, routes: [['POST', re(P + '/_apis/wit/wiql?'), { status: 203, text: '{}' }]] }), 'unauthorized');
  refused(await run(read('work', { config: cfg }), { ...tab, routes: [['POST', re(P + '/_apis/wit/wiql?'), { text: '<!DOCTYPE html><html>sign in</html>' }]] }), 'unauthorized');
  refused(await run(read('ci', { config: cfg }), { ...tab, routes: [['GET', re(A + '/_apis/connectionData'), { json: { authenticatedUser: { id: '00000000-0000-0000-0000-000000000000' } } }]] }), 'unauthorized');
  const limited = await run(read('work', { config: cfg }), { ...tab, routes: [['POST', re(P + '/_apis/wit/wiql?'), { status: 429, headers: { 'Retry-After': '30' } }]] });
  refused(limited, 'rate_limited');
  assert.equal(limited.result.retryAfter, 30);
});

test('config: values are checked before any request; a project name is encoded; another host is a sign-in page', async () => {
  for (const [config, key] of [[{ ...cfg, project: 'a/b' }, 'project'], [{ ...cfg, org: 'acme.example' }, 'org'], [{ ...cfg, fields: ['x y'] }, 'fields'],
    [{ ...cfg, team: "x'y" }, 'team'], [{ ...cfg, handoff: 'Verify' }, 'handoff'], [{ ...cfg, doneStates: [] }, 'doneStates']]) {
    const r = await run(read('work', { config }), { ...tab, routes: routes() });
    refused(r, 'bad_args', new RegExp('config\\.' + key + '\\b'));
    assert.equal(r.requests.length, 0, key);
  }
  const rd = await run(read('ci', { config: { org: 'acme', project: 'R&D (Ops)' } }), { ...tab, routes: [['GET', re(A + '/R%26D%20(Ops)/_apis/build/builds?'), { json: { value: [] } }], ...routes()] });
  assert.deepEqual(ok(rd), []);
  const elsewhere = await run(read('work', { config: cfg }), { ...tab, host: 'acme.visualstudio.com', routes: routes() });
  refused(elsewhere, 'unauthorized');
  assert.equal(elsewhere.requests.length, 0);
});
