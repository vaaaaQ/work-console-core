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

function fakeTg({ chats, migrated = {}, fail = {}, sent = 'lands', ready = true, myId = ME, signIn = !ready, blobs = {} } = {}) {
  const store = chats ?? {
    [BROTHERS]: { title: 'Покер. Пиво и…', messages: [msg(12, t0 + 60, 'в пятницу?', 7002), msg(11, t0, 'привет', ME, { pFlags: { out: true } })] },
    [OTHER]: { title: 'Work', messages: [msg(5, t0, 'secret', 7003)] },
    [DAN]: { user: true, messages: [msg(3, t0, 'hi', 7002, { from_id: undefined })] },
  };
  const users = [user(ME, 'Valery'), user(7002, 'Dan'), user(7003, 'Boss'), user(7004, 'Bot', { bot: true })];
  const calls = [];
  const managers = {
    apiManager: {
      async invokeApi(method, params, opts) {
        calls.push(['invokeApi', method, params, opts]);
        const f = typeof fail[method] === 'function' ? fail[method]() : fail[method];
        if (f) throw f;
        if (method === 'upload.getFile') {
          const b = blobs[String(params.location.id)];
          if (!b) throw { type: 'FILE_ID_INVALID' };
          return { _: 'upload.file', bytes: b.subarray(params.offset, params.offset + params.limit) };
        }
        if (method === 'messages.getDialogs') return {
          _: 'messages.dialogs',
          dialogs: [{ peer: { _: 'peerChat', chat_id: 4780440133 } }, { peer: { _: 'peerUser', user_id: 7002 } }, { peer: { _: 'peerChannel', channel_id: 1500 } }],
          chats: [{ _: 'chat', id: 4780440133, title: 'Покер. Пиво и…' }, { _: 'channel', id: 1500, title: 'News' }], users,
        };
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
    document: { readyState: 'complete', body: { childElementCount: 3 }, getElementById: (id) => (signIn && id === 'auth-pages' ? {} : null) },
    sleep: async () => {},
  };
  return { env, calls, store, sends: () => calls.filter((c) => c[0] === 'sendText'), apis: () => calls.filter((c) => c[0] === 'invokeApi') };
}
const scoped = (call, scope = [BROTHERS]) => ({ ...call, scope });
const okData = (r) => { assert.equal(r.ok, true, r.message); return r.data; };

const FILES = '-4111111111';
const blob = (n) => Uint8Array.from({ length: n }, (_, i) => i % 251);
const docMedia = (id, size, mime, attributes) => ({ _: 'messageMediaDocument', document: { _: 'document', id, access_hash: 'h' + id, file_reference: [1, 2], dc_id: 4, mime_type: mime, size, attributes } });
const photoMedia = (id) => ({ _: 'messageMediaPhoto', photo: { _: 'photo', id, access_hash: 'h' + id, file_reference: [3], dc_id: 2, sizes: [
  { _: 'photoSize', type: 'm', w: 320, h: 240, size: 20000 }, { _: 'photoSizeProgressive', type: 'y', w: 1280, h: 960, sizes: [10000, 60000, 157000] }] } });
const media = (id, m, text = '') => msg(id, t0 + id, text, 7002, { media: m });
const filesChat = () => ({ [FILES]: { title: 'Docs', messages: [
  media(26, docMedia('d26', 1048576, 'application/pdf', [{ _: 'documentAttributeFilename', file_name: 'even.pdf' }])),
  media(25, docMedia('d25', 50 * 1048576, 'video/mp4', [{ _: 'documentAttributeVideo', duration: 100, w: 640, h: 360 }])),
  media(24, { _: 'messageMediaWebPage', webpage: { _: 'webPage', url: 'https://x.example/' } }, 'see https://x.example/'),
  media(23, { _: 'messageMediaGeo', geo: { _: 'geoPoint', lat: 1, long: 2 } }),
  media(22, docMedia('d22', 62000, 'audio/ogg', [{ _: 'documentAttributeAudio', pFlags: { voice: true }, duration: 42 }])),
  media(21, photoMedia('p21'), 'смотри'),
  media(20, docMedia('d20', '1200000', 'application/pdf', [{ _: 'documentAttributeFilename', file_name: 'acta.pdf' }])),
] } });
const withFiles = (o = {}) => fakeTg({ chats: filesChat(), blobs: { d20: blob(1200000), d22: blob(62000), d26: blob(1048576), p21: blob(157000) }, ...o });
const fileCall = (id, file) => ({ verb: 'file', concept: 'chat', id, file, scope: [FILES] });
const gets = (tg, method) => tg.apis().filter((c) => c[1] === method);

test('pack.json: one tab on web.telegram.org/k, a chat concept scoped by id and tg.post scoped by chat', () => {
  assert.deepEqual(manifest.hosts, ['web.telegram.org']);
  assert.match('https://web.telegram.org/k/#-4780440133', new RegExp(manifest.tabs.tg.match));
  assert.equal(manifest.concepts.chat.scope, 'id');
  assert.deepEqual(manifest.actions['tg.post'], { tab: 'tg', concept: 'chat', scope: 'chat' });
});

test('candidates: every dialog as {id, name}, ids as the scope takes them, with no scope needed', async () => {
  const tg = fakeTg();
  const data = okData(await pack({ verb: 'candidates' }, tg.env));
  assert.deepEqual(data, [{ id: BROTHERS, name: 'Покер. Пиво и…' }, { id: DAN, name: 'Dan' }, { id: '-1500', name: 'News' }]);
  assert.deepEqual(tg.apis().map((c) => c[1]), ['messages.getDialogs']);
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

test('a tab on the sign-in pages is unauthorized; one still loading, or booting with no user yet, is blank; for every verb, and nothing runs', async () => {
  for (const [o, code] of [[{ ready: false }, 'unauthorized'], [{ ready: false, signIn: false }, 'blank']]) {
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

test('pack.json: the chat concept serves files', () => {
  assert.equal(manifest.concepts.chat.files, true);
});

test('get: a message with media says what it carries instead of [media], lists its file, and keeps the caption', async () => {
  const tg = withFiles();
  const d = okData(await pack(get('chat', FILES, { scope: [FILES] }), tg.env));
  assert.deepEqual(validate(schema('chat.get'), d), []);
  assert.deepEqual(d.messages.map((x) => [x.id, x.text]), [
    ['26', '[document "even.pdf", application/pdf, 1.0 MB]'],
    ['25', '[video 1:40, 50.0 MB]'],
    ['24', 'see https://x.example/'],
    ['23', '[geo]'],
    ['22', '[voice 0:42, 61 KB]'],
    ['21', '[photo 1280×960, 153 KB] смотри'],
    ['20', '[document "acta.pdf", application/pdf, 1.1 MB]'],
  ]);
  const files = Object.fromEntries(d.messages.filter((x) => x.files).map((x) => [x.id, x.files]));
  assert.deepEqual(files, {
    26: [{ file: '26', name: 'even.pdf', mime: 'application/pdf', size: 1048576 }],
    25: [{ file: '25', name: 'video-25.mp4', mime: 'video/mp4', size: 52428800 }],
    22: [{ file: '22', name: 'voice-22.ogg', mime: 'audio/ogg', size: 62000 }],
    21: [{ file: '21', name: 'photo-21.jpg', mime: 'image/jpeg', size: 157000 }],
    20: [{ file: '20', name: 'acta.pdf', mime: 'application/pdf', size: 1200000 }],
  });
  assert.deepEqual(gets(tg, 'upload.getFile'), [], 'get downloads nothing');
});

test('get: a web page without text is a link line', async () => {
  const chats = { [FILES]: { title: 'Docs', messages: [media(30, { _: 'messageMediaWebPage', webpage: { _: 'webPage', url: 'https://y.example/a' } })] } };
  const d = okData(await pack(get('chat', FILES, { scope: [FILES] }), fakeTg({ chats }).env));
  assert.equal(d.messages[0].text, '[link https://y.example/a]');
});

test('file: the message is fetched fresh and the file comes back whole, in 512 KB precise parts from its own DC', async () => {
  const tg = withFiles();
  const d = okData(await pack(fileCall(FILES, '20'), tg.env));
  assert.deepEqual([d.name, d.mime, d.size], ['acta.pdf', 'application/pdf', 1200000]);
  assert.deepEqual(Buffer.from(d.base64, 'base64'), Buffer.from(blob(1200000)));
  const h = gets(tg, 'messages.getHistory');
  assert.deepEqual([h.length, h[0][2].offset_id, h[0][2].limit], [1, 21, 1]);
  const parts = gets(tg, 'upload.getFile');
  assert.deepEqual(parts.map((c) => c[2].offset), [0, 524288, 1048576]);
  for (const c of parts) {
    assert.deepEqual([c[2].limit, c[2].precise, c[2].location._, c[2].location.id, c[2].location.thumb_size], [524288, true, 'inputDocumentFileLocation', 'd20', '']);
    assert.deepEqual(c[3], { dcId: 4, fileDownload: true });
  }
});

test('file: a photo downloads its largest size; a file ending on a part boundary stops at the empty part', async () => {
  const tg = withFiles();
  const p = okData(await pack(fileCall(FILES, '21'), tg.env));
  assert.deepEqual([p.name, p.mime, p.size], ['photo-21.jpg', 'image/jpeg', 157000]);
  const loc = gets(tg, 'upload.getFile')[0][2].location;
  assert.deepEqual([loc._, loc.id, loc.thumb_size], ['inputPhotoFileLocation', 'p21', 'y']);
  const even = okData(await pack(fileCall(FILES, '26'), tg.env));
  assert.equal(even.size, 1048576);
  assert.equal(gets(tg, 'upload.getFile').filter((c) => c[2].location.id === 'd26').length, 3);
});

test('file: over 20 MB is too_large with its size, before any download', async () => {
  const tg = withFiles();
  const r = await pack(fileCall(FILES, '25'), tg.env);
  assert.deepEqual([r.ok, r.code, r.message], [false, 'too_large', 'video-25.mp4 is 50.0 MB, the limit is 20 MB']);
  assert.deepEqual(gets(tg, 'upload.getFile'), []);
});

test('file: a chat out of scope, a bad file id, or a message without a file never downloads', async () => {
  const tg = withFiles();
  assert.equal((await pack({ ...fileCall(OTHER, '5'), scope: [FILES] }, tg.env)).code, 'out_of_scope');
  assert.equal((await pack(fileCall(FILES, 'x'), tg.env)).code, 'bad_args');
  const geo = await pack(fileCall(FILES, '23'), tg.env);
  assert.deepEqual([geo.code, geo.message], ['not_found', `message 23 in chat ${FILES} has no file`]);
  assert.equal((await pack(fileCall(FILES, '19'), tg.env)).code, 'not_found', 'a message that is gone');
  assert.deepEqual(gets(tg, 'upload.getFile'), []);
});

test('file: an expired file reference fetches the message once more; a second expiry is a source_error', async () => {
  let n = 0;
  const tg = withFiles({ fail: { 'upload.getFile': () => (n++ === 0 ? { type: 'FILE_REFERENCE_EXPIRED' } : undefined) } });
  assert.equal(okData(await pack(fileCall(FILES, '22'), tg.env)).size, 62000);
  assert.equal(gets(tg, 'messages.getHistory').length, 2);
  const always = withFiles({ fail: { 'upload.getFile': { type: 'FILE_REFERENCE_EXPIRED' } } });
  const r = await pack(fileCall(FILES, '22'), always.env);
  assert.equal(r.code, 'source_error');
  assert.match(r.message, /FILE_REFERENCE_EXPIRED/);
  assert.equal(gets(always, 'messages.getHistory').length, 2);
});

test('file: fewer bytes than the message declared is a source_error, not a truncated file', async () => {
  const tg = withFiles({ blobs: { d20: blob(1200000 - 524288) } });
  const r = await pack(fileCall(FILES, '20'), tg.env);
  assert.deepEqual([r.ok, r.code, r.message], [false, 'source_error', 'acta.pdf: got 675712 of 1200000 bytes']);
});

test('file: a flood wait while downloading is rate_limited with its seconds', async () => {
  const tg = withFiles({ fail: { 'upload.getFile': { type: 'FLOOD_WAIT_7' } } });
  const r = await pack(fileCall(FILES, '20'), tg.env);
  assert.deepEqual([r.code, r.retryAfter], ['rate_limited', 7]);
});
