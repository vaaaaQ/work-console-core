import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, get, read, run, NOW } from './harness.mjs';
import { schema, validate } from './validate.mjs';

const issue = (key, o = {}) => ({
  key, fields: { summary: 'Rate limiting per token', status: { name: 'In Progress' }, issuetype: { name: 'Story' }, assignee: { displayName: 'Me' }, updated: '2026-09-30T10:05:00.000+0000', ...o },
});
const SEARCH = /\/rest\/api\/3\/search\/jql\?/;

test('work read: my open issues as work items that match the schema', async () => {
  const { result, requests, unmatched } = await run(read('work'), { routes: [['GET', SEARCH, { json: { issues: [issue('ACME-512'), issue('ACME-561', { assignee: null, updated: null })] } }]] });
  assert.deepEqual(unmatched, []);
  assert.equal(result.ok, true, result.message);
  const s = schema('work.item');
  for (const it of result.data) assert.deepEqual(validate(s, it), []);
  assert.deepEqual(result.data[0], {
    id: 'ACME-512', type: 'Story', title: 'Rate limiting per token', state: 'In Progress', assignedTo: 'Me',
    changedAt: '2026-09-30T10:05:00.000Z', link: 'https://acme.atlassian.net/browse/ACME-512',
  });
  assert.equal(result.data[1].assignedTo, null);
  assert.equal(result.data[1].changedAt, NOW);
  assert.equal(requests[0].credentials, 'include');
  assert.match(decodeURIComponent(requests[0].url), /assignee = currentUser\(\) AND statusCategory != Done/);
});

test('work read: watched keys join the query; anything that is not a key is dropped', async () => {
  const { result, requests } = await run(read('work', { watch: { work: ['ACME-480', 'x) OR 1=1', 7] } }), { routes: [['GET', SEARCH, { json: { issues: [] } }]] });
  assert.equal(result.ok, true);
  const jql = decodeURIComponent(requests[0].url);
  assert.match(jql, /OR key in \(ACME-480\)/);
  assert.doesNotMatch(jql, /1=1/);
});

test('work read: without the Cloud search the older one answers', async () => {
  const { result, requests } = await run(read('work'), { routes: [
    ['GET', SEARCH, { status: 404 }],
    ['GET', /\/rest\/api\/2\/search\?/, { json: { issues: [issue('ACME-1')] } }],
  ] });
  assert.equal(result.ok, true);
  assert.equal(result.data[0].id, 'ACME-1');
  assert.equal(requests.length, 2);
});

test('work get: description and the newest comments first, matching the schema', async () => {
  const comments = [{ id: '1', author: { displayName: 'Priya Shah' }, created: '2026-09-29T09:00:00.000+0000', body: 'first' }, { id: '2', author: { displayName: 'Me' }, created: '2026-09-30T09:00:00.000+0000', body: 'second' }];
  const { result } = await run(get('work', 'ACME-512'), { routes: [['GET', /\/rest\/api\/2\/issue\/ACME-512\?fields=description,comment$/, { json: { fields: { description: 'Limit per token.', comment: { comments } } } }]] });
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(validate(schema('work.get'), result.data), []);
  assert.deepEqual(result.data.comments.map((c) => c.text), ['second', 'first']);
  const bad = await run(get('work', '../admin'));
  assert.equal(bad.result.code, 'bad_args');
  assert.equal(bad.requests.length, 0);
});

test('work.comment: posts plain text with the XSRF header; a lost answer after the write is unknown', async () => {
  const ok = await run(act('work.comment', { id: 'ACME-512', text: 'Deployed to staging.' }), { routes: [['POST', /\/rest\/api\/2\/issue\/ACME-512\/comment$/, { status: 201, json: { id: '10001' } }]] });
  assert.deepEqual(ok.result, { ok: true, data: { id: 'ACME-512', commentId: '10001' } });
  assert.deepEqual(ok.requests[0].body, { body: 'Deployed to staging.' });
  assert.equal(ok.requests[0].headers['X-Atlassian-Token'], 'no-check');
  const lost = await run(act('work.comment', { id: 'ACME-512', text: 't' }), { routes: [['POST', /comment$/, { status: 502 }]] });
  assert.equal(lost.result.code, 'unknown');
  const empty = await run(act('work.comment', { id: 'ACME-512', text: '  ' }));
  assert.equal(empty.result.code, 'bad_args');
  assert.equal(empty.requests.length, 0);
});

test('envelope: blank tab, sign-in page, HTML answer, rate limit, unknown verb', async () => {
  assert.equal((await run(read('work'), { document: { readyState: 'loading' } })).result.code, 'blank');
  assert.equal((await run(read('work'), { host: 'id.atlassian.com' })).result.code, 'unauthorized');
  assert.equal((await run(read('work'), { routes: [['GET', SEARCH, { text: '<html>sign in</html>' }]] })).result.code, 'unauthorized');
  const rl = await run(read('work'), { routes: [['GET', SEARCH, { status: 429, headers: { 'Retry-After': '30' } }]] });
  assert.deepEqual([rl.result.code, rl.result.retryAfter], ['rate_limited', 30]);
  assert.equal((await run(read('chat'))).result.code, 'bad_args');
  const thrown = await run(read('work'), { fetchError: new TypeError('Bearer abc.def leaked') });
  assert.equal(thrown.result.code, 'source_error');
  assert.doesNotMatch(thrown.result.message, /abc\.def/);
});
