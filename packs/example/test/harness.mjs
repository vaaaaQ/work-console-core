// Loads example.js the way the carrier does and runs it against a fake tab: a routed fetch that
// records every request, a location and a document.
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../example.js', import.meta.url), 'utf8');
export const pack = (0, eval)('(' + src + ')');

export const NOW = '2026-09-30T12:00:00.000Z';
export const ZONE = 'UTC';
export const HOST = 'acme.atlassian.net';

// routes: [method, RegExp over the full URL, answer | (req) => answer]; answer: {status, json, text, headers}.
export function fakeEnv({ routes = [], host = HOST, document, fetchError } = {}) {
  const requests = [], unmatched = [];
  const fetch = async (url, init = {}) => {
    const req = { method: init.method || 'GET', url, headers: init.headers || {}, body: init.body === undefined ? undefined : JSON.parse(init.body), credentials: init.credentials };
    requests.push(req);
    if (fetchError) throw fetchError;
    const hit = routes.find(([m, u]) => m === req.method && u.test(url));
    if (!hit) { unmatched.push(req.method + ' ' + url); return new Response('no route', { status: 500 }); }
    const a = await (typeof hit[2] === 'function' ? hit[2](req) : hit[2]);
    const status = a.status ?? 200;
    const body = status === 204 ? null : a.text !== undefined ? a.text : a.json !== undefined ? JSON.stringify(a.json) : '';
    return new Response(body, { status, headers: a.headers || {} });
  };
  return {
    env: { fetch, location: { hostname: host }, document: document ?? { readyState: 'complete', body: { childElementCount: 3 } } },
    requests, unmatched,
  };
}

export const read = (concept, extra = {}) => ({ verb: 'read', concept, watch: {}, zone: ZONE, now: NOW, ...extra });
export const get = (concept, id, extra = {}) => ({ verb: 'get', concept, id, watch: {}, zone: ZONE, now: NOW, ...extra });
export const act = (action, args, extra = {}) => ({ verb: 'act', action, args, zone: ZONE, now: NOW, ...extra });

export async function run(call, opts = {}) {
  const f = fakeEnv(opts);
  const result = await pack(call, f.env);
  return { result, ...f };
}
