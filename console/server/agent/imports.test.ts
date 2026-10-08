import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { importCheck, importIssues } from './imports.ts'
import { tempDir } from '../testdirs.ts'

const issues = (t: string) => importIssues('x.ts', t)

test('process, socket, server and vm modules are refused however they are reached', () => {
  for (const [t, why] of [
    ["import { exec } from 'node:child_process'", 'imports node:child_process'],
    ["import cp from 'child_process'", 'imports child_process'],
    ["import * as net from 'node:net'", 'imports node:net'],
    ["export * from 'http'", 'exports from http'],
    ["export { request } from 'node:https'", 'exports from node:https'],
    ["const h = await import('node:http2')", 'imports node:http2'],
    ["const d = require('dgram')", 'requires dgram'],
    ["import tls = require('tls')", 'imports tls'],
    ["import { Worker } from 'node:worker_threads'", 'imports node:worker_threads'],
    ["import cluster from 'cluster'", 'imports cluster'],
    ["import vm from 'node:vm'", 'imports node:vm'],
    ["import { createRequire } from 'node:module'", 'imports node:module'],
    ["import { exec } from 'node:child_process/x'", 'imports node:child_process/x'],
    ["const m = await import('node:' + name)", 'imports of a computed name'],
    ['const m = require(name)', 'requires of a computed name'],
  ]) assert.deepEqual(issues(t), [`1: ${why}`], t)
})

test('fetch and the other network globals are refused; ctx.http, a local fetch and a property named fetch are not', () => {
  assert.deepEqual(issues("const r = await fetch('https://x')"), ['1: uses fetch: use ctx.http'])
  assert.deepEqual(issues("await globalThis.fetch('https://x')"), ['1: uses fetch: use ctx.http'])
  assert.deepEqual(issues("await globalThis['fetch']('https://x')"), ["1: uses globalThis['fetch']"])
  assert.deepEqual(issues('await globalThis[name](u)'), ['1: uses globalThis[Identifier]'])
  assert.deepEqual(issues('try { go() } catch (fetch) { fetch }'), [])
  assert.deepEqual(issues('const { fetch } = ctx; fetch(u)'), [])
  assert.deepEqual(issues('const f = fetch\nf(u)'), ['1: uses fetch: use ctx.http'])
  assert.deepEqual(issues('const o = { fetch }'), ['1: uses fetch: use ctx.http'])
  assert.deepEqual(issues("new WebSocket('wss://x')"), ['1: uses WebSocket: use ctx.http'])
  assert.deepEqual(issues('new XMLHttpRequest()'), ['1: uses XMLHttpRequest: use ctx.http'])
  assert.deepEqual(issues([
    "import { readFileSync } from 'node:fs'",
    "import type { Server } from 'node:http'",
    "export type { IncomingMessage } from 'node:http'",
    "const r = await ctx.http('https://api.example.com')",
    'const o = { fetch: 1 }; o.fetch; class C { fetch() {} }',
    'type T = { fetch(): void }',
    "import pg from 'pg'",
  ].join('\n')), [])
  assert.deepEqual(issues('const fetch = (u: string) => ctx.http(u)\nawait fetch(u)'), [])
  assert.deepEqual(issues('function go(fetch: F) { return fetch(u) }'), [])
})

test('importCheck walks the agent areas, names file and line, skips node_modules', () => {
  const r = tempDir('imports')
  mkdirSync(join(r, 'workspaces', 'w1', 'sub'), { recursive: true })
  mkdirSync(join(r, 'tools', 'node_modules', 'x'), { recursive: true })
  writeFileSync(join(r, 'workspaces', 'w1', 'page.ts'), "export const a = 1\n")
  writeFileSync(join(r, 'workspaces', 'w1', 'sub', 'p.tsx'), "\n\nimport { spawn } from 'node:child_process'\n")
  writeFileSync(join(r, 'tools', 'go.mjs'), "await fetch('https://x')\n")
  writeFileSync(join(r, 'tools', 'notes.md'), "import x from 'net'\n")
  writeFileSync(join(r, 'tools', 'node_modules', 'x', 'i.js'), "require('net')\n")
  assert.deepEqual(importCheck(r, ['workspaces/w1', 'tools', 'missing']), [
    'workspaces/w1/sub/p.tsx:3: imports node:child_process',
    'tools/go.mjs:1: uses fetch: use ctx.http',
  ])
})
