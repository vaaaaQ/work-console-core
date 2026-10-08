// A stand-in for Edge, for tests: takes --user-data-dir and --remote-debugging-port=0, serves /json/version on a free
// port, writes <dir>/DevToolsActivePort and closes on CDP Browser.close. FAKE_EDGE_MODE, comma-separated: noport (never
// writes the port file), die (exits after 400 ms), relaunch (restarts itself under a new pid, as Edge does), noclose.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'

const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3)
const dir = arg('user-data-dir'), modes = new Set((process.env.FAKE_EDGE_MODE || '').split(',').filter(Boolean))
appendFileSync(join(dir, 'fake-edge-runs.jsonl'), JSON.stringify({ pid: process.pid, args: process.argv.slice(2), env: Object.keys(process.env) }) + '\n')
if (modes.has('relaunch') && !process.argv.includes('--relaunched')) {
  spawn(process.execPath, [...process.argv.slice(1), '--relaunched'], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  process.exit(0)
}
let port = 0
const server = createServer((req, res) => {
  const json = (b) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)) }
  if (req.url === '/json/version') return json({ Browser: 'FakeEdge/1.0', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake` })
  if (req.url === '/json/list') return json([])
  res.writeHead(404); res.end()
})
server.on('upgrade', (req, socket) => {
  const accept = createHash('sha1').update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
  socket.on('data', (d) => {
    // the launcher sends one short masked text frame
    if ((d[0] & 15) !== 1) return
    const len = d[1] & 127, mask = d.subarray(2, 6), p = Buffer.from(d.subarray(6, 6 + len))
    for (let i = 0; i < p.length; i++) p[i] ^= mask[i & 3]
    const m = JSON.parse(p.toString('utf8'))
    if (m.method !== 'Browser.close' || modes.has('noclose')) return
    appendFileSync(join(dir, 'fake-edge-closes.jsonl'), JSON.stringify({ pid: process.pid }) + '\n')
    const body = Buffer.from(JSON.stringify({ id: m.id, result: {} }))
    socket.write(Buffer.concat([Buffer.from([0x81, body.length]), body]), () => process.exit(0))
  })
  socket.on('error', () => {})
})
server.listen(0, '127.0.0.1', () => {
  port = server.address().port
  if (!modes.has('noport')) writeFileSync(join(dir, 'DevToolsActivePort'), `${port}\n/devtools/browser/fake\n`)
  if (modes.has('die')) setTimeout(() => process.exit(0), 400)
})
