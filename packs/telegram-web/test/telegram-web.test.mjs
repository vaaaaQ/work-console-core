import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { act, get, load, read } from '../../example/test/harness.mjs';
import { schema, validate } from '../../example/test/validate.mjs';

/* The pack against a fake Web K: managers that answer messages.getHistory from a store of chats and record every call.
   Every action is tried on an allowed chat and on a denied one; a denied one never reaches the managers. */

const pack = load(new URL('../telegram-web.js', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('../pack.json', import.meta.url), 'utf8'));
const ME = 7001, BROTHERS = '-4780440133', OTHER = '-4000000001', DAN = '7002';

const user = (id, first, o = {}) => ({ _: 'user', id, first_name: first, ...o });
const msg = (id, date, text, from, o = {}) => ({ _: 'message', id, date, message: text, from_id: { _: 'peerUser', user_id: from }, pFlags: {}, ...o });
const t0 = Date.parse('2026-10-11T12:00:00Z') / 1000;

function fakeTg({ chats, migrated = {}, fail = {}, sent = 'lands', ready = true, myId = ME } = {}) {
  const store = chats ?? {
    [BROTHERS]: { title: 'Покер. Пиво и…', messages: [msg(12, t0 + 60, 'в пятницу?', 7002), msg(11, t0, 'привет', ME, { pFlags: { out: true } })] },
    [OTHER]: { title: 'Work', messages: [msg(5, t0, 'secret', 7003)] },
    [DAN]: { user: true, messages: [msg(3, t0, 'hi', 7002, { from_id: undefined })] },
  };
  const users = [user(ME, 'Valery'), user(7002, 'Dan'), user(7003, 'Boss'), user(7004, 'Bot', { bot: true })];
  const calls = [];
  const managers = {
    apiManager: {
      async invokeApi(method, params) {
        calls.push(['invokeApi', method, params]);
        if (fail[method]) throw fail[method];
        const id = String(params.peer.id), c = store[id];
        if (!c) throw { type: 'PEER_ID_INVALID' };
        const list = c.messages.filter((x) => !params.offset_id || x.id < params.offset_id).slice(0, params.limit);
        return { _: 'messages.messages', messages: list, chats: c.user ? [] : [{ _: 'chat', id: -Number(id), title: c.title }], users };
      },
    },
    appPeersManager: {
      async getInputPeerById(peerId) { calls.push(['getInputPeerById', peerId]); return { _: 'inputPeerFake', id: peerId }; },
      async getPeerMigratedTo(peerId) { calls.push(['getPeerMigratedTo', peerId]); return migrated[String(peerId)]; },
    },
    appMessagesManager: {
      async sendText(o) {
        calls.push(['sendText', o]);
        if (sent === 'throws') throw { type: 'NETWORK_ERROR' };
        if (sent === 'lands') store[String(o.peerId)].messages.unshift(msg(100, t0 + 120, o.text, ME, { pFlags: { out: true } }));
      },
    },
  };
  const env = {
    managers, rootScope: { myId: ready ? myId : 0 },
    location: { hostname: 'web.telegram.org', pathname: '/k/', href: 'https://web.telegram.org/k/' },
    document: { readyState: 'complete', body: { childElementCount: 3 } },
    sleep: async () => {},
  };
  return { env, calls, store, sends: () => calls.filter((c) => c[0] === 'sendText'), apis: () => calls.filter((c) => c[0] === 'invokeApi') };
}
const scoped = (call, scope = [BROTHERS]) => ({ ...call, scope });
const okData = (r) => { assert.equal(r.ok, true, r.message); return r.data; };

test('pack.json: one tab on web.telegram.org/k, a chat concept scoped by id and tg.post scoped by chat', () => {
  assert.deepEqual(manifest.hosts, ['web.telegram.org']);
  assert.match('https://web.telegram.org/k/#-4780440133', new RegExp(manifest.tabs.tg.match));
  assert.equal(manifest.concepts.chat.scope, 'id');
  assert.deepEqual(manifest.actions['tg.post'], { tab: 'tg', concept: 'chat', scope: 'chat' });
});

test('read: one item per allowed chat, in the chat schema, and nothing about a chat not in scope', async () => {
  const tg = fakeTg();
  const data = okData(await pack(scoped(read('chat'), [BROTHERS, DAN]), tg.env));
  assert.deepEqual(data.map((c) => [c.id, c.name, c.kind, c.lastFrom, c.lastPreview]), [[BROTHERS, 'Покер. Пиво и…', 'group', 'Dan', 'в пятницу?'], [DAN, 'Dan', 'oneOnOne', 'Dan', 'hi']]);
  const s = schema('chat.item');
  data.forEach((it, i) => assert.deepEqual(validate(s, it, `$[${i}]`), []));
  assert.ok(!tg.apis().some((c) => String(c[2].peer.id) === OTHER), 'the denied chat is never read');
  assert.ok(!JSON.stringify(data).includes('secret'));
});

test('read: with no scope it reads nothing and calls nothing', async () => {
  const tg = fakeTg();
  assert.deepEqual(okData(await pack(read('chat'), tg.env)), []);
  assert.deepEqual(tg.apis(), []);
});

