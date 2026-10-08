import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bus } from '../events.ts'
import { demoFake } from '../testkit.ts'
import type { WsConfig } from '../workspace.ts'
import { localSource } from '../bridge/local.ts'
import { startFakeCdp } from './fake-cdp.ts'
import type { Browser } from './launcher.ts'
import { SCHEMAS_DIR } from './schema.ts'
import { serveBridge } from './serve.ts'
import type { StateDocs } from './state.ts'

/* The gateway contract test, unedited, run against localSource: the demo's data in a fake CDP tab, read through
   a pack, served on the gateway wire. */

const CONSOLE = join(import.meta.dirname, '..', '..')
const PACKS = join(import.meta.dirname, 'testdata', 'packs')
const CFG = { gatewayUrl: 'http://127.0.0.1:1', consoleTokenPath: '', llmTokenPath: '', workDir: '', runTools: [], teamTz: null, maxSessions: 1 } as WsConfig
/** the demo's chat kinds are older names than the chat schema's */
const KIND: Record<string, string> = { channel: 'group', 'meeting chat': 'meeting', direct: 'oneOnOne' }
type It = { id: string; [k: string]: unknown }

test('the gateway contract test passes against localSource', { timeout: 90_000 }, async (t) => {
  const seed = demoFake(), cs = seed.concepts as Record<string, It[]>
  const DATA = { ...cs, chat: cs.chat.map((c) => ({ ...c, kind: KIND[String(c.kind)] ?? c.kind })) }
  const GETS = {
    chat: Object.fromEntries(Object.entries(seed.threads).map(([id, m]) => [id, { messages: m.slice(0, 50), cursor: null }])),
    work: Object.fromEntries(cs.work.map((w) => [w.id, {
      type: w.type, title: w.title, state: w.state, assignedTo: w.assignedTo ?? null, description: '', reproSteps: '', acceptanceCriteria: '', comments: [],
    }])),
  }
  // main's work.get schema lacks the header the contract asks a work get for, so work gets go unchecked here
  const schemas = mkdtempSync(join(tmpdir(), 'wc-contract-schemas-'))
  cpSync(SCHEMAS_DIR, schemas, { recursive: true })
  rmSync(join(schemas, 'work.get.schema.json'))

  const cdp = await startFakeCdp(), bus = new Bus()
  cdp.addTab('https://contract.example/app', { DATA, GETS })
  const browser: Browser = { endpoint: () => cdp.url, status: () => ({ state: 'up' }), start: async () => {}, stop: async () => {}, onChange: () => () => {} }
  const docs: StateDocs = { load: async () => ({ docs: {}, seq: 0 }), put: async () => {}, seq: async () => {} }
  const src = localSource(CFG, {
    bus, ws: 'contract', grants: () => ({ packs: ['contract'], hosts: ['contract.example'], config: {} }),
    docs, browser, packsDir: PACKS, schemasDir: schemas, tickMs: 50,
  })
  src.start()
  const served = await serveBridge({ source: src, bus, port: 0, llmToken: () => 'llm-contract', consoleToken: () => 'console-contract', statusMs: 2000 })
  try {
    const end = Date.now() + 10_000
    while (Date.now() < end && !Object.values(src.concepts()).every((s) => s === 'ready')) await new Promise((ok) => setTimeout(ok, 50))
    assert.ok(Object.values(src.concepts()).every((s) => s === 'ready'), `every concept ready: ${JSON.stringify(src.concepts())}`)

    // a nested test run reports to its own stdout only when it is not told it is a child of this one
    const env: NodeJS.ProcessEnv = { ...process.env, GATEWAY_URL: served.url, GATEWAY_TOKEN: 'console-contract' }
    delete env.NODE_TEST_CONTEXT
    const child = spawn(process.execPath, [
      '--experimental-strip-types', '--no-warnings=ExperimentalWarning', '--env-file=test.env', '--test', '--test-reporter=tap', join('server', 'bridge', 'contract.test.ts'),
    ], { cwd: CONSOLE, env })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    const code = await new Promise<number | null>((ok) => child.on('close', ok))
    assert.equal(code, 0, out)
    assert.match(out, /^# fail 0$/m, out)
    const pass = Number(/^# pass (\d+)$/m.exec(out)?.[1])
    assert.ok(pass >= 6, `${pass} passed:\n${out}`)
    const skipped = Number(/^# skipped (\d+)$/m.exec(out)?.[1])
    // only the picture test may skip: no work get here lists a picture, as no pack serves an image concept
    assert.ok(skipped <= 1, `${skipped} skipped:\n${out}`)
    t.diagnostic(`contract.test.ts: ${pass} passed, ${skipped} skipped`)
  } finally {
    src.stop()
    await served.close()
    await cdp.close()
    rmSync(schemas, { recursive: true, force: true })
  }
})
