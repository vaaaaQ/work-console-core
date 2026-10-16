import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { CHECK_WAIT, checkServer, npxHint } from './check.ts'

const FAKE = join(import.meta.dirname, 'testdata', 'fake-server.mjs')
const node = (mode: string, more: Record<string, unknown> = {}) => ({ command: process.execPath, args: [FAKE, mode], ...more })
const TOOLS = [{ name: 'list', readOnly: true, about: 'lists' }, { name: 'run', destructive: true, about: 'runs a command' }, { name: 'upload' }]

test('Check starts a stdio server, lists its tools over every page with their hints, and stops it', async () => {
  const r = await checkServer(node('ok'), { vars: {} })
  assert.deepEqual(r, { ok: true, tools: TOOLS, server: 'fake 1.0.0' })
})

test("Check says why a server did not answer: it exited (with its stderr), it hung past the time, a variable is missing; secrets never show", async () => {
  const exit = await checkServer(node('exit'), { vars: {} })
  assert.equal(exit.ok, false)
  assert.match(!exit.ok ? exit.error : '', /^the server exited with code 3: cannot read the config file/)
  const hang = await checkServer(node('hang'), { vars: {}, timeoutMs: 300 })
  assert.deepEqual(hang, { ok: false, error: 'the server did not answer in 0.3 s' })
  const missing = await checkServer(node('ok', { env: { SECRET: '${env:GONE}' } }), { vars: {} })
  assert.deepEqual(missing, { ok: false, error: "no variable GONE (set it in the console's environment or in mcp.env)" })
  const secret = await checkServer(node('secret', { env: { SECRET: '${env:S}' } }), { vars: { S: 'hunter22' } })
  assert.equal(secret.ok, false)
  assert.match(!secret.ok ? secret.error : '', /auth failed with \*\*\*/)
  assert.doesNotMatch(JSON.stringify(secret), /hunter22/)
})

test('Check speaks streamable HTTP: a JSON answer or an event stream, the session id carried, the headers sent with their values', async () => {
  const seen: { auth?: string; session?: string; method?: string }[] = []
  const srv = createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    if (req.method !== 'POST') { res.writeHead(405).end(); return }
    const m = JSON.parse(body)
    seen.push({ auth: req.headers.authorization, session: req.headers['mcp-session-id'] as string | undefined, method: m.method })
    if (m.id === undefined) { res.writeHead(202).end(); return }
    if (m.method === 'initialize') {
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's-1' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'web', version: '2' } } }))
    } else {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'search', annotations: { readOnlyHint: true } }] } })}\n\n`)
    }
  })
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok))
  try {
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/mcp`
    const r = await checkServer({ type: 'http', url, headers: { Authorization: 'Bearer ${env:T}' } }, { vars: { T: 'tok-1' } })
    assert.deepEqual(r, { ok: true, tools: [{ name: 'search', readOnly: true }], server: 'web 2' })
    assert.deepEqual(seen, [
      { auth: 'Bearer tok-1', session: undefined, method: 'initialize' },
      { auth: 'Bearer tok-1', session: 's-1', method: 'notifications/initialized' },
      { auth: 'Bearer tok-1', session: 's-1', method: 'tools/list' },
    ])
    const bad = await checkServer({ type: 'http', url: url.replace('/mcp', ''), headers: {} }, { vars: {} })
    assert.equal(bad.ok, true, 'this test server answers any path')
  } finally { srv.close() }
})

test('a config that is neither a command nor a url is refused before anything starts', async () => {
  assert.deepEqual(await checkServer({ type: 'ws', url: 'ws://x' }, { vars: {} }), { ok: false, error: 'a server is a command (stdio) or an http url' })
})

test("Check waits 5 minutes, a first npx start's download; a server npx started that exited gets a hint about npx's cache", async () => {
  assert.equal(CHECK_WAIT, 300_000)
  assert.match(npxHint({ command: 'npx', args: ['-y', 'x@1'] }, 'the server exited with code 1: "x" is not recognized'), /npx's cache may hold a half-finished install of x@1/)
  assert.equal(npxHint({ command: 'node', args: ['s.mjs'] }, 'the server exited with code 1'), '')
  assert.equal(npxHint({ command: 'npx', args: ['-y', 'x@1'] }, 'the server did not answer in 300 s'), '')
})
