import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'

/* JSON-RPC 2.0 over a child's stdout and stdin, one message a line, as ACP speaks it. */

export class RpcError extends Error {
  code: number
  data?: unknown
  constructor(code: number, message: string, data?: unknown) { super(message); this.code = code; this.data = data }
}
/** request = the other side's call, its answer or a thrown RpcError; notify = its notification, taken in line order */
export interface Peer { request(method: string, params: unknown): Promise<unknown> | unknown; notify(method: string, params: unknown): void }
interface Pending { ok(x: unknown): void; no(e: Error): void; then?: () => void }

export class Rpc {
  private next = 1
  private pending = new Map<number, Pending>()
  private out: Writable
  private peer: Peer
  closed: Error | null = null

  constructor(input: Readable, out: Writable, peer: Peer) {
    this.out = out
    this.peer = peer
    out.on('error', (e) => this.close(e))
    createInterface({ input, crlfDelay: Infinity }).on('line', (l) => this.line(l))
  }

  /** then = called as the answer's line is read, before any later line */
  call(method: string, params: unknown, then?: () => void): Promise<unknown> {
    if (this.closed) return Promise.reject(this.closed)
    const id = this.next++
    return new Promise((ok, no) => { this.pending.set(id, { ok, no, then }); this.send({ jsonrpc: '2.0', id, method, params }) })
  }
  notify(method: string, params: unknown) { if (!this.closed) this.send({ jsonrpc: '2.0', method, params }) }

  close(why: Error) {
    if (this.closed) return
    this.closed = why
    for (const p of this.pending.values()) p.no(why)
    this.pending.clear()
  }

  private send(m: unknown) { this.out.write(`${JSON.stringify(m)}\n`) }

  private line(l: string) {
    let m: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string; data?: unknown } }
    try { m = JSON.parse(l) } catch { return }
    if (!m || typeof m !== 'object') return
    if (typeof m.method === 'string' && m.id !== undefined) { void this.answer(m.id, m.method, m.params); return }
    if (typeof m.method === 'string') { this.peer.notify(m.method, m.params); return }
    const p = typeof m.id === 'number' ? this.pending.get(m.id) : undefined
    if (!p) return
    this.pending.delete(m.id as number)
    p.then?.()
    if (m.error) p.no(new RpcError(m.error.code ?? -32603, m.error.message ?? 'error', m.error.data))
    else p.ok(m.result)
  }

  private async answer(id: number | string, method: string, params: unknown) {
    try { const result = await this.peer.request(method, params); if (!this.closed) this.send({ jsonrpc: '2.0', id, result: result ?? null }) } catch (e) {
      const r = e instanceof RpcError ? e : new RpcError(-32603, (e as Error).message)
      if (!this.closed) this.send({ jsonrpc: '2.0', id, error: { code: r.code, message: r.message } })
    }
  }
}
