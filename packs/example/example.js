// An example pack: one function the carrier evaluates in a signed-in tab as (script)(call).
// It serves the work concept from Jira with the tab's own session cookies and returns an
// envelope. Copy it per workplace and add a reader per concept the pack.json lists.
async function (call, env) {
  env = env || {
    fetch: (url, init) => fetch(url, init),
    location: window.location,
    document: window.document,
  };

  const HOSTS = {
    work: /\.atlassian\.net$/, 'work.comment': /\.atlassian\.net$/,
  };
  const KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
  const MAX_TEXT = 28000;
  const FIELDS = 'summary,status,issuetype,assignee,updated';

  // ---- envelope ----
  class Fail extends Error {
    constructor(code, message, retryAfter) { super(message); this.code = code; this.retryAfter = retryAfter; }
  }
  const fail = (code, message, retryAfter) => { throw new Fail(code, message, retryAfter); };
  // set once an action's write went out: from then on no failure is a sure one
  let wrote = false;
  const scrub = (s) => String(s).replace(/Bearer\s+[A-Za-z0-9._~+\/=-]+/g, 'Bearer [token]');

  const str = (v) => (v === null || v === undefined ? '' : String(v));
  const iso = (t) => {
    if (!t) return null;
    const d = new Date(String(t).replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
    return isNaN(d) ? null : d.toISOString();
  };
  const origin = () => 'https://' + str(env.location && env.location.hostname);

  // ---- http ----
  const http = async (method, path, { body, headers = {} } = {}) => {
    const init = { method, credentials: 'include', headers: { Accept: 'application/json', ...headers } };
    if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
    const where = method + ' ' + path.split('?')[0];
    const lost = call.verb === 'act' && method !== 'GET' ? 'unknown' : 'source_error';
    if (lost === 'unknown') wrote = true;
    let res;
    try { res = await env.fetch(origin() + path, init); }
    catch (e) { fail(lost, where + ': ' + (e && e.message ? e.message : 'network error')); }
    if (res.status === 401 || res.status === 403) fail('unauthorized', where + ' → ' + res.status);
    if (res.status === 429) {
      const after = Number(res.headers.get('Retry-After'));
      fail('rate_limited', where + ' → 429', Number.isFinite(after) && after > 0 ? after : 60);
    }
    if (res.status === 404) fail('not_found', where + ' → 404');
    if (!res.ok) fail(res.status >= 500 ? lost : 'source_error', where + ' → ' + res.status);
    if (res.status === 204) return null;
    let text;
    try { text = await res.text(); }
    catch (e) { fail(lost, where + ': the answer broke off'); }
    // a 200 with an HTML page is a sign-in redirect the fetch followed
    if (/^\s*</.test(text)) fail('unauthorized', where + ' answered with a page, not JSON');
    try { return text ? JSON.parse(text) : null; }
    catch { fail(lost, where + ': the answer is not JSON'); }
  };

  // ---- work: open issues assigned to me, plus the ones jobs watch ----
  const watched = (concept) => ((call.watch && call.watch[concept]) || []).filter((x) => typeof x === 'string' && KEY.test(x));
  const search = async (jql) => {
    const q = '?jql=' + encodeURIComponent(jql) + '&fields=' + FIELDS + '&maxResults=100';
    // Jira Cloud's search; Server and Data Center only have the older one
    try { return await http('GET', '/rest/api/3/search/jql' + q); }
    catch (e) { if (e instanceof Fail && e.code === 'not_found') return http('GET', '/rest/api/2/search' + q); throw e; }
  };
  const workRead = async () => {
    const extra = watched('work');
    const mine = 'assignee = currentUser() AND statusCategory != Done';
    const jql = (extra.length ? '(' + mine + ') OR key in (' + extra.join(', ') + ')' : mine) + ' ORDER BY updated DESC';
    const r = await search(jql);
    return (r.issues || []).map((i) => {
      const f = i.fields || {};
      return {
        id: str(i.key),
        type: str(f.issuetype && f.issuetype.name),
        title: str(f.summary),
        state: str(f.status && f.status.name),
        assignedTo: (f.assignee && f.assignee.displayName) || null,
        changedAt: iso(f.updated) || call.now,
        link: origin() + '/browse/' + i.key,
      };
    });
  };

  const argKey = (args) => { const k = str(args.id).trim(); if (!KEY.test(k)) fail('bad_args', 'id must be an issue key like ABC-123'); return k; };
  const argText = (args) => { const t = str(args.text); if (!t.trim() || t.length > MAX_TEXT) fail('bad_args', 'text must be 1 to ' + MAX_TEXT + ' characters'); return t; };

  const workGet = async (id) => {
    const key = argKey({ id });
    const r = await http('GET', '/rest/api/2/issue/' + key + '?fields=description,comment');
    const f = (r && r.fields) || {};
    return {
      description: str(f.description),
      comments: ((f.comment && f.comment.comments) || []).slice(-20).reverse().map((c) => ({
        id: str(c.id), author: str(c.author && c.author.displayName), at: iso(c.created) || call.now, text: str(c.body),
      })),
    };
  };

  // the v2 API takes plain text; the header passes Jira's XSRF check for a cookie session
  const workComment = async (args) => {
    const key = argKey(args), text = argText(args);
    const c = await http('POST', '/rest/api/2/issue/' + key + '/comment', { body: { body: text }, headers: { 'X-Atlassian-Token': 'no-check' } });
    return { id: key, commentId: c && c.id ? String(c.id) : null };
  };

  const READS = { work: workRead };
  const GETS = { work: workGet };
  const ACTS = { 'work.comment': workComment };

  try {
    const doc = env.document;
    if (!doc || doc.readyState === 'loading' || !doc.body || doc.body.childElementCount === 0) fail('blank', 'the tab has not rendered');
    const name = call.verb === 'act' ? call.action : call.concept;
    const host = HOSTS[name];
    if (host && !host.test(str(env.location && env.location.hostname))) fail('unauthorized', 'the tab is on ' + str(env.location && env.location.hostname) + ', likely a sign-in page');
    let data;
    if (call.verb === 'read' && READS[call.concept]) data = await READS[call.concept]();
    else if (call.verb === 'get' && GETS[call.concept]) data = await GETS[call.concept](str(call.id));
    else if (call.verb === 'act' && ACTS[call.action]) data = await ACTS[call.action](call.args || {});
    else fail('bad_args', 'unknown ' + call.verb + ' ' + name);
    return { ok: true, data };
  } catch (e) {
    if (e instanceof Fail) {
      const out = { ok: false, code: e.code, message: scrub(e.message) };
      if (e.retryAfter) out.retryAfter = e.retryAfter;
      return out;
    }
    return { ok: false, code: wrote ? 'unknown' : 'source_error', message: scrub((e && e.name ? e.name + ': ' : '') + (e && e.message ? e.message : String(e))) };
  }
}
