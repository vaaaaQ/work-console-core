import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, get, load, msalToken, read, run } from '../../example/test/harness.mjs';
import { contract } from '../../example/test/contract.mjs';
import { CHAT_1, CHAT_2, CHAT_3, CHATS, GRAPH, HOST, MESSAGES_1, TOKENS, chatsRoute, messagesRoute, re, withoutMembers } from './fixtures.mjs';

const pack = load(new URL('../m365-teams.js', import.meta.url));
const cfg = { host: HOST };
const tab = { pack, host: HOST, storage: [TOKENS.chat] };
const ok = (r) => { assert.equal(r.result.ok, true, r.result.message); assert.deepEqual(r.unmatched, []); return r.result.data; };
const postRoute = (chat, answer) => ['POST', re(GRAPH + '/chats/' + encodeURIComponent(chat) + '/messages'), answer];

test('contract', async (t) => {
  await contract(t, {
    dir: new URL('../', import.meta.url), config: cfg, host: HOST, storage: tab.storage,
    reads: { chat: [chatsRoute(), messagesRoute(CHAT_1, { json: MESSAGES_1 })] },
    gets: { chat: { id: CHAT_1, routes: [messagesRoute(CHAT_1, { json: MESSAGES_1 })] } },
    acts: { 'chat.post': { args: { chat: CHAT_2, text: 'On it.' }, routes: [postRoute(CHAT_2, { status: 201, json: { id: 'm22' } })] } },
  });
});

test('chat read: unread from the viewpoint, names from members, my own last message read', async () => {
  const r = await run(read('chat', { config: cfg }), { ...tab, routes: [chatsRoute(), messagesRoute(CHAT_1, { json: MESSAGES_1 })] });
  const data = ok(r);
  assert.deepEqual(data.map((c) => [c.id, c.name, c.kind, c.unread]), [[CHAT_1, 'Sam Diaz', 'oneOnOne', 1], [CHAT_2, 'Release crew', 'group', 0], [CHAT_3, 'Planning', 'meeting', 0]]);
  assert.deepEqual(data[0], {
    id: CHAT_1, name: 'Sam Diaz', kind: 'oneOnOne', unread: 1, lastAt: '2026-09-30T10:00:00.000Z', lastFrom: 'Sam Diaz',
    lastPreview: 'Can you look at the build?', link: 'https://teams.microsoft.com/l/chat/' + encodeURIComponent(CHAT_1) + '/0', mentioned: true,
  });
  assert.equal(data[1].link, CHATS.value[1].webUrl);
  assert.equal(r.requests[0].headers.Authorization, 'Bearer FAKE-SECRET-chat');
  assert.equal(r.requests[0].credentials, undefined);
  assert.equal(r.result.tokenExpiresAt, '2026-09-30T13:00:00.000Z');
});

test('chat read: the mention lookup is cached per last message across reads in the tab', async () => {
  const mentions = new Map();
  const first = await run(read('chat', { config: cfg }), { ...tab, extra: { mentions }, routes: [chatsRoute(), messagesRoute(CHAT_1, { json: MESSAGES_1 })] });
  assert.equal(ok(first)[0].mentioned, true);
  const second = await run(read('chat', { config: cfg }), { ...tab, extra: { mentions }, routes: [chatsRoute()] });
  assert.equal(ok(second)[0].mentioned, true);
  assert.equal(second.requests.length, 1);
});

test('chat read: a mention older than the read time does not count, and a failed lookup leaves it false', async () => {
  const older = { value: [{ ...MESSAGES_1.value[0], createdDateTime: '2026-09-30T08:00:00Z' }] };
  assert.equal(ok(await run(read('chat', { config: cfg }), { ...tab, routes: [chatsRoute(), messagesRoute(CHAT_1, { json: older })] }))[0].mentioned, false);
  const failed = await run(read('chat', { config: cfg }), { ...tab, routes: [chatsRoute(), messagesRoute(CHAT_1, { status: 500 })] });
  assert.equal(ok(failed)[0].mentioned, false);
});

