import { randomUUID } from 'node:crypto'
import { HttpError } from '../events.ts'
import { grantedPacks } from '../browser/packs.ts'
import type { PackGrants } from '../browser/packs.ts'
import type { PackManifest } from './packs.ts'
import type { ActReq } from './wire.ts'

// what a gateway's pack serves; a workspace on loaded packs passes actionsOf instead
export const GATEWAY_ACTIONS: ReadonlySet<string> = new Set(['chat.post', 'mail.send', 'review.vote', 'review.comment', 'work.setState', 'work.comment', 'work.start', 'time.fill'])
type Declares = Pick<PackManifest, 'name' | 'actions'>

// acts undefined: every declared action; a list: only those granted that some pack declares
export function actionsOf(packs: readonly Declares[], acts?: readonly string[]): ReadonlySet<string> {
  const declared = new Set(packs.flatMap((p) => Object.keys(p.actions || {})))
  return acts === undefined ? declared : new Set(acts.filter((a) => declared.has(a)))
}

/** a managed workspace's allowed set on a source that loads no packs itself: what its granted packs declare, less
    what its grants leave out; a pack that does not load under the grants gives nothing */
export function grantedActs(g: PackGrants, dir?: string, schemas?: string, warn: (m: string) => void = console.error): ReadonlySet<string> {
  const { packs, problems } = grantedPacks(g, dir, schemas)
  for (const [n, why] of Object.entries(problems)) warn(`pack ${n} gives no actions: ${why}`)
  return actionsOf(packs, g.acts)
}

export function actionPacks(packs: readonly Declares[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const p of packs) for (const a of Object.keys(p.actions || {})) out.set(a, [...(out.get(a) || []), p.name])
  return out
}

/* The page names a chat the way it shows it; A posts by chat id. A name that is not in the chat
   concept is refused: the message goes where the review dialog said, or nowhere. */

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

export async function resolveAct(
  a: { action: string; actionId?: string; args?: Record<string, unknown> },
  chats: () => Promise<{ id: string; name: string }[]>,
  allowed: ReadonlySet<string> = GATEWAY_ACTIONS,
): Promise<ActReq> {
  if (!a || typeof a.action !== 'string' || !allowed.has(a.action)) throw new HttpError(400, 'unknown_action', `no action ${a?.action}`)
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
