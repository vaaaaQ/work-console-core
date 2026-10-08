// The contract run over the example pack, and proof that it catches a pack that breaks a schema.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { contract } from './contract.mjs';
import { HOST } from './harness.mjs';

const issue = { key: 'ACME-512', fields: { summary: 'Rate limiting', status: { name: 'Open' }, issuetype: { name: 'Story' }, assignee: null, updated: '2026-09-30T10:05:00.000+0000' } };
const spec = (search) => ({
  dir: new URL('../', import.meta.url),
  host: HOST,
  reads: { work: [['GET', /\/rest\/api\/3\/search\/jql\?/, search]] },
  gets: { work: { id: 'ACME-512', routes: [['GET', /\/rest\/api\/2\/issue\/ACME-512\?/, { json: { fields: { description: 'd', comment: { comments: [] } } } }]] } },
  acts: { 'work.comment': { args: { id: 'ACME-512', text: 'Done.' }, routes: [['POST', /\/comment$/, { status: 201, json: { id: '1' } }]] } },
});

test('the example pack keeps the contract', async (t) => {
  await contract(t, spec({ json: { issues: [issue] } }));
});

test('the contract fails a pack whose read item breaks the schema', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wc-contract-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  copyFileSync(new URL('../pack.json', import.meta.url), join(dir, 'pack.json'));
  const src = readFileSync(new URL('../example.js', import.meta.url), 'utf8');
  writeFileSync(join(dir, 'example.js'), src.replace("link: origin() + '/browse/' + i.key,", ''));
  const runs = [];
  const stub = { test: async (name, fn) => { try { await fn(stub); runs.push([name, 'pass']); } catch (e) { runs.push([name, 'fail: ' + e.message]); } } };
  await contract(stub, { ...spec({ json: { issues: [issue] } }), dir: pathToFileURL(dir + '/') });
  const read = runs.find(([n]) => n === 'read work');
  assert.ok(read, runs.map(([n]) => n).join(', '));
  assert.match(read[1], /^fail: .*link: missing/s);
  assert.deepEqual(runs.filter(([n, r]) => n !== 'read work' && r !== 'pass'), []);
});
