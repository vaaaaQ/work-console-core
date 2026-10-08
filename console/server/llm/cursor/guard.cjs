'use strict'
// The session's preToolUse hook: sends the tool call's name and paths to the console's guard and prints its verdict.
// Anything that goes wrong denies. Args: the guard's loopback port and token; the CLI reads a "//" in hooks.json as a comment.
const [port, token] = process.argv.slice(2), url = `http://127.0.0.1:${port}/guard`
const KEYS = ['file_path', 'path', 'command', 'url', 'cwd', 'glob', 'server', 'uri', 'download_path']
const say = (v) => { process.stdout.write(JSON.stringify(v)); process.exit(0) }
const deny = (why) => say({ permission: 'deny', user_message: why, agent_message: why })

let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => { raw += c })
process.stdin.on('end', async () => {
  try {
    const x = JSON.parse(raw.replace(/^﻿/, ''))
    const ti = x.tool_input && typeof x.tool_input === 'object' ? x.tool_input : {}
    const tool_input = Object.fromEntries(KEYS.filter((k) => typeof ti[k] === 'string').map((k) => [k, ti[k]]))
    const r = await fetch(url, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tool_name: x.tool_name, tool_input }), signal: AbortSignal.timeout(20000),
    })
    if (!r.ok) deny(`the console's guard answered ${r.status}`)
    say(await r.json())
  } catch (e) { deny(`the console's guard could not decide: ${e && e.message}`) }
})
