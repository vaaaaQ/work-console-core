import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, get, load, msalToken, read, run } from '../../example/test/harness.mjs';
import { contract } from '../../example/test/contract.mjs';
import { schema, validate } from '../../example/test/validate.mjs';
import { ATTACHMENTS, BODY, EVENTS, GRAPH, HOST, OUTLOOK, TOKENS, mailRoutes, pascal, re } from './fixtures.mjs';

const pack = load(new URL('../m365-mail.js', import.meta.url));
const graphTab = { pack, host: HOST, storage: [TOKENS.graph, TOKENS.account] };
const outlookTab = { pack, host: HOST, storage: [TOKENS.outlook, TOKENS.account] };
const cfg = { host: HOST };
// Outlook REST returns only what was selected, and it has no message headers to select
const noHeaders = (x) => ({ value: x.value.map(({ internetMessageHeaders, ...m }) => m) });
const ok = (r) => { assert.equal(r.result.ok, true, r.result.message); assert.deepEqual(r.unmatched, []); return r.result.data; };

test('contract', async (t) => {
  await contract(t, {
    dir: new URL('../', import.meta.url), config: cfg, host: HOST, storage: graphTab.storage,
    reads: { mail: mailRoutes(), cal: [['GET', re(GRAPH + '/me/calendarView?'), { json: EVENTS }]] },
    gets: { mail: { id: 'AAMkAD-m1', routes: [['GET', re(GRAPH + '/me/messages/AAMkAD-m1?'), { json: BODY }], ['GET', re(GRAPH + '/me/messages/AAMkAD-m1/attachments?'), { json: ATTACHMENTS }]] } },
    acts: { 'mail.send': { args: { to: ['sam.diaz@acme.example'], subject: 'Re: notes', text: 'Looks good.' }, routes: [['POST', re(GRAPH + '/me/sendMail'), { status: 202 }]] } },
  });
});

test('mail read: inbox and sent with a category each, through Graph with the tab token', async () => {
  const r = await run(read('mail', { config: cfg }), { ...graphTab, routes: mailRoutes() });
  const data = ok(r);
  const by = Object.fromEntries(data.map((m) => [m.id, m]));
  assert.deepEqual(['AAMkAD-m1', 'AAMkAD-m2', 'AAMkAD-m3', 'AAMkAD-m4', 'AAMkAD-m5'].map((id) => by[id].category), ['reply', 'auto', 'fyi', 'wait', 'auto']);
  assert.equal(by['AAMkAD-m4'].myReply, true);
  assert.equal(by['AAMkAD-m1'].myReply, false);
  assert.equal(by['AAMkAD-m4'].link, 'https://outlook.office.com/mail/');
  assert.equal(by['AAMkAD-s1'].folder, 'Sent');
  assert.equal(by['AAMkAD-s1'].unread, false);
  assert.equal(r.requests[0].headers.Authorization, 'Bearer FAKE-SECRET-graph');
  assert.equal(r.requests[0].credentials, undefined);
  assert.match(r.requests[0].url, /\$select=[^&]*internetMessageHeaders/);
  assert.equal(r.result.tokenExpiresAt, '2026-09-30T13:00:00.000Z');
});

test('mail read: a tab with only an Outlook token reads Outlook REST and gives the same items', async () => {
  const viaGraph = ok(await run(read('mail', { config: cfg }), { ...graphTab, routes: mailRoutes() }));
  const r = await run(read('mail', { config: cfg }), { ...outlookTab, routes: mailRoutes(OUTLOOK, (x) => pascal(noHeaders(x))) });
  const data = ok(r);
  // Outlook REST has no message headers, so a list mail is told only by its sender
  assert.deepEqual(data.map((m) => m.id === 'AAMkAD-m5' ? { ...m, category: 'auto' } : m), viaGraph);
  assert.equal(data.find((m) => m.id === 'AAMkAD-m5').category, 'reply');
  assert.match(r.requests[0].url, /\$select=Id,Subject,From,/);
  assert.match(r.requests[0].url, /\$orderby=ReceivedDateTime%20desc/);
  assert.doesNotMatch(r.requests[0].url, /InternetMessageHeaders/i);
  assert.equal(r.requests[0].headers.Authorization, 'Bearer FAKE-SECRET-outlook');
});

