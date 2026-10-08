/* An ACP session's updates as the console's events: the agent's text as one message per stretch between tool calls,
   and each tool call once, by the name the Claude provider gives it. */

export type FeedEvent = { k: 'text'; t: string } | { k: 'tool'; name: string; input: Record<string, unknown> }
const KIND: Record<string, string> = { execute: 'Shell', read: 'Read', edit: 'Edit', delete: 'Delete', move: 'Move', search: 'Grep', fetch: 'Fetch' }
interface Call { title: string; kind: string; raw: Record<string, unknown>; told: boolean }
const obj = (x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : undefined)

/** own = the session's own MCP server, whose tools go by their bare names; hide = own tools never shown */
export class Feed {
  private text = ''
  private calls = new Map<string, Call>()
  /** the text after the last tool call: the turn's final answer */
  last = ''
  private own?: string
  private hide: string[]
  constructor(own?: string, hide: string[] = []) { this.own = own; this.hide = hide }

  update(u: unknown): FeedEvent[] {
    const x = obj(u)
    if (x?.sessionUpdate === 'agent_message_chunk') {
      const c = obj(x.content)
      if (c?.type === 'text' && typeof c.text === 'string') this.text += c.text
      return []
    }
    if (x?.sessionUpdate !== 'tool_call' && x?.sessionUpdate !== 'tool_call_update') return []
    const id = String(x.toolCallId ?? ''), c = this.calls.get(id) ?? { title: '', kind: 'other', raw: {}, told: false }
    if (typeof x.title === 'string') c.title = x.title
    if (typeof x.kind === 'string') c.kind = x.kind
    const raw = obj(x.rawInput)
    if (raw && Object.keys(raw).length) c.raw = raw
    this.calls.set(id, c)
    // the first update names the tool only; its input comes in a later one, or never
    if (c.told || (!Object.keys(c.raw).length && x.status !== 'completed' && x.status !== 'failed')) return []
    c.told = true
    const out = this.flush(), t = this.named(c)
    this.last = ''
    return t ? [...out, t] : out
  }

  /** the text since the last tool call, as one message */
  flush(): FeedEvent[] {
    const t = this.text
    this.text = ''
    if (!t.trim()) return []
    this.last = t
    return [{ k: 'text', t }]
  }

  /** what a tool call's updates carried, for the permission request that names it */
  raw(id: string): Record<string, unknown> | undefined { return this.calls.get(id)?.raw }

  private named(c: Call): FeedEvent | null {
    const r = c.raw
    if (typeof r.providerIdentifier === 'string' && typeof r.toolName === 'string') {
      const own = r.providerIdentifier === this.own
      if (own && this.hide.includes(r.toolName)) return null
      return { k: 'tool', name: own ? r.toolName : `mcp__${r.providerIdentifier}__${r.toolName}`, input: obj(r.args) ?? {} }
    }
    return { k: 'tool', name: KIND[c.kind] ?? (c.title || c.kind), input: r }
  }
}
