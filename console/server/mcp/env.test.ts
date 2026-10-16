import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { envRefs, literalSecrets, mcpEnvPath, mcpVars, parseEnvFile, resolveEnv, scrubSecrets } from './env.ts'
import { tempDir } from '../testdirs.ts'

test('mcp.env: NAME=value lines, comments and blanks skipped, quotes dropped', () => {
  assert.deepEqual(parseEnvFile('# keys\nA=1\n\nexport B = "two words"\r\nC=\'x=y\'\nnot a line\n'), { A: '1', B: 'two words', C: 'x=y' })
})

test("a server's values: the console's environment, then mcp.env over it, read anew each time", () => {
  const home = tempDir('mcpenv')
  assert.deepEqual(mcpVars(home, { A: 'env', B: 'env' }), { A: 'env', B: 'env' })
  writeFileSync(mcpEnvPath(home), 'B=file\nC=file\n')
  assert.deepEqual(mcpVars(home, { A: 'env', B: 'env' }), { A: 'env', B: 'file', C: 'file' })
  writeFileSync(mcpEnvPath(home), 'C=again\n')
  assert.equal(mcpVars(home, {}).C, 'again')
})

test('${env:NAME} is put in at the start in args, url, env and headers; the values come back for scrub', () => {
  const c = { command: 'npx', args: ['--key=${env:SSH_KEY}'], env: { T: '${env:API_TOKEN}' }, headers: { Authorization: 'Bearer ${env:API_TOKEN}' }, url: 'https://h.example/${env:PATHPART}' }
  assert.deepEqual(envRefs(c), ['SSH_KEY', 'API_TOKEN', 'PATHPART'])
  const r = resolveEnv(c, { SSH_KEY: 'C:/k/id', API_TOKEN: 's3cr3t', PATHPART: 'mcp' })
  assert.deepEqual(r.config, { command: 'npx', args: ['--key=C:/k/id'], env: { T: 's3cr3t' }, headers: { Authorization: 'Bearer s3cr3t' }, url: 'https://h.example/mcp' })
  assert.deepEqual(r.secrets.sort(), ['C:/k/id', 's3cr3t'])
  // the config it was given still names the variable: that is what grants.json keeps
  assert.equal(c.env.T, '${env:API_TOKEN}')
})

test('a missing or empty variable stops the start, naming it and no value', () => {
  assert.throws(() => resolveEnv({ env: { A: '${env:GONE}', B: '${env:EMPTY}' } }, { EMPTY: '' }), /^Error: no variable GONE, EMPTY \(set it in the console's environment or in mcp\.env\)$/)
})

test('a literal secret in env or headers is a problem; ${env:} or a harmless name is not', () => {
  assert.deepEqual(literalSecrets({ env: { GITHUB_TOKEN: 'ghp_x', LOG: 'debug', SSH_PASSWORD: '${env:SSH_PASSWORD}' } }), [
    'mcp.env.GITHUB_TOKEN: looks like a secret; write ${env:GITHUB_TOKEN} and put the value in mcp.env',
  ])
  assert.deepEqual(literalSecrets({ headers: { authorization: 'Basic eDp5' } }, 'mcp.box'), ['mcp.box.headers.authorization: looks like a secret; write ${env:NAME} and put the value in mcp.env'])
  assert.deepEqual(literalSecrets({ command: 'x' }), [])
})

test('scrub masks every value, the longest first', () => {
  assert.equal(scrubSecrets('key s3cr3t-long and s3cr3t', ['s3cr3t', 's3cr3t-long']), 'key *** and ***')
})
