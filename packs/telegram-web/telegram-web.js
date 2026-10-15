// Telegram Web K as the person signed in to it: reads and posts through the page's own managers
// (window.rootScope.managers), never by typing into the page. It serves only the chats call.scope
// lists; the console checks the same list before and after, so this check is the second one.
async function (call, env) {
  env = env || {
    managers: window.rootScope && window.rootScope.managers,
    rootScope: window.rootScope,
    location: window.location,
    document: window.document,
    sleep: (ms) => new Promise((ok) => setTimeout(ok, ms)),
  };

  const ID = /^-?[1-9]\d{0,19}$/;
  const MAX_TEXT = 4096, PAGE = 50, PREVIEW = 200, CONFIRM_MS = 10000, STEP_MS = 500;

  class Fail extends Error {
    constructor(code, message, retryAfter) { super(message); this.code = code; this.retryAfter = retryAfter; }
  }
  const fail = (code, message, retryAfter) => { throw new Fail(code, message, retryAfter); };
  // set once sendText was called: from then on no failure is a sure one
  let wrote = false;

  const str = (v) => (v === null || v === undefined ? '' : String(v));
  const iso = (sec) => new Date(Number(sec) * 1000).toISOString();
  const scope = Array.isArray(call.scope) ? call.scope.map(String) : [];

  // ---- the page ----
  const doc = env.document;
  if (!doc || doc.readyState !== 'complete' || !doc.body || !doc.body.childElementCount) return { ok: false, code: 'blank', message: 'the tab has not finished loading' };
  if (!/^\/k\/?/.test(str(env.location && env.location.pathname))) return { ok: false, code: 'blank', message: 'the tab is not on Telegram Web K' };
  const m = env.managers;
  if (!m || !m.apiManager || !m.appMessagesManager || !m.appPeersManager) return { ok: false, code: 'blank', message: 'Telegram Web has not started in this tab' };
  const me = Number(env.rootScope && env.rootScope.myId);
  // myId stays 0 for a moment while a signed-in page boots; only the sign-in pages mean signed out
  if (!me) return doc.getElementById && doc.getElementById('auth-pages')
    ? { ok: false, code: 'unauthorized', message: 'Telegram Web is signed out' }
    : { ok: false, code: 'blank', message: 'Telegram Web is still starting' };

  // ---- the API, through the page's own session ----
  const api = async (method, params) => {
    try { return await m.apiManager.invokeApi(method, params); } catch (e) {
      const type = str(e && (e.type || e.message || e));
      const flood = /^FLOOD_WAIT_(\d+)/.exec(type);
      if (flood) fail('rate_limited', `${method}: ${type}`, Number(flood[1]));
      if (/^(AUTH_KEY_UNREGISTERED|AUTH_KEY_INVALID|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED)/.test(type)) fail('unauthorized', `${method}: ${type}`);
      if (/^(PEER_ID_INVALID|CHAT_ID_INVALID|CHANNEL_INVALID|CHANNEL_PRIVATE|CHAT_FORBIDDEN|USER_BANNED_IN_CHANNEL)/.test(type)) fail('not_found', `${method}: ${type}`);
      fail('source_error', `${method}: ${type || 'failed'}`);
    }
  };
  // a basic group upgraded to a supergroup has a new id, which is not the one the scope lists
  const notMigrated = async (id) => {
    const to = await m.appPeersManager.getPeerMigratedTo(Number(id));
    if (to) fail('chat_migrated', `chat ${id} was upgraded to a supergroup; its new id is ${to}: add it to the scope to go on`);
  };
  const history = async (id, limit, offsetId) => {
    const peer = await m.appPeersManager.getInputPeerById(Number(id));
    return api('messages.getHistory', { peer, offset_id: offsetId || 0, offset_date: 0, add_offset: 0, limit, max_id: 0, min_id: 0, hash: 0 });
  };

  const byId = (list, id) => (list || []).find((x) => x && String(x.id) === String(id));
  const userName = (u, id) => (u ? [u.first_name, u.last_name].filter(Boolean).join(' ') || (u.username ? '@' + u.username : '') : '') || `user ${id}`;
  const chatName = (r, id) => {
    const n = Number(id);
    if (n === me) return 'Saved Messages';
    if (n > 0) return userName(byId(r.users, n), n);
    const c = byId(r.chats, -n);
    return (c && c.title) || `chat ${id}`;
  };
  const fromOf = (msg, id) => {
    const f = msg.from_id;
    if (f && f.user_id !== undefined) return Number(f.user_id);
    return Number(id) > 0 ? (msg.pFlags && msg.pFlags.out ? me : Number(id)) : null;
  };
  const textOf = (msg) => {
    if (msg._ === 'messageService') return `[${str(msg.action && msg.action._).replace(/^messageAction/, '') || 'service'}]`;
    return str(msg.message) || (msg.media ? '[media]' : '');
  };
  const isMine = (msg, id) => !!(msg.pFlags && msg.pFlags.out) || fromOf(msg, id) === me;
  const real = (r) => (r && Array.isArray(r.messages) ? r.messages.filter((x) => x && x._ !== 'messageEmpty') : []);

  const checkId = (id, what) => {
    if (typeof id !== 'string' || !ID.test(id)) fail('bad_args', `${what} must be a chat id, as a string`);
    if (!scope.includes(id)) fail('out_of_scope', `${what} ${id} is not in this workspace's scope`);
  };

  // ---- reads ----
  async function readChats() {
    const out = [];
    for (const id of scope) {
      if (!ID.test(id)) continue;
      await notMigrated(id);
      const r = await history(id, 1);
      const last = real(r)[0];
      const from = last ? fromOf(last, id) : null;
      out.push({
        id, name: chatName(r, id), kind: Number(id) < 0 ? 'group' : 'oneOnOne', unread: 0,
        lastAt: last ? iso(last.date) : null,
        lastFrom: last ? (from === me ? 'me' : from ? userName(byId(r.users, from), from) : null) : null,
        lastPreview: last ? textOf(last).slice(0, PREVIEW) : null,
        link: `https://web.telegram.org/k/#${id}`, mentioned: false,
      });
    }
    return out;
  }

  async function getChat(id, cursor) {
    checkId(id, 'id');
    if (cursor !== undefined && !/^\d{1,12}$/.test(str(cursor))) fail('bad_args', 'cursor is not a message id');
    await notMigrated(id);
    const r = await history(id, PAGE, cursor ? Number(cursor) : 0);
    const msgs = real(r).slice(0, PAGE);
    return {
      messages: msgs.map((x) => {
        const from = fromOf(x, id), u = from ? byId(r.users, from) : null;
        return {
          id: String(x.id), author: from === me ? 'me' : from ? userName(u, from) : chatName(r, id),
          authorKind: isMine(x, id) ? 'me' : u && u.bot ? 'bot' : 'person', at: iso(x.date), text: textOf(x),
        };
      }),
      cursor: msgs.length === PAGE ? String(msgs[msgs.length - 1].id) : null,
    };
  }

  // every dialog the account has, for Settings to tick from; never called by a run
  async function candidates() {
    const r = await api('messages.getDialogs', { offset_date: 0, offset_id: 0, offset_peer: { _: 'inputPeerEmpty' }, limit: 100, hash: 0 });
    const out = [];
    for (const d of (r && r.dialogs) || []) {
      const p = d.peer || {};
      const id = p.user_id !== undefined ? String(p.user_id) : p.chat_id !== undefined ? String(-p.chat_id) : p.channel_id !== undefined ? String(-p.channel_id) : null;
      if (!id || !ID.test(id)) continue;
      const c = p.user_id === undefined ? byId(r.chats, Math.abs(Number(id))) : null;
      out.push({ id, name: p.user_id !== undefined ? (Number(id) === me ? 'Saved Messages' : userName(byId(r.users, p.user_id), p.user_id)) : (c && c.title) || `chat ${id}` });
    }
    return out;
  }

  // ---- acts ----
  // sent = Telegram's server has it: a new message of mine in the chat, found in its history
  async function post(args) {
    const chat = args.chat, text = args.text;
    if (typeof text !== 'string' || !text.trim()) fail('bad_args', 'text must be a non-empty string');
    if (text.length > MAX_TEXT) fail('bad_args', `text is over ${MAX_TEXT} characters`);
    checkId(chat, 'chat');
    await notMigrated(chat);
    const top = real(await history(chat, 1))[0];
    const after = top ? Number(top.id) : 0;
    wrote = true;
    await m.appMessagesManager.sendText({ peerId: Number(chat), text });
    const sleep = env.sleep || ((ms) => new Promise((ok) => setTimeout(ok, ms)));
    for (let waited = 0; waited <= CONFIRM_MS; waited += STEP_MS) {
      const mine = real(await history(chat, 10)).filter((x) => Number(x.id) > after && isMine(x, chat));
      const hit = mine.find((x) => str(x.message).trim() === text.trim()) || mine[0];
      if (hit) return { id: String(hit.id), at: iso(hit.date) };
      await sleep(STEP_MS);
    }
    fail('unknown', `Telegram has not confirmed the message in chat ${chat} within ${CONFIRM_MS / 1000} s; it may or may not have been sent`);
  }

  try {
    if (call.verb === 'read') {
      if (call.concept !== 'chat') fail('bad_args', `no concept ${call.concept}`);
      return { ok: true, data: await readChats() };
    }
    if (call.verb === 'get') {
      if (call.concept !== 'chat') fail('bad_args', `no concept ${call.concept}`);
      return { ok: true, data: await getChat(call.id, call.cursor) };
    }
    if (call.verb === 'act') {
      if (call.action !== 'tg.post') fail('bad_args', `no action ${call.action}`);
      return { ok: true, data: await post(call.args || {}) };
    }
    if (call.verb === 'candidates') return { ok: true, data: await candidates() };
    fail('bad_args', `no verb ${call.verb}`);
  } catch (e) {
    const sure = e instanceof Fail;
    // once sendText was called nothing is sure: the message may be on its way
    const code = wrote ? 'unknown' : sure ? e.code : 'source_error';
    const out = { ok: false, code, message: str(e && e.message) || code };
    if (sure && e.retryAfter && !wrote) out.retryAfter = e.retryAfter;
    return out;
  }
}
