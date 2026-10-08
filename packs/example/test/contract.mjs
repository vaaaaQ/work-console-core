// The contract every pack keeps, run over its pack.json on synthetic fixtures: reads and gets match
// the schemas, acts check args first, a blank or foreign tab is refused, and no secret leaves the tab.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { act, fakeEnv, get, load, read } from './harness.mjs';
import { schema, validate } from './validate.mjs';

const TEMPLATE = /\{([a-zA-Z][a-zA-Z0-9]*)\}/g;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const SIGN_IN = 'login.microsoftonline.com';

// The workspace's settings with the pack's defaults, as the console sends them in call.config.
export function withDefaults(manifest, config = {}) {
  const out = {};
  for (const [k, c] of Object.entries(manifest.config || {})) { const v = config[k] ?? c.default; if (v !== undefined) out[k] = v; }
  return out;
}

// The same rendering as console/server/bridge/packs.ts renderPack.
export function render(manifest, config) {
  const fill = (s, put) => s.replace(TEMPLATE, (_, k) => { assert.equal(typeof config[k], 'string', `config.${k} has no value`); return put(config[k]); });
  const tabs = {};
  for (const [n, tab] of Object.entries(manifest.tabs)) tabs[n] = { match: new RegExp(fill(tab.match, escapeRe)), open: fill(tab.open, encodeURIComponent) };
  return { tabs, hosts: (manifest.hosts || []).map((h) => fill(h, (v) => v)) };
}