test('chat read: when members cannot be expanded the list still comes', async () => {
  const r = await run(read('chat', { config: cfg }), { ...tab, routes: [
    chatsRoute({ status: 400 }),
    ['GET', re(GRAPH + '/me/chats?$expand=lastMessagePreview&'), { json: withoutMembers }],
    messagesRoute(CHAT_1, { json: MESSAGES_1 }),
  ] });
  assert.deepEqual(ok(r).map((c) => c.name), ['Chat', 'Release crew', 'Planning']);
});

test('chat get: messages oldest first, who wrote each, system and deleted ones dropped, a cursor for more', async () => {
  const r = await run(get('chat', CHAT_1, { config: cfg }), { ...tab, routes: [messagesRoute(CHAT_1, { json: MESSAGES_1 })] });
  const data = ok(r);
  assert.deepEqual(data.messages.map((m) => [m.id, m.author, m.authorKind]), [['m08', 'Build bot', 'bot'], ['m10', 'Robin Park', 'me'], ['m11', 'Sam Diaz', 'person']]);
  assert.equal(data.messages[2].text, 'Robin can you look at the build?');
  assert.equal(data.cursor, MESSAGES_1['@odata.nextLink']);
  const more = await run(get('chat', CHAT_1, { config: cfg, cursor: data.cursor }), { ...tab, routes: [messagesRoute(CHAT_1, { json: { value: [] } })] });
  assert.deepEqual(ok(more), { messages: [], cursor: null });
  assert.equal(more.requests[0].url, data.cursor);
});

test('chat get: a cursor to another host or another chat is refused before the token goes anywhere', async () => {
  const other = GRAPH + '/chats/' + encodeURIComponent(CHAT_2) + '/messages?$skiptoken=x';
  for (const cursor of ['https://evil.example/v1.0/chats/' + encodeURIComponent(CHAT_1) + '/messages', other, 'not a url']) {
    const r = await run(get('chat', CHAT_1, { config: cfg, cursor }), tab);
    assert.equal(r.result.code, 'bad_args', cursor);
    assert.equal(r.requests.length, 0);
  }
  const bad = await run(get('chat', '19:x/../../me', { config: cfg }), tab);
  assert.equal(bad.result.code, 'bad_args');
  assert.equal(bad.requests.length, 0);
});

const posted = async (text) => {
  const r = await run(act('chat.post', { chat: CHAT_2, text }, { config: cfg }), { ...tab, routes: [postRoute(CHAT_2, { status: 201, json: { id: 'm22' } })] });
  ok(r);
  assert.equal(r.requests[0].body.body.contentType, 'html');
  return r.requests[0].body.body.content;
};

test('chat.post: the text goes as HTML to the chat; a lost answer is unknown; a malformed chat id is refused', async () => {
  const r = await run(act('chat.post', { chat: CHAT_2, text: 'On it.' }, { config: cfg }), { ...tab, routes: [postRoute(CHAT_2, { status: 201, json: { id: 'm22' } })] });
  assert.deepEqual(ok(r), { messageId: 'm22' });
  assert.deepEqual(r.requests[0].body, { body: { contentType: 'html', content: '<p>On it.</p>' } });
  const lost = await run(act('chat.post', { chat: CHAT_2, text: 'x' }, { config: cfg }), { ...tab, routes: [postRoute(CHAT_2, { status: 502 })] });
  assert.equal(lost.result.code, 'unknown');
  for (const chat of ['19:a/b', '../me', '']) {
    const bad = await run(act('chat.post', { chat, text: 'x' }, { config: cfg }), tab);
    assert.equal(bad.result.code, 'bad_args', chat);
    assert.equal(bad.requests.length, 0);
  }
  const long = await run(act('chat.post', { chat: CHAT_2, text: '<'.repeat(8000) }, { config: cfg }), tab);
  assert.equal(long.result.code, 'bad_args');
  assert.match(long.result.message, /as HTML/);
  assert.equal(long.requests.length, 0);
});

test('chat.post: blank lines part paragraphs, a single newline is a line break', async () => {
  assert.equal(await posted('hi Sam,\r\nTwo things.\n\n \nThanks\n'), '<p>hi Sam,<br>Two things.</p><p>Thanks</p>');
});