test('mail read: Graph wins when the tab holds both tokens', async () => {
  const r = await run(read('mail', { config: cfg }), { pack, host: HOST, storage: [TOKENS.outlook, TOKENS.graph], routes: mailRoutes() });
  ok(r);
  assert.ok(r.requests.every((q) => q.url.startsWith(GRAPH)));
});

test('mail get: the body as text and the attachment names', async () => {
  const r = await run(get('mail', 'AAMkAD-m1', { config: cfg }), { ...graphTab, routes: [
    ['GET', re(GRAPH + '/me/messages/AAMkAD-m1?$select=body,hasAttachments'), { json: BODY }],
    ['GET', re(GRAPH + '/me/messages/AAMkAD-m1/attachments?$select=name'), { json: ATTACHMENTS }],
  ] });
  assert.deepEqual(ok(r), { body: 'Hello & welcome\nLine two', attachments: ['notes.pdf', 'diagram.png'] });
  assert.equal(r.requests[0].headers.Prefer, 'outlook.body-content-type="text"');
  const bad = await run(get('mail', '../me/drafts', { config: cfg }), graphTab);
  assert.equal(bad.result.code, 'bad_args');
  assert.equal(bad.requests.length, 0);
});

test('mail.send: a new mail and a reply through Graph', async () => {
  const sent = await run(act('mail.send', { to: ['sam.diaz@acme.example'], cc: ['lee.chan@acme.example'], subject: 'Notes', text: 'See below.' }, { config: cfg }),
    { ...graphTab, routes: [['POST', re(GRAPH + '/me/sendMail'), { status: 202 }]] });
  assert.deepEqual(ok(sent), { sent: true });
  assert.deepEqual(sent.requests[0].body, {
    message: { subject: 'Notes', body: { contentType: 'Text', content: 'See below.' }, toRecipients: [{ emailAddress: { address: 'sam.diaz@acme.example' } }], ccRecipients: [{ emailAddress: { address: 'lee.chan@acme.example' } }] },
    saveToSentItems: true,
  });
  const reply = await run(act('mail.send', { replyTo: 'AAMkAD-m1', text: 'Thanks.' }, { config: cfg }),
    { ...graphTab, routes: [['POST', re(GRAPH + '/me/messages/AAMkAD-m1/reply'), { status: 202 }]] });
  assert.deepEqual(ok(reply), { sent: true, replyTo: 'AAMkAD-m1' });
  assert.deepEqual(reply.requests[0].body, { comment: 'Thanks.' });
});

test('mail.send: through Outlook REST with PascalCase bodies when only an Outlook token is there', async () => {
  const sent = await run(act('mail.send', { to: ['sam.diaz@acme.example'], subject: 'Notes', text: 'See below.' }, { config: cfg }),
    { ...outlookTab, routes: [['POST', re(OUTLOOK + '/me/sendmail'), { status: 202 }]] });
  ok(sent);
  assert.deepEqual(sent.requests[0].body, {
    Message: { Subject: 'Notes', Body: { ContentType: 'Text', Content: 'See below.' }, ToRecipients: [{ EmailAddress: { Address: 'sam.diaz@acme.example' } }], CcRecipients: [] },
    SaveToSentItems: true,
  });
  const reply = await run(act('mail.send', { replyTo: 'AAMkAD-m1', text: 'Thanks.' }, { config: cfg }),
    { ...outlookTab, routes: [['POST', re(OUTLOOK + '/me/messages/AAMkAD-m1/reply'), { status: 202 }]] });
  ok(reply);
  assert.deepEqual(reply.requests[0].body, { Comment: 'Thanks.' });
});

test('mail.send: bad recipients or a missing subject are refused before any request; a lost answer is unknown', async () => {
  for (const args of [{ to: ['not an address'], subject: 's', text: 't' }, { to: [], subject: 's', text: 't' }, { to: ['a@b.example'], text: 't' }, { replyTo: 'x/../y', text: 't' }]) {
    const r = await run(act('mail.send', args, { config: cfg }), graphTab);
    assert.equal(r.result.code, 'bad_args', JSON.stringify(args));
    assert.equal(r.requests.length, 0);
  }
  const lost = await run(act('mail.send', { replyTo: 'AAMkAD-m1', text: 't' }, { config: cfg }), { ...graphTab, routes: [['POST', /reply$/, { status: 503 }]] });
  assert.equal(lost.result.code, 'unknown');
});

