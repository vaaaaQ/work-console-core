// A Microsoft 365 mail pack: one function the carrier evaluates in a signed-in Outlook on the web tab as
// (script)(call). It reads with the tab's own MSAL token, Graph first and Outlook REST when the tab
// holds only an Outlook token, and never returns a token, not even inside an error message.
async function (call, env) {
  env = env || {
    fetch: (url, init) => fetch(url, init),
    localStorage: window.localStorage,
    location: window.location,
    document: window.document,
  };

  const GRAPH = 'https://graph.microsoft.com/v1.0';
  const OUTLOOK = 'https://outlook.office.com/api/v2.0';
  const SITES = ['outlook.office.com', 'outlook.office365.com', 'outlook.cloud.microsoft'];
  const RESOURCE = { graph: /^(https:\/\/)?graph\.microsoft\.com\//, outlook: /^(https:\/\/)?outlook\.office\.com\// };
  const SCOPES = { mail: ['Mail.Read', 'Mail.ReadWrite'], cal: ['Calendars.Read', 'Calendars.ReadWrite'], send: ['Mail.Send'] };
  const MSG_ID = /^[A-Za-z0-9+/=_-]{1,512}$/;
  const ADDRESS = /^[^@\s<>,;"]+@[^@\s<>,;"]+\.[^@\s<>,;".]+$/;
  const AUTO_SENDERS = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?)@|@(noreply|no-reply)\./i;
  const MAX_TEXT = 28000;

  // ---- envelope ----
  class Fail extends Error {
    constructor(code, message, retryAfter) { super(message); this.code = code; this.retryAfter = retryAfter; }
  }
  const fail = (code, message, retryAfter) => { throw new Fail(code, message, retryAfter); };
  let tokenExpiresAt;
  // set once an action's write went out: from then on no failure is a sure one
  let wrote = false;
  const secrets = new Set();
  const scrub = (s) => {
    let out = String(s).replace(/Bearer\s+[A-Za-z0-9._~+\/=-]+/g, 'Bearer [token]');
    for (const x of secrets) out = out.split(x).join('[token]');
    return out;
  };

  // ---- text ----
  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
  const toText = (html) => String(html || '')
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e) => e[0] === '#'
      ? (ENTITIES[e] ?? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)))
      : (ENTITIES[e.toLowerCase()] ?? m))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const str = (v) => (v === null || v === undefined ? '' : String(v));
  // ISO-8601 UTC with milliseconds; takes 7-digit fractions and zone-less UTC times
  const iso = (t) => {
    if (t === null || t === undefined || t === '') return null;
    let s = String(t).trim().replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1');
    if (!/(Z|[+-]\d\d:?\d\d)$/.test(s)) s += 'Z';
    const d = new Date(s);
    return isNaN(d) ? null : d.toISOString();
  };
  const isoOr = (t, fallback) => iso(t) ?? fallback;
  const https = (u, fallback) => (/^https:\/\//.test(str(u)) ? u : fallback);

  // ---- time zone ----
  const partsIn = (ms, zone) => {
    const p = {};
    for (const x of new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms)))
      p[x.type] = x.value;
    return p;
  };
  const offsetAt = (ms, zone) => {
    const p = partsIn(ms, zone);
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
  };
  // the UTC instant of local midnight of a calendar day in zone
  const midnight = (y, m, d, zone) => {
    const guess = Date.UTC(y, m - 1, d);
    return guess - offsetAt(guess - offsetAt(guess, zone), zone);
  };
  const localDay = (ms, zone) => { const p = partsIn(ms, zone); return [+p.year, +p.month, +p.day]; };
  const addDays = ([y, m, d], n) => { const t = new Date(Date.UTC(y, m - 1, d + n)); return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()]; };
  const mondayOf = (day) => addDays(day, -((new Date(Date.UTC(day[0], day[1] - 1, day[2])).getUTCDay() + 6) % 7));

  // ---- http: a bearer token, never the cookies ----
  const http = async (method, url, { headers = {}, body, as = 'json' } = {}) => {
    const init = { method, headers: { Accept: 'application/json', ...headers } };
    if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
    const where = method + ' ' + url.split('?')[0].replace(/^https:\/\//, '');
    const lost = call.verb === 'act' && method !== 'GET' ? 'unknown' : 'source_error';
    if (lost === 'unknown') wrote = true;
    let res;
    try { res = await env.fetch(url, init); }
    catch (e) { fail(lost, where + ': ' + (e && e.message ? e.message : 'network error')); }
    if (res.status === 401 || res.status === 403) fail('unauthorized', where + ' → ' + res.status);
    if (res.status === 429) {
      const after = Number(res.headers.get('Retry-After'));
      fail('rate_limited', where + ' → 429', Number.isFinite(after) && after > 0 ? after : 60);
    }
    if (res.status === 404) fail('not_found', where + ' → 404');
    if (!res.ok) fail(res.status >= 500 ? lost : 'source_error', where + ' → ' + res.status);
    if (as === 'none' || res.status === 202 || res.status === 204) return null;
    let text;
    try { text = await res.text(); }
    catch (e) { fail(lost, where + ': the answer broke off'); }
    // a 200 with an HTML page is a sign-in redirect the fetch followed
    if (/^\s*</.test(text)) fail('unauthorized', where + ' answered with a page, not JSON');
    try { return text ? JSON.parse(text) : null; }
    catch { fail(lost, where + ': the answer is not JSON'); }
  };

  // ---- MSAL tokens in this tab ----
  const entries = () => {
    const ls = env.localStorage, out = [];
    if (!ls) return out;
    for (let i = 0; i < ls.length; i++) {
      const key = ls.key(i);
      try { out.push([key, JSON.parse(ls.getItem(key))]); } catch { /* not JSON */ }
    }
    return out;
  };
  const tokens = () => entries().filter(([k, v]) => /accesstoken/i.test(k) && v && typeof v.secret === 'string' && typeof v.target === 'string').map(([, v]) => {
    secrets.add(v.secret);
    return { secret: v.secret, targets: v.target.toLowerCase().split(/\s+/), exp: Number(v.expiresOn) * 1000 };
  });
  const find = (resource, scopes) => {
    const now = Date.parse(call.now) || Date.now(), want = scopes.map((s) => '/' + s.toLowerCase());
    let best = null;
    for (const t of tokens()) {
      if (!(t.exp > now)) continue;
      if (t.targets.some((s) => RESOURCE[resource].test(s) && want.some((w) => s.endsWith(w))) && (!best || t.exp > best.exp)) best = t;
    }
    return best;
  };
  // Graph when the tab holds a live Graph token for one of the scopes, else Outlook REST
  const backend = (scopes) => {
    const g = find('graph', scopes), t = g || find('outlook', scopes);
    if (!t) fail('unauthorized', 'no live Graph or Outlook token in this tab for ' + scopes.join(' or '));
    const at = new Date(t.exp).toISOString();
    if (!tokenExpiresAt || at < tokenExpiresAt) tokenExpiresAt = at;
    return { graph: !!g, base: g ? GRAPH : OUTLOOK, t };
  };
  const me = () => {
    const out = new Set();
    for (const [, v] of entries()) if (v && typeof v.username === 'string' && v.homeAccountId) out.add(v.username.toLowerCase());
    return out;
  };

  // Outlook REST names everything in PascalCase; Graph in camelCase
  const upper = (s) => s.split('/').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('/');
  const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);
  const recase = (v, f) => (Array.isArray(v) ? v.map((x) => recase(x, f))
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k.startsWith('@') ? k : f(k), recase(x, f)])) : v);
  const names = (b, list) => (b.graph ? list : list.split(',').map(upper).join(','));
  const api = async (b, method, path, { body, headers = {}, as } = {}) => {
    const res = await http(method, b.base + path, { headers: { ...headers, Authorization: 'Bearer ' + b.t.secret }, body: body === undefined || b.graph ? body : recase(body, upper), as });
    return b.graph ? res : recase(res, lower);
  };

  // ---- args ----
  const argStr = (args, name, { optional = false, max = 400 } = {}) => {
    const v = args ? args[name] : undefined;
    if (v === undefined || v === null) { if (optional) return undefined; fail('bad_args', name + ' is required'); }
    if (typeof v !== 'string' || !v.trim()) fail('bad_args', name + ' must be a non-empty string');
    if (v.length > max) fail('bad_args', name + ' is longer than ' + max);
    return v;
  };
  const addresses = (args, name, optional) => {
    const v = args[name];
    if (v === undefined && optional) return [];
    if (!Array.isArray(v) || !v.length || v.length > 100 || v.some((x) => typeof x !== 'string' || !ADDRESS.test(x))) fail('bad_args', name + ' must be a list of mail addresses');
    return v.map((address) => ({ emailAddress: { address } }));
  };

  let site;

  // ---- mail ----
  const MAIL_SELECT = 'id,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,bodyPreview,conversationId,webLink';
  const addr = (r) => str(r && r.emailAddress && r.emailAddress.address).toLowerCase();
  const who = (r) => (r && r.emailAddress ? r.emailAddress.name || r.emailAddress.address || '' : '');

  const mailRead = async () => {
    const b = backend(SCOPES.mail);
    // only Graph has the headers that mark a list or an automatic mail
    const select = names(b, MAIL_SELECT + (b.graph ? ',internetMessageHeaders' : ''));
    const list = (folder, order) => api(b, 'GET', '/me/mailFolders/' + folder + '/messages?$top=50&$orderby=' + names(b, order) + '%20desc&$select=' + select);
    const [inbox, sent] = await Promise.all([list('Inbox', 'receivedDateTime'), list('SentItems', 'sentDateTime')]);
    const mine = me();
    for (const m of (sent && sent.value) || []) if (addr(m.from)) mine.add(addr(m.from));
    const rows = [
      ...((inbox && inbox.value) || []).map((m) => ({ m, folder: 'Inbox', at: isoOr(m.receivedDateTime, isoOr(m.sentDateTime, call.now)) })),
      ...((sent && sent.value) || []).map((m) => ({ m, folder: 'Sent', at: isoOr(m.sentDateTime, call.now) })),
    ];
    const lastByThread = new Map(), lastSentByThread = new Map();
    for (const r of rows) {
      const c = str(r.m.conversationId);
      if (!lastByThread.has(c) || r.at > lastByThread.get(c).at) lastByThread.set(c, r);
      if (r.folder === 'Sent' && (!lastSentByThread.has(c) || r.at > lastSentByThread.get(c))) lastSentByThread.set(c, r.at);
    }
    const header = (m, name) => (m.internetMessageHeaders || []).find((h) => str(h.name).toLowerCase() === name);
    const category = (r) => {
      const m = r.m, auto = header(m, 'auto-submitted');
      if ((auto && str(auto.value).toLowerCase() !== 'no') || header(m, 'list-unsubscribe') || AUTO_SENDERS.test(addr(m.from))) return 'auto';
      if (lastByThread.get(str(m.conversationId)).folder === 'Sent') return 'wait';
      const inTo = (m.toRecipients || []).some((x) => mine.has(addr(x))), inCc = (m.ccRecipients || []).some((x) => mine.has(addr(x)));
      return !inTo && inCc ? 'fyi' : 'reply';
    };
    return rows.map((r) => {
      const m = r.m, lastSent = lastSentByThread.get(str(m.conversationId));
      return {
        id: str(m.id),
        folder: r.folder,
        from: who(m.from),
        to: (m.toRecipients || []).map(who),
        cc: (m.ccRecipients || []).map(who),
        subject: str(m.subject) || '(no subject)',
        at: r.at,
        unread: r.folder === 'Inbox' ? !m.isRead : false,
        preview: clip(str(m.bodyPreview), 300),
        category: category(r),
        myReply: !!lastSent && lastSent > r.at,
        conversationId: str(m.conversationId),
        link: https(m.webLink, 'https://' + site + '/mail/'),
      };
    }).slice(0, 100);
  };

  const mailGet = async (id) => {
    if (!MSG_ID.test(id)) fail('bad_args', 'id is not a message id');
    const b = backend(SCOPES.mail);
    const path = '/me/messages/' + encodeURIComponent(id);
    const m = await api(b, 'GET', path + '?$select=' + names(b, 'body,hasAttachments'), { headers: { Prefer: 'outlook.body-content-type="text"' } });
    const files = m && m.hasAttachments ? await api(b, 'GET', path + '/attachments?$select=' + names(b, 'name')) : { value: [] };
    const body = (m && m.body) || {};
    return {
      body: str(body.contentType).toLowerCase() === 'html' ? toText(body.content) : str(body.content).trim(),
      attachments: ((files && files.value) || []).map((a) => str(a.name)),
    };
  };

  const mailSend = async (args) => {
    const text = argStr(args, 'text', { max: MAX_TEXT });
    const replyTo = argStr(args, 'replyTo', { optional: true, max: 512 });
    let message;
    if (replyTo !== undefined) { if (!MSG_ID.test(replyTo)) fail('bad_args', 'replyTo is not a message id'); }
    else message = { subject: argStr(args, 'subject'), body: { contentType: 'Text', content: text }, toRecipients: addresses(args, 'to'), ccRecipients: addresses(args, 'cc', true) };
    const b = backend(SCOPES.send);
    if (replyTo !== undefined) {
      await api(b, 'POST', '/me/messages/' + encodeURIComponent(replyTo) + '/reply', { body: { comment: text }, as: 'none' });
      return { sent: true, replyTo };
    }
    await api(b, 'POST', b.graph ? '/me/sendMail' : '/me/sendmail', { body: { message, saveToSentItems: true }, as: 'none' });
    return { sent: true };
  };

  // ---- calendar: this week and next, from Monday in the call's zone ----
  const calRead = async () => {
    const b = backend(SCOPES.cal);
    const mon = mondayOf(localDay(Date.parse(call.now), call.zone));
    const start = new Date(midnight(...mon, call.zone)).toISOString(), end = new Date(midnight(...addDays(mon, 14), call.zone)).toISOString();
    const res = await api(b, 'GET', '/me/calendarView?startDateTime=' + start + '&endDateTime=' + end + '&$top=200&$orderby=' + names(b, 'start/dateTime') +
      '&$select=' + names(b, 'id,subject,start,end,organizer,onlineMeeting,isCancelled,responseStatus,webLink'), { headers: { Prefer: 'outlook.timezone="UTC"' } });
    return ((res && res.value) || []).map((e) => ({
      id: str(e.id),
      subject: str(e.subject) || '(no subject)',
      start: isoOr(e.start && e.start.dateTime, start),
      end: isoOr(e.end && e.end.dateTime, end),
      organizer: e.organizer && e.organizer.emailAddress ? e.organizer.emailAddress.name || e.organizer.emailAddress.address || null : null,
      joinUrl: e.onlineMeeting && /^https:\/\//.test(str(e.onlineMeeting.joinUrl)) ? e.onlineMeeting.joinUrl : null,
      response: str(e.responseStatus && e.responseStatus.response) || 'none',
      cancelled: !!e.isCancelled,
      link: https(e.webLink, 'https://' + site + '/calendar/'),
    })).slice(0, 200);
  };

  const READS = { mail: mailRead, cal: calRead };
  const GETS = { mail: mailGet };
  const ACTS = { 'mail.send': mailSend };

  try {
    const doc = env.document;
    if (!doc || doc.readyState === 'loading' || !doc.body || doc.body.childElementCount === 0) fail('blank', 'the tab has not rendered');
    const c = call.config || {};
    site = c.host === undefined ? SITES[0] : c.host;
    if (!SITES.includes(site)) fail('bad_args', 'config.host must be one of ' + SITES.join(', '));
    const here = str(env.location && env.location.hostname);
    if (here !== site) fail('unauthorized', 'the tab is on ' + here + ', not ' + site + '; likely a sign-in page');
    const name = call.verb === 'act' ? call.action : call.concept;
    let data;
    if (call.verb === 'read' && READS[call.concept]) data = await READS[call.concept]();
    else if (call.verb === 'get' && GETS[call.concept]) data = await GETS[call.concept](str(call.id));
    else if (call.verb === 'act' && ACTS[call.action]) data = await ACTS[call.action](call.args || {});
    else fail('bad_args', 'unknown ' + call.verb + ' ' + name);
    return tokenExpiresAt ? { ok: true, data, tokenExpiresAt } : { ok: true, data };
  } catch (e) {
    if (e instanceof Fail) {
      const out = { ok: false, code: e.code, message: scrub(e.message) };
      if (e.retryAfter) out.retryAfter = e.retryAfter;
      return out;
    }
    return { ok: false, code: wrote ? 'unknown' : 'source_error', message: scrub((e && e.name ? e.name + ': ' : '') + (e && e.message ? e.message : String(e))) };
  }
}
