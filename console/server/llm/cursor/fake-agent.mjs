// Tests' stand-in for the Cursor agent CLI: replays a recorded ACP stream (fixtures/<name>.jsonl) against the console,
// waits for each line the console is to send, calls the session's MCP server where the recording's agent did, and
// runs the session's hook as the CLI does. What it saw goes to stderr, one JSON line each. Args: the fixture's name, or a
// .jsonl file's path.
// Env: FAKE_WORK replaces <work>; FAKE_SUBST, a JSON list of [from, to], edits the agent's lines; FAKE_HOOK, a JSON
// list of tool calls to put through the hook once the prompt comes.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const arg = process.argv[2], lines = readFileSync(arg.endsWith('.jsonl') ? arg : join(import.meta.dirname, 'fixtures', `${arg}.jsonl`), 'utf8').split('\n').filter(Boolean)
const subst = [['<work>', JSON.stringify(process.env.FAKE_WORK ?? '').slice(1, -1)], ...JSON.parse(process.env.FAKE_SUBST ?? '[]')]
const tell = (k, v) => process.stderr.write(`${JSON.stringify({ [k]: v })}\n`)
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`)

const inbox = [], waiting = []
createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l)
  const w = waiting.findIndex((x) => x.match(m))
  if (w >= 0) waiting.splice(w, 1)[0].ok(m)
  else inbox.push(m)
}).on('close', () => process.exit(0))
const next = (match) => {
  const i = inbox.findIndex(match)
  if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0])
  return new Promise((ok) => waiting.push({ match, ok }))
}

function hook(call) {
  const cfg = JSON.parse(readFileSync(join(process.env.WC_CURSOR_HOME, '.cursor', 'hooks.json'), 'utf8'))
  const cmd = cfg.hooks.preToolUse[0].command, payload = JSON.stringify({ ...call, user_email: 'someone@example.test', hook_event_name: 'preToolUse' })
  if (process.platform !== 'win32') return spawnSync('sh', ['-c', cmd], { input: payload }).stdout.toString()
  const file = join(process.env.TEMP, 'hook-payload.json')
  writeFileSync(file, '﻿' + payload)
  const ps = `$OutputEncoding = [System.Text.Encoding]::UTF8; Get-Content -LiteralPath '${file.replace(/'/g, "''")}' -Raw | & { $input | ${cmd} }`
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true }).stdout.toString()
}

async function mcp(server, name, args) {
  const s = servers.find((x) => x.name === server) ?? servers.find((x) => x.url)
  const r = await fetch(s.url, { method: 'POST', headers: { 'content-type': 'application/json', ...Object.fromEntries(s.headers.map((h) => [h.name, h.value])) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
  return (await r.json()).result
}

const ids = new Map(), raws = new Map(), allowed = new Map(), asked = new Map()
let servers = []
for (const l of lines) {
  const { dir, x } = JSON.parse(l)
  if (dir === '>') {
    if (x.method && x.id !== undefined) {
      const m = await next((m) => m.method === x.method && m.id !== undefined)
      ids.set(x.id, m.id)
      if (m.method === 'session/new' || m.method === 'session/load') { servers = m.params.mcpServers; tell(m.method, m.params) }
      if (m.method === 'session/load') tell('kept', existsSync(join(process.env.CURSOR_CONFIG_DIR, 'acp-sessions', m.params.sessionId, 'meta.json')))
      if (m.method === 'session/prompt') { tell('prompt', m.params.prompt); for (const c of JSON.parse(process.env.FAKE_HOOK ?? '[]')) tell('hook', JSON.parse(hook(c))) }
    } else if (x.method) {
      tell(x.method, (await next((m) => m.method === x.method && m.id === undefined)).params)
    } else {
      const m = await next((m) => m.id === x.id && !m.method)
      const id = m.result?.outcome?.optionId ?? 'cancelled'
      allowed.set(asked.get(x.id), id.startsWith('allow'))
      tell('permission', id)
    }
    continue
  }
  let t = JSON.stringify(x)
  for (const [a, b] of subst) t = t.split(a).join(b)
  const m = JSON.parse(t)
  if (m.id !== undefined && !m.method) m.id = ids.get(m.id)
  // the CLI keeps a new session in its config folder
  if (m.result?.sessionId) { const d = join(process.env.CURSOR_CONFIG_DIR, 'acp-sessions', m.result.sessionId); mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'meta.json'), '{}') }
  if (m.method === 'session/request_permission') asked.set(m.id, m.params.toolCall.toolCallId)
  const u = m.params?.update
  if (u?.rawInput?.providerIdentifier) raws.set(u.toolCallId, u.rawInput)
  if (u?.sessionUpdate === 'tool_call_update' && u.status === 'completed' && raws.has(u.toolCallId) && allowed.get(u.toolCallId) !== false) {
    const r = raws.get(u.toolCallId)
    tell('mcp', { tool: r.toolName, result: await mcp(r.providerIdentifier, r.toolName, r.args) })
  }
  send(m)
}
// the recording is over; the console ends the process
setInterval(() => {}, 1000)
