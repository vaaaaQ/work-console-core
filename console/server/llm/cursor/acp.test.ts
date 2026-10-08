import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { Rpc, RpcError } from './acp.ts'

/** an Rpc and the other side's lines: what it wrote, and a way to write to it */
function pair(peer: Partial<ConstructorParameters<typeof Rpc>[2]> = {}) {
  const toUs = new PassThrough(), fromUs = new PassThrough(), got: unknown[] = [], seen: string[] = []
  fromUs.on('data', (b: Buffer) => { for (const l of b.toString().split('\n').filter(Boolean)) got.push(JSON.parse(l)) })
  const rpc = new Rpc(toUs, fromUs, { request: peer.request ?? (() => { throw new RpcError(-32601, 'no') }), notify: peer.notify ?? ((m) => seen.push(m)) })
  const say = (...ms: unknown[]) => toUs.write(ms.map((m) => `${JSON.stringify(m)}\n`).join(''))
  return { rpc, got, seen, say, raw: (t: string) => toUs.write(t) }
}
const tick = () => new Promise((r) => setImmediate(r))

test('a call gets its answer by id, an error as an RpcError with its code and data', async () => {
  const { rpc, got, say } = pair()
  const a = rpc.call('initialize', { v: 1 }), b = rpc.call('session/new', {})
  assert.deepEqual(got[0], { jsonrpc: '2.0', id: 1, method: 'initialize', params: { v: 1 } })
  say({ jsonrpc: '2.0', id: 2, error: { code: -32000, message: 'Authentication required', data: { message: 'x' } } }, { jsonrpc: '2.0', id: 1, result: { ok: true } })
  assert.deepEqual(await a, { ok: true })
  await assert.rejects(b, (e: RpcError) => e.code === -32000 && e.message === 'Authentication required' && (e.data as { message: string }).message === 'x')
})

test('notifications come in line order, and a call\'s then runs as its answer is read, before the lines after it', async () => {
  const order: string[] = []
  const { rpc, say } = pair({ notify: (m, p) => order.push(`${m} ${(p as { n: number }).n}`) })
  const done = rpc.call('session/load', {}, () => order.push('loaded'))
  say({ jsonrpc: '2.0', method: 'session/update', params: { n: 1 } }, { jsonrpc: '2.0', id: 1, result: {} }, { jsonrpc: '2.0', method: 'session/update', params: { n: 2 } })
  await done
  assert.deepEqual(order, ['session/update 1', 'loaded', 'session/update 2'])
})

test('the other side\'s requests get the handler\'s answer, a thrown error its code, and junk lines are skipped', async () => {
  const { got, say, raw } = pair({ request: async (m) => { if (m === 'session/request_permission') return { outcome: { outcome: 'selected', optionId: 'allow-once' } }; throw new RpcError(-32601, `no ${m}`) } })
  say({ jsonrpc: '2.0', id: 0, method: 'session/request_permission', params: {} })
  await tick()
  raw('not json\n[1]\n')
  say({ jsonrpc: '2.0', id: 'x', method: 'fs/read_text_file', params: {} })
  await tick()
  assert.deepEqual(got, [
    { jsonrpc: '2.0', id: 0, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } },
    { jsonrpc: '2.0', id: 'x', error: { code: -32601, message: 'no fs/read_text_file' } },
  ])
})

test('closing fails the calls that wait and every later one', async () => {
  const { rpc } = pair()
  const a = rpc.call('session/prompt', {})
  rpc.close(new Error('the agent exited'))
  await assert.rejects(a, /the agent exited/)
  await assert.rejects(rpc.call('x', {}), /the agent exited/)
})
