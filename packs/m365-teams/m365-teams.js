// A Microsoft Teams pack: one function the carrier evaluates in a signed-in Teams web tab as
// (script)(call). It reads chats through Graph with the tab's own MSAL token and never returns the
// token, not even inside an error message.
async function (call, env) {
  env = env || {
    fetch: (url, init) => fetch(url, init),
    localStorage: window.localStorage,
    location: window.location,
    document: window.document,
    // survives between calls in this tab until a reload; only a cache
    mentions: (globalThis.__wcMentions = globalThis.__wcMentions || new Map()),
  };

  const GRAPH = 'https://graph.microsoft.com/v1.0';
  const SITES = ['teams.microsoft.com', 'teams.cloud.microsoft'];
  const RESOURCE = /^(https:\/\/)?graph\.microsoft\.com\//;
  const SCOPES = { read: ['Chat.ReadWrite', 'Chat.Read'], post: ['Chat.ReadWrite', 'ChatMessage.Send'] };
  const CHAT_ID = /^\d{1,3}:[A-Za-z0-9._@-]{1,200}$/;
  const MAX_TEXT = 28000;
  // a mention lookup runs only while the read is young, so the list never misses the carrier's timeout
  const MENTION_BUDGET_MS = 2500;
  const started = Date.now();

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
  const iso = (t) => {
    if (t === null || t === undefined || t === '') return null;
    let s = String(t).trim().replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1');
    if (!/(Z|[+-]\d\d:?\d\d)$/.test(s)) s += 'Z';
    const d = new Date(s);
    return isNaN(d) ? null : d.toISOString();
  };

  // ---- http: a bearer token, never the cookies ----
  const http = async (method, url, { headers = {}, body } = {}) => {
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
    if (res.status === 202 || res.status === 204) return null;
    let text;
    try { text = await res.text(); }
    catch (e) { fail(lost, where + ': the answer broke off'); }
    if (/^\s*</.test(text)) fail('unauthorized', where + ' answered with a page, not JSON');
    try { return text ? JSON.parse(text) : null; }
    catch { fail(lost, where + ': the answer is not JSON'); }
  };

  // ---- MSAL tokens in this tab ----
  const token = (scopes) => {
    const ls = env.localStorage, now = Date.parse(call.now) || Date.now(), want = scopes.map((s) => '/' + s.toLowerCase());
    let best = null;
    for (let i = 0; ls && i < ls.length; i++) {
      const key = ls.key(i);
      if (!/accesstoken/i.test(key)) continue;
      let v;
      try { v = JSON.parse(ls.getItem(key)); } catch { continue; }
      if (!v || typeof v.secret !== 'string' || typeof v.target !== 'string') continue;
      secrets.add(v.secret);
      const exp = Number(v.expiresOn) * 1000, targets = v.target.toLowerCase().split(/\s+/);
      if (!(exp > now)) continue;
      if (targets.some((s) => RESOURCE.test(s) && want.some((w) => s.endsWith(w))) && (!best || exp > best.exp))
        best = { secret: v.secret, exp, me: str(v.homeAccountId).split('.')[0] };
    }
    if (!best) fail('unauthorized', 'no live Graph token in this tab for ' + scopes.join(' or '));
    const at = new Date(best.exp).toISOString();
    if (!tokenExpiresAt || at < tokenExpiresAt) tokenExpiresAt = at;
    return best;
  };
  const graph = (t, method, url, body) => http(method, url, { headers: { Authorization: 'Bearer ' + t.secret }, body });

  // ---- args ----
  const argStr = (args, name, { max = 400 } = {}) => {
    const v = args ? args[name] : undefined;
    if (typeof v !== 'string' || !v.trim()) fail('bad_args', name + ' must be a non-empty string');
    if (v.length > max) fail('bad_args', name + ' is longer than ' + max);
    return v;
  };
  const chatId = (v, name) => { if (typeof v !== 'string' || !CHAT_ID.test(v)) fail('bad_args', name + ' is not a chat id'); return v; };

  const pool = async (items, n, fn) => {
    const out = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
    }));
    return out;
  };
  const within = (p, ms) => new Promise((ok) => {
    const t = setTimeout(() => ok(undefined), Math.max(0, ms));
    p.then((v) => { clearTimeout(t); ok(v); }, () => { clearTimeout(t); ok(undefined); });
  });

  let site;

  // per chat, keyed by its last message: when the messages that @mention me were written
  const mentionsOf = (t, unread) => {
    const cache = env.mentions || new Map();
    for (const id of cache.keys()) if (!unread.some((c) => c.id === id)) cache.delete(id);
    let limited = false;
    const lookup = async (c) => {
      const hit = cache.get(c.id);
      if (hit && hit.last === c.last) return hit.at;
      if (limited || Date.now() - started >= MENTION_BUDGET_MS) return undefined;
      const fetched = graph(t, 'GET', GRAPH + '/chats/' + encodeURIComponent(c.id) + '/messages?$top=20').then((res) => {
        const at = ((res && res.value) || []).filter((m) => m.messageType === 'message' && !m.deletedDateTime
          && !(m.from && m.from.user && m.from.user.id === t.me)
          && (m.mentions || []).some((x) => x && x.mentioned && x.mentioned.user && x.mentioned.user.id === t.me))
          .map((m) => iso(m.createdDateTime)).filter(Boolean);
        cache.set(c.id, { last: c.last, at });
        return at;
      }, (e) => { if (e instanceof Fail && e.code === 'rate_limited') limited = true; throw e; });
      return within(fetched, MENTION_BUDGET_MS - (Date.now() - started));
    };
    return pool(unread, 4, lookup);
  };

  const chatRead = async () => {
    const t = token(SCOPES.read);
    const q = '$top=50&$orderby=lastMessagePreview/createdDateTime%20desc';
    let res;
    try { res = await graph(t, 'GET', GRAPH + '/me/chats?$expand=lastMessagePreview,members&' + q); }
    catch (e) {
      if (!(e instanceof Fail) || e.code !== 'source_error') throw e;
      res = await graph(t, 'GET', GRAPH + '/me/chats?$expand=lastMessagePreview&' + q);
    }
    const threads = ((res && res.value) || []).filter((c) => c && typeof c.id === 'string').map((c) => {
      const p = c.lastMessagePreview && !c.lastMessagePreview.isDeleted ? c.lastMessagePreview : null;
      const others = (c.members || []).filter((m) => m.userId !== t.me).map((m) => m.displayName).filter(Boolean);
      const lastAt = p ? iso(p.createdDateTime) : null;
      const fromMe = p && p.from && p.from.user && p.from.user.id === t.me;
      const readAt = c.viewpoint && c.viewpoint.lastMessageReadDateTime ? Date.parse(c.viewpoint.lastMessageReadDateTime) : 0;
      const item = {
        id: c.id,
        name: c.topic || others.join(', ') || 'Chat',
        kind: ['oneOnOne', 'group', 'meeting'].includes(c.chatType) ? c.chatType : 'group',
        unread: p && !fromMe && lastAt && Date.parse(lastAt) > readAt ? 1 : 0,
        lastAt,
        lastFrom: p && p.from ? ((p.from.user || p.from.application || {}).displayName || null) : null,
        lastPreview: p && p.body ? clip(toText(p.body.content), 200) : null,
        link: /^https:\/\//.test(str(c.webUrl)) ? c.webUrl : 'https://' + site + '/l/chat/' + encodeURIComponent(c.id) + '/0',
        mentioned: false,
      };
      return { item, readAt, last: str(p && (p.id || p.createdDateTime)) };
    }).sort((a, b) => str(b.item.lastAt).localeCompare(str(a.item.lastAt))).slice(0, 50);
    const unread = threads.filter((x) => x.item.unread).map((x) => ({ id: x.item.id, last: x.last, x }));
    const at = await mentionsOf(t, unread);
    unread.forEach((c, i) => { c.x.item.mentioned = (at[i] || []).some((when) => Date.parse(when) > c.x.readAt); });
    return threads.map((x) => x.item);
  };

  const chatGet = async (id, cursor) => {
    chatId(id, 'id');
    // a cursor is Graph's own nextLink of this chat; anything else would send the token elsewhere
    if (cursor) {
      let u = null;
      try { u = new URL(cursor); } catch { /* not a URL */ }
      if (!u || u.origin !== 'https://graph.microsoft.com' || decodeURIComponent(u.pathname) !== '/v1.0/chats/' + id + '/messages')
        fail('bad_args', 'cursor is not a nextLink of this chat');
    }
    const t = token(SCOPES.read);
    const res = await graph(t, 'GET', cursor || GRAPH + '/chats/' + encodeURIComponent(id) + '/messages?$top=50');
    const messages = ((res && res.value) || [])
      .filter((m) => m.messageType === 'message' && !m.deletedDateTime)
      .map((m) => {
        const from = m.from || {};
        return {
          id: str(m.id),
          author: (from.user || from.application || {}).displayName || 'unknown',
          authorKind: from.user && from.user.id === t.me ? 'me' : from.application ? 'bot' : 'person',
          at: iso(m.createdDateTime) || new Date(0).toISOString(),
          text: toText(m.body && m.body.content),
        };
      })
      .sort((a, b) => a.at.localeCompare(b.at));
    return { messages, cursor: (res && res['@odata.nextLink']) || null };
  };

  const chatPost = async (args) => {
    const chat = chatId(args.chat, 'chat'), text = argStr(args, 'text', { max: MAX_TEXT });
    const t = token(SCOPES.post);
    const res = await graph(t, 'POST', GRAPH + '/chats/' + encodeURIComponent(chat) + '/messages', { body: { contentType: 'text', content: text } });
    return { messageId: res && res.id ? String(res.id) : null };
  };

  const READS = { chat: chatRead };
  const GETS = { chat: chatGet };
  const ACTS = { 'chat.post': chatPost };

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
    else if (call.verb === 'get' && GETS[call.concept]) data = await GETS[call.concept](str(call.id), call.cursor || null);
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
