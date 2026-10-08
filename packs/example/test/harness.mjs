// Loads a pack script the way the carrier does and runs it against a fake tab: a routed fetch that
// records every request, a location, a document and, for packs that read MSAL tokens, a localStorage.
import { readFileSync } from 'node:fs';

export const load = (url) => (0, eval)('(' + readFileSync(url, 'utf8') + ')');
export const pack = load(new URL('../example.js', import.meta.url));

export const NOW = '2026-09-30T12:00:00.000Z';
export const ZONE = 'UTC';
export const HOST = 'acme.atlassian.net';
export const ME_OID = '00000000-0000-0000-0000-00000000a001';
export const TENANT = '00000000-0000-0000-0000-0000000000f1';

// An MSAL access-token entry as a signed-in tab keeps it; target is space-separated scopes.
export function msalToken(name, target, { now = NOW, expiresOn, oid = ME_OID, tenant = TENANT } = {}) {
  const exp = expiresOn ?? Math.floor(Date.parse(now) / 1000) + 3600;
  return [`${oid}.${tenant}-login.windows.net-accesstoken-client-${tenant}-${target.toLowerCase()}`,
    JSON.stringify({ secret: 'FAKE-SECRET-' + name, target, expiresOn: String(exp), homeAccountId: `${oid}.${tenant}`, credentialType: 'AccessToken' })];
}
export function msalAccount(username, { oid = ME_OID, tenant = TENANT } = {}) {
  return [`${oid}.${tenant}-login.windows.net-${tenant}`, JSON.stringify({ homeAccountId: `${oid}.${tenant}`, environment: 'login.windows.net', username })];
}
export const fakeStorage = (entries) => ({
  length: entries.length,
  key: (i) => (entries[i] ? entries[i][0] : null),
  getItem: (k) => { const e = entries.find(([x]) => x === k); return e ? e[1] : null; },
});

const parse = (body) => { if (body === undefined) return undefined; try { return JSON.parse(body); } catch { return body; } };

// routes: [method, RegExp over the full URL, answer | (req) => answer]; answer: {status, json, text, headers}.
export function fakeEnv({ routes = [], host = HOST, pathname = '/', document, fetchError, storage, extra } = {}) {
  const requests = [], unmatched = [];
  const fetch = async (url, init = {}) => {
    const req = { method: init.method || 'GET', url, headers: init.headers || {}, body: parse(init.body), credentials: init.credentials };
    requests.push(req);
    if (fetchError) throw fetchError;
    const hit = routes.find(([m, u]) => m === req.method && u.test(url));
    if (!hit) { unmatched.push(req.method + ' ' + url); return new Response('no route', { status: 500 }); }
    const a = await (typeof hit[2] === 'function' ? hit[2](req) : hit[2]);
    const status = a.status ?? 200;
    const body = status === 204 ? null : a.text !== undefined ? a.text : a.json !== undefined ? JSON.stringify(a.json) : '';
    return new Response(body, { status, headers: a.headers || {} });
  };
  const env = {
    fetch, location: { hostname: host, pathname, href: `https://${host}${pathname}` },
    document: document ?? { readyState: 'complete', body: { childElementCount: 3 } }, ...extra,
  };
  if (storage) env.localStorage = fakeStorage(storage);
  return { env, requests, unmatched };
}

export const read = (concept, extra = {}) => ({ verb: 'read', concept, watch: {}, zone: ZONE, now: NOW, ...extra });
export const get = (concept, id, extra = {}) => ({ verb: 'get', concept, id, watch: {}, zone: ZONE, now: NOW, ...extra });
export const act = (action, args, extra = {}) => ({ verb: 'act', action, args, zone: ZONE, now: NOW, ...extra });

export async function run(call, opts = {}) {
  const f = fakeEnv(opts);
  const result = await (opts.pack || pack)(call, f.env);
  return { result, ...f };
}
