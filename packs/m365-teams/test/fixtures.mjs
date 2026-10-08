// Synthetic Graph chat answers in the recorded shape; every name and id is made up.
import { ME_OID, msalToken } from '../../example/test/harness.mjs';

export const HOST = 'teams.microsoft.com';
export const GRAPH = 'https://graph.microsoft.com/v1.0';
export const SAM = '00000000-0000-0000-0000-00000000b002';
export const LEE = '00000000-0000-0000-0000-00000000c003';
export const TOKENS = {
  chat: msalToken('chat', 'https://graph.microsoft.com/Chat.ReadWrite https://graph.microsoft.com/User.Read'),
};

const user = (id, displayName) => ({ user: { id, displayName } });
const member = (userId, displayName) => ({ userId, displayName });
const preview = (id, at, from, content) => ({ id, createdDateTime: at, isDeleted: false, from, body: { contentType: 'text', content } });

export const CHAT_1 = '19:aaaa1111@unq.gbl.spaces';
export const CHAT_2 = '19:bbbb2222@thread.v2';
export const CHAT_3 = '19:meeting_cccc3333@thread.v2';

export const CHATS = {
  value: [
    { id: CHAT_1, topic: null, chatType: 'oneOnOne', webUrl: null, viewpoint: { lastMessageReadDateTime: '2026-09-30T09:00:00Z' },
      lastMessagePreview: preview('m11', '2026-09-30T10:00:00Z', user(SAM, 'Sam Diaz'), '<p>Can you look at the build?</p>'),
      members: [member(ME_OID, 'Robin Park'), member(SAM, 'Sam Diaz')] },
    { id: CHAT_2, topic: 'Release crew', chatType: 'group', webUrl: 'https://teams.microsoft.com/l/chat/19%3Abbbb2222%40thread.v2/0', viewpoint: { lastMessageReadDateTime: '2026-09-30T11:00:00Z' },
      lastMessagePreview: preview('m21', '2026-09-30T08:00:00Z', user(LEE, 'Lee Chan'), 'Shipped.'),
      members: [member(ME_OID, 'Robin Park'), member(LEE, 'Lee Chan'), member(SAM, 'Sam Diaz')] },
    { id: CHAT_3, topic: 'Planning', chatType: 'meeting', webUrl: null, viewpoint: null,
      lastMessagePreview: preview('m31', '2026-09-30T07:00:00Z', user(ME_OID, 'Robin Park'), 'Notes are up.'),
      members: [] },
  ],
};
export const withoutMembers = { value: CHATS.value.map(({ members, ...c }) => c) };

export const mention = (who) => [{ id: 0, mentionText: 'Robin', mentioned: { user: { id: who, displayName: 'Robin Park' } } }];
export const MESSAGES_1 = {
  value: [
    { id: 'm11', messageType: 'message', createdDateTime: '2026-09-30T10:00:00Z', from: user(SAM, 'Sam Diaz'), body: { contentType: 'html', content: '<at id="0">Robin</at> can you look at the build?' }, mentions: mention(ME_OID) },
    { id: 'm10', messageType: 'message', createdDateTime: '2026-09-30T08:30:00Z', from: user(ME_OID, 'Robin Park'), body: { contentType: 'text', content: 'Morning' }, mentions: [] },
    { id: 'm09', messageType: 'systemEventMessage', createdDateTime: '2026-09-30T08:00:00Z', from: null, body: { content: '' } },
    { id: 'm08', messageType: 'message', createdDateTime: '2026-09-30T07:59:00Z', from: { application: { id: 'app', displayName: 'Build bot' } }, body: { contentType: 'text', content: 'Build 7 failed' } },
    { id: 'm07', messageType: 'message', createdDateTime: '2026-09-30T07:58:00Z', deletedDateTime: '2026-09-30T07:58:30Z', from: user(SAM, 'Sam Diaz'), body: { content: 'oops' } },
  ],
  '@odata.nextLink': GRAPH + '/chats/' + encodeURIComponent(CHAT_1) + '/messages?$top=50&$skiptoken=page2',
};

export const re = (s) => new RegExp('^' + s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'));
export const chatsRoute = (answer = { json: CHATS }) => ['GET', re(GRAPH + '/me/chats?$expand=lastMessagePreview,members&'), answer];
export const messagesRoute = (chat, answer) => ['GET', re(GRAPH + '/chats/' + encodeURIComponent(chat) + '/messages?'), answer];
