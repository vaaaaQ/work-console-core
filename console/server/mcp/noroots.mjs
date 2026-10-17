// Starts a stdio MCP server and passes its messages through unchanged, except that the server never hears of the
// client's MCP roots: the roots capability leaves initialize and a roots-changed notification is dropped. A server
// such as the reference filesystem one puts a client's roots in place of the folders its args name, and Claude Code
// offers a run's work dir as a root. Usage: node noroots.mjs <command> [args...]. Plain JS, no dependencies: the
// session spawns it with the console's node.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

/** one message as the server gets it: null = dropped */
export function filterMessage(m) {
  if (!isObj(m)) return m
  if (m.method === 'notifications/roots/list_changed') return null
  if (m.method === 'initialize' && isObj(m.params) && isObj(m.params.capabilities) && 'roots' in m.params.capabilities) {
    const { roots: _r, ...capabilities } = m.params.capabilities
    return { ...m, params: { ...m.params, capabilities } }
  }
  return m
}

/** one line of stdin as the server gets it: null = dropped; a line that is not JSON goes as it was */
export function filterLine(line) {
  let m
  try { m = JSON.parse(line) } catch { return line }
  if (Array.isArray(m)) {
    const kept = m.map(filterMessage).filter((x) => x !== null)
    return kept.length ? JSON.stringify(kept) : null
  }
  const out = filterMessage(m)
  return out === null ? null : out === m ? line : JSON.stringify(out)
}

function main() {
  const [command, ...args] = process.argv.slice(2)
  if (!command) { process.stderr.write('noroots: no server command given\n'); process.exit(2) }
  const child = spawn(command, args, { stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true })
  child.on('error', (e) => { process.stderr.write(`noroots: ${command} did not start: ${e.message}\n`); process.exit(127) })
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
  child.stdin.on('error', () => { /* the server went; its exit ends this one */ })
  createInterface({ input: process.stdin, crlfDelay: Infinity })
    .on('line', (l) => { const out = filterLine(l); if (out !== null) child.stdin.write(`${out}\n`) })
    .on('close', () => child.stdin.end())
  const stop = () => { if (child.exitCode === null) child.kill() }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  process.on('exit', stop)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
