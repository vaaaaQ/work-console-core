// A stand-in for Edge, for tests: takes --user-data-dir and --remote-debugging-port=0, serves /json/version on a free
// port and writes <dir>/DevToolsActivePort. FAKE_EDGE_MODE: noport (never writes it), die (exits after 400 ms).
import { appendFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'

const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3)
const dir = arg('user-data-dir'), mode = process.env.FAKE_EDGE_MODE || ''
appendFileSync(join(dir, 'fake-edge-runs.jsonl'), JSON.stringify({ pid: process.pid, args: process.argv.slice(2), env: Object.keys(process.env) }) + '\n')
const server = createServer((req, res) => {
  if (req.url === '/json/version') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ Browser: 'FakeEdge/1.0' })) }
  if (req.url === '/json/list') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('[]') }
  res.writeHead(404); res.end()
})
server.listen(0, '127.0.0.1', () => {
  if (mode !== 'noport') writeFileSync(join(dir, 'DevToolsActivePort'), `${server.address().port}\n/devtools/browser/fake\n`)
  if (mode === 'die') setTimeout(() => process.exit(0), 400)
})
