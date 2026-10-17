// The filesystem catalog pack: its server pinned to the version whose tools/list is recorded here, every tool of it named
// read or act, read exactly those the server marks read-only, and the folders it serves a setting.
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
  assert.deepEqual([...pack.tools.read, ...pack.tools.act].sort(), listed.tools.map((t) => t.name).sort());
});

test('read is exactly what the server marks read-only; the rest change things', () => {
  assert.deepEqual([...pack.tools.read].sort(), listed.tools.filter((t) => t.readOnly).map((t) => t.name).sort());
});

test('the folders it serves are a required list setting, each one an arg', () => {
  assert.deepEqual(pack.config.roots.list, true);
  assert.deepEqual(pack.config.roots.required, true);
  assert.equal(pack.mcp.args.at(-1), '${config.roots}');
  assert.ok(readFileSync(new URL('../guide.md', import.meta.url), 'utf8').length <= 2000);
});

test("the server never hears of a run's MCP roots: it would put them in place of the folders set here", () => {
  assert.equal(pack.mcp.roots, false);
});