test('chat.post: &, < and > in the text are escaped, so it never carries markup', async () => {
  assert.equal(await posted('a <b>x</b> & <script>c</script> > d'), '<p>a &lt;b&gt;x&lt;/b&gt; &amp; &lt;script&gt;c&lt;/script&gt; &gt; d</p>');
});

test('chat.post: an http(s) link becomes an anchor with its URL escaped; any other scheme stays text', async () => {
  assert.equal(await posted('See [PR 7](https://dev.example/pr/7?a=1&b="2") and [the page](http://wiki.example/A_(b)).'),
    '<p>See <a href="https://dev.example/pr/7?a=1&amp;b=&quot;2&quot;">PR 7</a> and <a href="http://wiki.example/A_(b)">the page</a>.</p>');
  assert.equal(await posted('[x](javascript:alert(1)) [y](ftp://h.example/f)'), '<p>[x](javascript:alert(1)) [y](ftp://h.example/f)</p>');
});

test('chat.post: **bold** and `code`; nothing inside code is formatted', async () => {
  assert.equal(await posted('**Note:** run `a < b` then `**not bold**`, ** not bold ** either'),
    '<p><b>Note:</b> run <code>a &lt; b</code> then <code>**not bold**</code>, ** not bold ** either</p>');
  assert.equal(await posted('**see [PR 7](https://dev.example/pr/7)**'), '<p><b>see <a href="https://dev.example/pr/7">PR 7</a></b></p>');
});

test('chat.post: "1. " lines are a numbered list, "- " lines a bulleted one, an indented line goes on with its item', async () => {
  assert.equal(await posted('Two questions:\n1. first\n2. second, **bold**\n\n- a\n- b\n  more of b\nThanks'),
    '<p>Two questions:</p><ol><li>first</li><li>second, <b>bold</b></li></ol><ul><li>a</li><li>b<br>more of b</li></ul><p>Thanks</p>');
  assert.equal(await posted('1. one\n\n3. three\n4. four'), '<ol><li>one</li></ol><ol start="3"><li>three</li><li>four</li></ol>');
});

test('chat.post: backslashes stay as written, so a UNC path survives', async () => {
  assert.equal(await posted('Logs: \\\\files-01\\share\\logs, also `\\\\files-01\\share`'),
    '<p>Logs: \\\\files-01\\share\\logs, also <code>\\\\files-01\\share</code></p>');
});

test('tokens: a read-only token cannot post; an expired one cannot read', async () => {
  const ro = await run(act('chat.post', { chat: CHAT_2, text: 'x' }, { config: cfg }), { pack, host: HOST, storage: [msalToken('ro', 'https://graph.microsoft.com/Chat.Read')] });
  assert.equal(ro.result.code, 'unauthorized');
  assert.equal(ro.requests.length, 0);
  const old = await run(read('chat', { config: cfg }), { pack, host: HOST, storage: [msalToken('old', 'https://graph.microsoft.com/Chat.ReadWrite', { expiresOn: '1' })] });
  assert.equal(old.result.code, 'unauthorized');
  assert.equal(old.requests.length, 0);
});

test('config: a site outside the list is refused; a tab on the other site is a sign-in page', async () => {
  const bad = await run(read('chat', { config: { host: 'chat.example' } }), tab);
  assert.equal(bad.result.code, 'bad_args');
  assert.match(bad.result.message, /config\.host/);
  const elsewhere = await run(read('chat', { config: { host: 'teams.cloud.microsoft' } }), tab);
  assert.equal(elsewhere.result.code, 'unauthorized');
  const r = await run(read('chat', { config: { host: 'teams.cloud.microsoft' } }), { ...tab, host: 'teams.cloud.microsoft', routes: [chatsRoute(), messagesRoute(CHAT_1, { json: MESSAGES_1 })] });
  assert.equal(ok(r)[0].link, 'https://teams.cloud.microsoft/l/chat/' + encodeURIComponent(CHAT_1) + '/0');
});
