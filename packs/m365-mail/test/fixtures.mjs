// Synthetic Graph answers in the recorded shape; every name and address is made up.
import { msalAccount, msalToken } from '../../example/test/harness.mjs';

export const HOST = 'outlook.office.com';
export const ME = 'robin.park@acme.example';

export const TOKENS = {
  graph: msalToken('graph', 'https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Calendars.Read'),
  outlook: msalToken('outlook', 'https://outlook.office.com/Mail.ReadWrite https://outlook.office.com/Mail.Send https://outlook.office.com/Calendars.ReadWrite'),
  account: msalAccount(ME),
};

const person = (name, address) => ({ emailAddress: { name, address } });
const msg = (id, o) => ({
  id, subject: 'Release notes', from: person('Sam Diaz', 'sam.diaz@acme.example'), toRecipients: [person('Robin Park', ME)], ccRecipients: [],
  receivedDateTime: '2026-09-30T09:00:00Z', sentDateTime: '2026-09-30T08:59:00Z', isRead: false, bodyPreview: 'Please check the notes.',
  conversationId: 'conv-' + id, webLink: 'https://outlook.office365.com/owa/?ItemID=' + id, ...o,
});

export const INBOX = {
  value: [
    msg('AAMkAD-m1'),
    msg('AAMkAD-m2', { from: person('Builds', 'noreply@notify.example'), subject: 'Build passed', isRead: true }),
    msg('AAMkAD-m3', { from: person('Lee Chan', 'lee.chan@acme.example'), toRecipients: [person('Sam Diaz', 'sam.diaz@acme.example')], ccRecipients: [person('Robin Park', ME)] }),
    msg('AAMkAD-m4', { conversationId: 'conv-4', receivedDateTime: '2026-09-30T08:00:00Z', webLink: null }),
    msg('AAMkAD-m5', { internetMessageHeaders: [{ name: 'List-Unsubscribe', value: '<mailto:leave@lists.example>' }], subject: 'Weekly digest' }),
  ],
};
export const SENT = {
  value: [msg('AAMkAD-s1', { from: person('Robin Park', ME), toRecipients: [person('Sam Diaz', 'sam.diaz@acme.example')], conversationId: 'conv-4', sentDateTime: '2026-09-30T10:00:00Z', receivedDateTime: undefined, isRead: true })],
};
export const BODY = { body: { contentType: 'html', content: '<p>Hello &amp; welcome</p><p>Line two</p>' }, hasAttachments: true };
export const ATTACHMENTS = { value: [{ name: 'notes.pdf' }, { name: 'diagram.png' }] };

export const EVENTS = {
  value: [
    { id: 'AAMkAD-e1', subject: 'Planning', start: { dateTime: '2026-09-30T13:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-09-30T14:00:00.0000000', timeZone: 'UTC' },
      organizer: person('Sam Diaz', 'sam.diaz@acme.example'), onlineMeeting: { joinUrl: 'https://meet.example/j/1' }, isCancelled: false, responseStatus: { response: 'accepted' }, webLink: 'https://outlook.office365.com/calendar/item/1' },
    { id: 'AAMkAD-e2', subject: '', start: { dateTime: '2026-10-01T09:00:00.0000000' }, end: { dateTime: '2026-10-01T09:30:00.0000000' },
      organizer: null, onlineMeeting: null, isCancelled: true, responseStatus: null, webLink: null },
  ],
};

// Outlook REST v2 answers the same data with PascalCase names.
export const pascal = (v) => Array.isArray(v) ? v.map(pascal)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k.startsWith('@') ? k : k[0].toUpperCase() + k.slice(1), pascal(x)]))
  : v;

export const GRAPH = 'https://graph.microsoft.com/v1.0';
export const OUTLOOK = 'https://outlook.office.com/api/v2.0';
export const re = (s) => new RegExp('^' + s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'));
export const mailRoutes = (base = GRAPH, shape = (x) => x) => [
  ['GET', re(base + '/me/mailFolders/Inbox/messages?'), { json: shape(INBOX) }],
  ['GET', re(base + '/me/mailFolders/SentItems/messages?'), { json: shape(SENT) }],
];
