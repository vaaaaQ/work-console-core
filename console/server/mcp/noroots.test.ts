import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { NOROOTS } from '../llm/mcpRun.ts'

const FAKE = join(import.meta.dirname, 'testdata', 'fake-server.mjs')

/** starts command args, says what a client offering MCP roots says (initialize with roots, initialized, roots changed),
    and returns the tool names the server lists */
async function toolsSeen(command: string, args: string[]): Promise<string[]> {
  const child = spawn(command, args, { stdio: 'pipe', windowsHide: true })
  try {
    const answers = createInterface({ input: child.stdout })
    const reply = (id: number) => new Promise<Record<string, any>>((ok) => answers.on('line', (l) => { const m = JSON.parse(l); if (m.id === id) ok(m) }))
    const write = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`)
    const init = reply(1)
    write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { roots: { listChanged: true }, elicitation: {} }, clientInfo: { name: 't', version: '1' } } })
    await init
    write({ jsonrpc: '2.0', method: 'notifications/initialized' })
    write({ jsonrpc: '2.0', method: 'notifications/roots/list_changed' })
    const list = reply(2)
    write({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    return (await list).result.tools.map((t: { name: string }) => t.name)
  } finally { child.kill() }
}

test("a server started through the roots wrapper never hears of the client's MCP roots; its own args reach it as they were", async () => {
  assert.deepEqual(await toolsSeen(process.execPath, [FAKE, 'roots', 'a b']), ['list', 'saw-arg-a b', 'saw-roots', 'saw-changed'], 'without the wrapper the server sees them')
  assert.deepEqual(await toolsSeen(process.execPath, [NOROOTS, process.execPath, FAKE, 'roots', 'a b']), ['list', 'saw-arg-a b'])
})

test("the roots wrapper ends as its server ends, with the server's exit code and its stderr", async () => {
  const child = spawn(process.execPath, [NOROOTS, process.execPath, FAKE, 'exit'], { stdio: 'pipe', windowsHide: true })
  let err = ''
  child.stderr.on('data', (b: Buffer) => { err += b })
  const code = await new Promise<number | null>((ok) => child.on('close', ok))
  assert.equal(code, 3)
  assert.match(err, /cannot read the config file/)
})

test('the roots wrapper says so when its command does not start', async () => {
  const child = spawn(process.execPath, [NOROOTS, 'no-such-command-ad26'], { stdio: 'pipe', windowsHide: true })
  let err = ''
  child.stderr.on('data', (b: Buffer) => { err += b })
  const code = await new Promise<number | null>((ok) => child.on('close', ok))
  assert.notEqual(code, 0)
  assert.match(err, /no-such-command-ad26/)
})
