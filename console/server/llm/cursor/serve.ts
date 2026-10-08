import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { z } from 'zod'
import type { AskTool } from '../sdk.ts'

/* A session's own MCP server and its hook's guard, on a loopback port and behind a token of their own: the CLI reaches
   the console's tools only through them, and only while the session lives. */

export type Content = { content: unknown[]; isError?: boolean }
export interface ServedTool { name: string; description: string; inputSchema: Record<string, unknown>; call(a: Record<string, unknown>): Promise<Content> }
/** mcp = the MCP endpoint, guard = where the hook posts a tool call for its verdict; both take the bearer token */
export interface Served { mcp: string; guard: string; token: string; close(): Promise<void> }

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']
/** add_artifact sends a whole file in its input */
const MAX_BODY = 32 << 20
const text = (t: string, isError = false): Content => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) })
const failed = (e: unknown) => text(`failed: ${(e as Error)?.message || e}`, true)
const noSchemaKey = (s: Record<string, unknown>) => { const { $schema: _, ...rest } = s; return rest }
const shapeSchema = (shape: z.ZodRawShape) => noSchemaKey(z.toJSONSchema(z.object(shape), { io: 'input' }) as Record<string, unknown>)
const checked = (r: { success: boolean; error?: z.ZodError }) => (r.success ? null : text(`invalid input: ${z.prettifyError(r.error!)}`, true))

/** a tool made with the Agent SDK's tool(): its zod fields check the input before its handler sees it */
export function sdkTool(t: { name: string; description: string; inputSchema: z.ZodRawShape; handler(a: never, extra: unknown): Promise<unknown> }): ServedTool {
  const check = z.object(t.inputSchema)
  return {
    name: t.name, description: t.description, inputSchema: shapeSchema(t.inputSchema),
    async call(a) { const r = check.safeParse(a); return checked(r) ?? (await t.handler(r.data as never, {}) as Content) },
  }
}

/** an ask's or a workspace agent's own tool: its answer as text */
export function askTool(t: AskTool): ServedTool {
  const check = z.object(t.input)
  return {
    name: t.name, description: t.description, inputSchema: shapeSchema(t.input),
    async call(a) { const r = check.safeParse(a); if (!r.success) return checked(r)!; try { return text(await t.run(r.data)) } catch (e) { return failed(e) } },
  }
}

/** the answer tool: the asked schema as its input (an object's own, any other under value), each call checked against
    it; got = each valid answer, the last one counts */
export const ANSWER = 'answer'
export function answerTool(schema: Record<string, unknown>, got: (v: unknown) => void): ServedTool {
  const wrap = schema.type !== 'object'
  const input = wrap ? { type: 'object', properties: { value: noSchemaKey(schema) }, required: ['value'] } : noSchemaKey(schema)
  let check: z.ZodType | null = null
  try { check = z.fromJSONSchema(input as never) } catch { /* a schema zod cannot read is taken as it comes */ }
  return {
    name: ANSWER, description: 'Give your answer: its input is the answer, in the asked shape. Call it once, at the end; nothing else counts as the answer.', inputSchema: input,
    async call(a) {
      const r = check?.safeParse(a)
      if (r && !r.success) return checked(r)!
      got(wrap ? a.value : a)
      return text('answer received; stop here')
    },
  }
}

const same = (got: string, want: string) => { const a = Buffer.from(got), b = Buffer.from(want); return a.length === b.length && timingSafeEqual(a, b) }
const bearer = (req: IncomingMessage) => /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1]?.trim() ?? ''
function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((ok, no) => {
    const parts: Buffer[] = []; let n = 0
    req.on('data', (c: Buffer) => { n += c.length; if (n > MAX_BODY) { no(new Error('too large')); req.destroy() } else parts.push(c) })
    req.on('end', () => { try { ok(JSON.parse(Buffer.concat(parts).toString('utf8').replace(/^﻿/, ''))) } catch (e) { no(e) } })
    req.on('error', no)
  })
}
const out = (res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'cache-control': 'no-store', ...(body === undefined ? {} : { 'content-type': 'application/json; charset=utf-8' }), ...headers })
  res.end(body === undefined ? undefined : JSON.stringify(body))
}
type Msg = { id?: string | number | null; method?: string; params?: Record<string, unknown> }

/** name = the server's name as the CLI shows it; guard = the hook's verdict on a tool call */
export async function serveSession(o: { name: string; tools: ServedTool[]; guard(input: unknown): unknown }): Promise<Served> {
  const token = randomBytes(32).toString('hex'), byName = new Map(o.tools.map((t) => [t.name, t]))

  async function one(m: Msg, made: { sid?: string }) {
    const reply = (result: unknown) => ({ jsonrpc: '2.0', id: m?.id ?? null, result })
    const error = (code: number, message: string) => ({ jsonrpc: '2.0', id: m?.id ?? null, error: { code, message } })
    if (!m || typeof m !== 'object' || typeof m.method !== 'string') return error(-32600, 'not a JSON-RPC request')
    if (m.id === undefined) return undefined
    switch (m.method) {
      case 'initialize': {
        const asked = String(m.params?.protocolVersion || '')
        made.sid = randomUUID()
        return reply({ protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: o.name, version: '1.0.0' } })
      }
      case 'ping': return reply({})
      case 'tools/list': return reply({ tools: o.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
      case 'tools/call': {
        const t = byName.get(String(m.params?.name))
        if (!t) return error(-32602, `no tool ${m.params?.name}`)
        const a = m.params?.arguments
        try { return reply(await t.call(a && typeof a === 'object' && !Array.isArray(a) ? a as Record<string, unknown> : {})) } catch (e) { return reply(failed(e)) }
      }
      default: return error(-32601, `no method ${m.method}`)
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (!same(bearer(req), token)) return out(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'missing or wrong bearer token' } })
    if (req.method !== 'POST') return out(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'POST only; this server sends no event stream' } }, { allow: 'POST' })
    const path = (req.url ?? '').split('?')[0]
    let body: unknown
    try { body = await readJson(req) } catch { return out(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'the body is not JSON' } }) }
    if (path === '/guard') {
      let v: unknown
      try { v = await o.guard(body) } catch (e) { v = { permission: 'deny', user_message: `the guard failed: ${(e as Error).message}`, agent_message: 'the guard failed' } }
      return out(res, 200, v)
    }
    if (path !== '/mcp') return out(res, 404, { error: 'not found' })
    const made: { sid?: string } = {}, batch = Array.isArray(body)
    const replies = (await Promise.all(((batch ? body : [body]) as Msg[]).map((m) => one(m, made)))).filter((r) => r !== undefined)
    const headers: Record<string, string> = made.sid ? { 'mcp-session-id': made.sid } : {}
    if (!replies.length) return out(res, 202, undefined, headers)
    out(res, 200, batch ? replies : replies[0], headers)
  }

  const srv = createServer((req, res) => { handle(req, res).catch(() => { if (!res.headersSent) out(res, 500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'the console hit an error' } }) }) })
  await new Promise<void>((ok, no) => { srv.once('error', no); srv.listen(0, '127.0.0.1', () => ok()) })
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
  return {
    mcp: `${base}/mcp`, guard: `${base}/guard`, token,
    close: () => new Promise<void>((ok) => { srv.close(() => ok()); srv.closeAllConnections() }),
  }
}
