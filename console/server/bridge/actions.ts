import { randomUUID } from 'node:crypto'
import { HttpError } from '../events.ts'
import type { ActReq } from './wire.ts'

/* The page names a chat the way it shows it; A posts by chat id. A name that is not in the chat
   concept is refused: the message goes where the review dialog said, or nowhere. */

const ACTIONS = new Set(['chat.post', 'mail.send', 'review.vote', 'review.comment', 'work.setState', 'work.comment', 'work.start', 'time.fill'])
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

export async function resolveAct(
  a: { action: string; actionId?: string; args?: Record<string, unknown> },
  chats: () => Promise<{ id: string; name: string }[]>,
): Promise<ActReq> {
  if (!a || typeof a.action !== 'string' || !ACTIONS.has(a.action)) throw new HttpError(400, 'unknown_action', `no action ${a?.action}`)
  const args = { ...(a.args || {}) }
  if (typeof args.text === 'string' && !args.text.trim()) throw new HttpError(400, 'bad_args', 'the text is empty')
  if (a.action === 'chat.post' && typeof args.chatName === 'string') {
    const name = norm(args.chatName), hit = (await chats()).find((c) => norm(c.name) === name || c.id === args.chatName)
    const id = hit?.id
    if (!id) throw new HttpError(400, 'unknown_chat', `no chat named ${args.chatName} in the bridge's chat list; nothing was sent`)
    delete args.chatName
    args.chat = id
  }
  return { action: a.action, actionId: typeof a.actionId === 'string' && a.actionId ? a.actionId : randomUUID(), args }
}