test('tokens: an expired one, one for another resource, or one without the scope is unauthorized with no request', async () => {
  const expired = msalToken('old', 'https://graph.microsoft.com/Mail.Read', { expiresOn: String(Date.parse('2026-09-30T11:00:00Z') / 1000) });
  const other = msalToken('other', 'https://api.example/Mail.Read');
  const readOnly = msalToken('ro', 'https://graph.microsoft.com/Mail.Read');
  for (const [call, storage] of [[read('mail', { config: cfg }), [expired]], [read('mail', { config: cfg }), [other]], [read('cal', { config: cfg }), [readOnly]],
    [act('mail.send', { replyTo: 'AAMkAD-m1', text: 't' }, { config: cfg }), [readOnly]], [read('mail', { config: cfg }), []]]) {
    const r = await run(call, { pack, host: HOST, storage });
    assert.equal(r.result.code, 'unauthorized', JSON.stringify(call));
    assert.equal(r.requests.length, 0);
    assert.doesNotMatch(r.result.message, /FAKE-SECRET/);
  }
});

test('cal read: two weeks from Monday in the call zone, times in UTC', async () => {
  const r = await run(read('cal', { config: cfg, zone: 'America/Sao_Paulo' }), { ...graphTab, routes: [['GET', re(GRAPH + '/me/calendarView?'), { json: EVENTS }]] });
  const data = ok(r);
  const u = new URL(r.requests[0].url);
  assert.equal(u.searchParams.get('startDateTime'), '2026-09-28T03:00:00.000Z');
  assert.equal(u.searchParams.get('endDateTime'), '2026-10-12T03:00:00.000Z');
  assert.equal(r.requests[0].headers.Prefer, 'outlook.timezone="UTC"');
  const s = schema('cal.item');
  for (const e of data) assert.deepEqual(validate(s, e), []);
  assert.deepEqual(data[0], { id: 'AAMkAD-e1', subject: 'Planning', start: '2026-09-30T13:00:00.000Z', end: '2026-09-30T14:00:00.000Z', organizer: 'Sam Diaz', joinUrl: 'https://meet.example/j/1', response: 'accepted', cancelled: false, link: 'https://outlook.office365.com/calendar/item/1' });
  assert.deepEqual([data[1].subject, data[1].organizer, data[1].joinUrl, data[1].response, data[1].cancelled, data[1].link], ['(no subject)', null, null, 'none', true, 'https://outlook.office.com/calendar/']);
});

test('config: a site outside the list is refused; a tab on another site is a sign-in page', async () => {
  const bad = await run(read('mail', { config: { host: 'mail.example' } }), graphTab);
  assert.equal(bad.result.code, 'bad_args');
  assert.match(bad.result.message, /config\.host/);
  assert.equal(bad.requests.length, 0);
  const elsewhere = await run(read('mail', { config: { host: 'outlook.cloud.microsoft' } }), graphTab);
  assert.equal(elsewhere.result.code, 'unauthorized');
  const fallback = await run(read('mail'), { ...graphTab, routes: mailRoutes() });
  assert.equal(fallback.result.ok, true, fallback.result.message);
});

test('errors: 401 and 403 are unauthorized, 429 carries its wait, an HTML page is a sign-in', async () => {
  const at = (answer) => run(read('mail', { config: cfg }), { ...graphTab, routes: [['GET', /Inbox/, answer], ['GET', /SentItems/, { json: { value: [] } }]] });
  assert.equal((await at({ status: 401 })).result.code, 'unauthorized');
  assert.equal((await at({ status: 403 })).result.code, 'unauthorized');
  const rl = await at({ status: 429, headers: { 'Retry-After': '12' } });
  assert.deepEqual([rl.result.code, rl.result.retryAfter], ['rate_limited', 12]);
  assert.equal((await at({ text: '<html>sign in</html>' })).result.code, 'unauthorized');
});
