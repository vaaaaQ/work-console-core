// The ssh catalog pack: its server pinned to the version whose tools/list is recorded here, every tool of it named
// read or act, read exactly those the server marks read-only, and nothing secret in its config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pack = JSON.parse(readFileSync(new URL('../pack.json', import.meta.url), 'utf8'));
const listed = JSON.parse(readFileSync(new URL('./tools-list.json', import.meta.url), 'utf8'));

test('the server is pinned to the version whose tools/list is recorded', () => {
  assert.equal(pack.kind, 'mcp');
  assert.ok(pack.mcp.args.includes(listed.package), `${listed.package} in ${pack.mcp.args.join(' ')}`);
  assert.match(listed.package, /@\d+\.\d+\.\d+$/);
});

test('every tool the server lists is read or act, and the pack names no other', () => {
  const names = listed.tools.map((t) => t.name).sort();
  assert.deepEqual([...pack.tools.read, ...pack.tools.act].sort(), names);
  assert.deepEqual(pack.tools.read.filter((t) => pack.tools.act.includes(t)), []);
});

test('read is exactly what the server marks read-only; the rest change things', () => {
  assert.deepEqual([...pack.tools.read].sort(), listed.tools.filter((t) => t.readOnly).map((t) => t.name).sort());
  assert.equal(pack.tools.read.length, 6);
  assert.equal(pack.tools.act.length, 8);
});

test('its one setting is the path of the config file, put in as --config=; no host, user or secret lives in the pack', () => {
  assert.deepEqual(Object.keys(pack.config), ['file']);
  assert.ok(pack.mcp.args.includes('--config=${config.file}'));
  assert.equal(pack.mcp.env, undefined);
  assert.ok(readFileSync(new URL('../guide.md', import.meta.url), 'utf8').length <= 2000);
});