// spec: {dir, config, host, pathname, storage, reads: {concept: routes}, gets: {concept: {id, routes}}, acts: {action: {args, routes}}}
export async function contract(t, { dir, config = {}, host, pathname = '/', storage, reads = {}, gets = {}, acts = {} }) {
  const base = dir instanceof URL ? dir : pathToFileURL(String(dir).replace(/[\\/]?$/, '/'));
  const manifest = JSON.parse(readFileSync(new URL('pack.json', base), 'utf8'));
  const script = load(new URL(manifest.script, base));
  const cfg = withDefaults(manifest, config);
  const secrets = (storage || []).map(([, v]) => { try { return JSON.parse(v).secret; } catch { return undefined; } }).filter(Boolean);
  const hosts = render(manifest, cfg).hosts;
  const results = [];
  const go = async (call, routes = [], opts = {}) => {
    const f = fakeEnv({ routes, host, pathname, storage, ...opts });
    const result = await script({ config: cfg, ...call }, f.env);
    results.push(result);
    for (const r of f.requests) {
      const h = new URL(r.url).hostname;
      if (hosts.length) assert.ok(hosts.includes(h), `${r.method} ${r.url}: ${h} is not one of the pack's hosts`);
    }
    return { result, ...f };
  };
  const [c0] = Object.keys(reads), [a0] = Object.keys(acts);
  const first = c0 ? read(c0) : act(a0, acts[a0].args);
  const firstRoutes = c0 ? reads[c0] : acts[a0].routes;

  await t.test('pack.json', () => {
    const decl = manifest.config || {};
    const templates = [...(manifest.hosts || []), ...Object.values(manifest.tabs).flatMap((x) => [x.match, x.open])];
    for (const s of templates) for (const [, k] of s.matchAll(TEMPLATE)) {
      assert.ok(k in decl, `{${k}} is not a config key`);
      assert.ok(!decl[k].list, `{${k}} is a list`);
    }
    for (const [c, x] of Object.entries(manifest.concepts)) {
      assert.ok(x.tab in manifest.tabs, `concept ${c}: no tab ${x.tab}`);
      assert.ok(x.interval > 0 && Number.isInteger(x.cap) && x.cap > 0, `concept ${c}: interval and cap`);
      schema(`${c}.item`);
    }
    for (const [a, x] of Object.entries(manifest.actions || {}))
      assert.ok(x.tab in manifest.tabs && x.concept in manifest.concepts, `action ${a}: tab and concept`);
    for (const h of hosts) assert.match(h, /^[a-z0-9-]+(\.[a-z0-9-]+)+$/, `host ${h}`);
    const tabs = render(manifest, cfg).tabs;
    const used = [...Object.keys(reads), ...Object.keys(gets)].map((c) => manifest.concepts[c] && manifest.concepts[c].tab)
      .concat(Object.keys(acts).map((a) => manifest.actions && manifest.actions[a] && manifest.actions[a].tab));
    for (const tab of used) {
      assert.ok(tab, 'every concept and action under test is in pack.json');
      assert.match(`https://${host}${pathname}`, tabs[tab].match, `tab ${tab}`);
    }
  });

  for (const [c, routes] of Object.entries(reads)) await t.test(`read ${c}`, async () => {
    const { result, unmatched } = await go(read(c), routes);
    assert.equal(result.ok, true, result.message);
    assert.deepEqual(unmatched, []);
    assert.ok(Array.isArray(result.data) && result.data.length > 0, 'a read returns items');
    assert.ok(result.data.length <= manifest.concepts[c].cap, 'within the cap');
    const s = schema(`${c}.item`);
    result.data.forEach((it, i) => assert.deepEqual(validate(s, it, `$[${i}]`), []));
  });

  for (const [c, { id, routes }] of Object.entries(gets)) await t.test(`get ${c}`, async () => {
    const { result, unmatched } = await go(get(c, id), routes);
    assert.equal(result.ok, true, result.message);
    assert.deepEqual(unmatched, []);
    assert.deepEqual(validate(schema(`${c}.get`), result.data), []);
  });

  for (const [a, { args, routes }] of Object.entries(acts)) {
    await t.test(`act ${a}`, async () => {
      const { result, unmatched } = await go(act(a, args), routes);
      assert.equal(result.ok, true, result.message);
      assert.deepEqual(unmatched, []);
    });
    await t.test(`act ${a} without args`, async () => {
      const { result, requests } = await go(act(a, {}), routes);
      assert.equal(result.code, 'bad_args');
      assert.equal(requests.length, 0);
    });
  }

  const calls = [...Object.keys(reads).map((c) => read(c)), ...Object.entries(acts).map(([a, x]) => act(a, x.args))];
  await t.test('a blank tab', async () => {
    for (const call of calls) {
      const { result, requests } = await go(call, [], { document: { readyState: 'loading' } });
      assert.equal(result.code, 'blank', call.concept || call.action);
      assert.equal(requests.length, 0);
    }
  });
  await t.test('a tab on a sign-in page', async () => {
    for (const call of calls) {
      const { result, requests } = await go(call, [], { host: SIGN_IN, pathname: '/' });
      assert.equal(result.code, 'unauthorized', call.concept || call.action);
      assert.equal(requests.length, 0);
    }
  });
  await t.test('an unknown concept', async () => {
    assert.equal((await go(read('nope'))).result.code, 'bad_args');
  });
  await t.test('a missing required setting', async () => {
    for (const [k, c] of Object.entries(manifest.config || {})) {
      if (!c.required) continue;
      const rest = { ...cfg };
      delete rest[k];
      const { result, requests } = await go({ ...first, config: rest }, firstRoutes);
      assert.equal(result.code, 'bad_args', k);
      assert.match(result.message, new RegExp(`config\\.${k}\\b`));
      assert.equal(requests.length, 0);
    }
  });
  if (secrets.length) await t.test('a network error with a token in it', async () => {
    const { result } = await go(first, firstRoutes, { fetchError: new TypeError('failed with ' + secrets.join(' ') + ' Bearer ' + secrets[0]) });
    assert.equal(result.ok, false);
    for (const s of secrets) assert.ok(!result.message.includes(s), 'the message holds a token');
  });
  await t.test('no secret in any result', () => {
    const all = JSON.stringify(results);
    for (const s of secrets) assert.ok(!all.includes(s), 'a result holds a token');
  });
}