test('get: an allowed chat gives its messages newest first in the chat.get schema, mine marked me', async () => {
  const tg = fakeTg();
  const d = okData(await pack(scoped(get('chat', BROTHERS)), tg.env));
  assert.deepEqual(validate(schema('chat.get'), d), []);
  assert.deepEqual(d.messages.map((x) => [x.id, x.author, x.authorKind, x.text]), [['12', 'Dan', 'person', 'в пятницу?'], ['11', 'me', 'me', 'привет']]);
  assert.equal(d.cursor, null);
});

test('get: a chat not in scope is out_of_scope and never read; a malformed id is bad_args', async () => {
  const tg = fakeTg();
  const r = await pack(scoped(get('chat', OTHER)), tg.env);
  assert.deepEqual([r.ok, r.code], [false, 'out_of_scope']);
  assert.equal((await pack(scoped(get('chat', 'abc')), tg.env)).code, 'bad_args');
  assert.deepEqual(tg.apis(), []);
});

test('tg.post: an allowed chat gets the text, and it counts as sent only once the server has it', async () => {
  const tg = fakeTg();
  const d = okData(await pack(scoped(act('tg.post', { chat: BROTHERS, text: 'играем в 8' })), tg.env));
  assert.deepEqual(d, { id: '100', at: new Date((t0 + 120) * 1000).toISOString() });
  assert.deepEqual(tg.sends(), [['sendText', { peerId: Number(BROTHERS), text: 'играем в 8' }]]);
});

test('tg.post: a chat not in scope is out_of_scope and nothing is sent', async () => {
  const tg = fakeTg();
  const r = await pack(scoped(act('tg.post', { chat: OTHER, text: 'hi' })), tg.env);
  assert.deepEqual([r.ok, r.code], [false, 'out_of_scope']);
  assert.deepEqual(tg.sends(), []);
  const none = await pack(act('tg.post', { chat: BROTHERS, text: 'hi' }), tg.env);
  assert.equal(none.code, 'out_of_scope', 'no scope = no chat');
  assert.deepEqual(tg.sends(), []);
});

test('tg.post: bad args are refused before anything runs', async () => {
  const tg = fakeTg();
  for (const args of [{}, { chat: BROTHERS }, { chat: BROTHERS, text: '  ' }, { chat: BROTHERS, text: 'x'.repeat(4097) }, { chat: Number(BROTHERS), text: 'hi' }, { text: 'hi' }])
    assert.equal((await pack(scoped(act('tg.post', args)), tg.env)).code, 'bad_args', JSON.stringify(args).slice(0, 60));
  assert.deepEqual(tg.calls, []);
});

test('tg.post: no server confirmation, or a send that throws, is unknown: it may or may not have gone', async () => {
  for (const sent of ['never', 'throws']) {
    const tg = fakeTg({ sent });
    const r = await pack(scoped(act('tg.post', { chat: BROTHERS, text: 'hi' })), tg.env);
    assert.deepEqual([r.ok, r.code], [false, 'unknown'], sent);
    assert.equal(tg.sends().length, 1, 'sent once, never retried');
  }
});

test('a chat upgraded to a supergroup is refused with its new id, on read, get and tg.post, and nothing is sent', async () => {
  const tg = fakeTg({ migrated: { [BROTHERS]: -1999999999 } });
  for (const call of [read('chat'), get('chat', BROTHERS), act('tg.post', { chat: BROTHERS, text: 'hi' })]) {
    const r = await pack(scoped(call), tg.env);
    assert.equal(r.code, 'chat_migrated', call.verb);
    assert.match(r.message, /-1999999999/);
  }
  assert.deepEqual(tg.sends(), []);
});

test('a signed-out tab is unauthorized and a tab still loading is blank, for every verb, and nothing runs', async () => {
  for (const [o, code] of [[{ ready: false }, 'unauthorized']]) {
    const tg = fakeTg(o);
    for (const call of [read('chat'), get('chat', BROTHERS), act('tg.post', { chat: BROTHERS, text: 'hi' })]) assert.equal((await pack(scoped(call), tg.env)).code, code);
    assert.deepEqual(tg.calls, []);
  }
  const tg = fakeTg();
  const loading = { ...tg.env, document: { readyState: 'loading' } };
  for (const call of [read('chat'), get('chat', BROTHERS), act('tg.post', { chat: BROTHERS, text: 'hi' })]) assert.equal((await pack(scoped(call), loading)).code, 'blank');
  assert.equal((await pack(scoped(read('chat')), { ...tg.env, managers: undefined })).code, 'blank');
  assert.deepEqual(tg.calls, []);
});

test('API errors: a flood wait is rate_limited with its seconds, a revoked session is unauthorized', async () => {
  const flood = fakeTg({ fail: { 'messages.getHistory': { type: 'FLOOD_WAIT_42' } } });
  const r = await pack(scoped(read('chat')), flood.env);
  assert.deepEqual([r.code, r.retryAfter], ['rate_limited', 42]);
  const revoked = fakeTg({ fail: { 'messages.getHistory': { type: 'SESSION_REVOKED' } } });
  assert.equal((await pack(scoped(get('chat', BROTHERS)), revoked.env)).code, 'unauthorized');
});

test('an unknown concept, action or verb is bad_args', async () => {
  const tg = fakeTg();
  assert.equal((await pack(scoped(read('mail')), tg.env)).code, 'bad_args');
  assert.equal((await pack(scoped(act('chat.post', { chat: BROTHERS, text: 'x' })), tg.env)).code, 'bad_args');
  assert.deepEqual(tg.sends(), []);
});
