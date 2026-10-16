// Tests' stand-in for a stdio MCP server. Arg: ok (answers initialize and tools/list over two pages), exit (dies at once
// after writing to stderr), hang (reads and never answers), secret (prints its SECRET env to stderr, then exits).
import { createInterface } from 'node:readline'

const mode = process.argv[2] ?? 'ok'
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`)
if (mode === 'exit') { process.stderr.write('cannot read the config file\n'); process.exit(3) }
if (mode === 'secret') { process.stderr.write(`auth failed with ${process.env.SECRET}\n`); process.exit(1) }
const PAGES = [
  [{ name: 'list', description: 'lists', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
   { name: 'run', description: 'runs a command', inputSchema: { type: 'object' }, annotations: { destructiveHint: true } }],
  [{ name: 'upload', inputSchema: { type: 'object' } }],
]
createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l)
  if (mode === 'hang' || m.id === undefined) return
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0.0' } } })
  else if (m.method === 'tools/list') {
    const page = m.params?.cursor === 'p2' ? 1 : 0
    send({ jsonrpc: '2.0', id: m.id, result: { tools: PAGES[page], ...(page === 0 ? { nextCursor: 'p2' } : {}) } })
  } else send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no method' } })
})
