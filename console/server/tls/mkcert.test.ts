import { test } from 'node:test'
import assert from 'node:assert/strict'
import { X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { connect, createServer } from 'node:tls'
import forge from 'node-forge'
import { ensureCerts } from './mkcert.ts'
import { tempDir } from '../testdirs.ts'

test('the server certificate chains to a kept local CA and names every address', () => {
  const dir = join(tempDir('tls'), 'tls')
  ensureCerts(dir, { host: 'My-PC', ips: ['192.168.1.20'] })
  const ca = new X509Certificate(readFileSync(join(dir, 'ca.crt')))
  const crt = new X509Certificate(readFileSync(join(dir, 'server.crt')))
  assert.equal(ca.ca, true)
  assert.equal(crt.ca, false)
  assert.ok(crt.checkIssued(ca) && crt.verify(ca.publicKey))
  for (const n of ['DNS:my-pc', 'DNS:localhost', 'IP Address:127.0.0.1', 'IP Address:192.168.1.20']) assert.match(crt.subjectAltName!, new RegExp(n.replace(/\./g, '\\.')))
  assert.ok(crt.keyUsage?.includes('1.3.6.1.5.5.7.3.1'), 'serverAuth')
  assert.ok(Date.parse(crt.validTo) - Date.now() < 825 * 86400e3, 'iOS limit')

  ensureCerts(dir, { host: 'my-pc', ips: ['192.168.1.21'] })
  const ca2 = new X509Certificate(readFileSync(join(dir, 'ca.crt')))
  const crt2 = new X509Certificate(readFileSync(join(dir, 'server.crt')))
  assert.equal(ca2.fingerprint256, ca.fingerprint256, 'paired phones keep trusting it')
  assert.notEqual(crt2.serialNumber, crt.serialNumber)
  assert.match(crt2.subjectAltName!, /192\.168\.1\.21/)
  assert.ok(crt2.verify(ca.publicKey))
})

/** a TLS handshake against the CA the phone trusts: null when it verifies, else the error */
async function handshake(key: string, crt: string, ca: string, servername: string) {
  const s = createServer({ key, cert: crt }, (c) => c.end())
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  try {
    return await new Promise<Error | null>((r) => {
      const c = connect({ host: '127.0.0.1', port: (s.address() as AddressInfo).port, ca, servername }, () => { c.end(); r(null) })
      c.on('error', r)
    })
  } finally { s.close() }
}

test('the CA can only vouch for this PC: a certificate it signs for another name or a public address fails', async () => {
  const dir = join(tempDir('tls'), 'tls')
  ensureCerts(dir, { host: 'my-pc', ips: ['192.168.1.20', '8.8.8.8'] })
  const rd = (f: string) => readFileSync(join(dir, f), 'utf8'), ca = rd('ca.crt')
  assert.equal(await handshake(rd('server.key'), rd('server.crt'), ca, 'my-pc'), null)
  assert.doesNotMatch(new X509Certificate(rd('server.crt')).subjectAltName!, /8\.8\.8\.8/, 'a public address is left out, not left to break the chain')

  const pki = forge.pki, caKey = pki.privateKeyFromPem(rd('ca.key')), caCrt = pki.certificateFromPem(ca)
  const leaf = (alt: { type: number; value?: string; ip?: string }[]) => {
    const k = pki.rsa.generateKeyPair(1024), c = pki.createCertificate()
    c.publicKey = k.publicKey; c.serialNumber = '0a'
    c.validity.notBefore = new Date(Date.now() - 86400e3); c.validity.notAfter = new Date(Date.now() + 86400e3)
    c.setSubject([{ name: 'commonName', value: 'x' }]); c.setIssuer(caCrt.subject.attributes)
    c.setExtensions([{ name: 'extKeyUsage', serverAuth: true }, { name: 'subjectAltName', altNames: alt }])
    c.sign(caKey, forge.md.sha256.create())
    return [pki.privateKeyToPem(k.privateKey), pki.certificateToPem(c)] as const
  }
  const [k1, c1] = leaf([{ type: 2, value: 'bank.example' }])
  assert.match(String(await handshake(k1, c1, ca, 'bank.example')), /subtree/i)
  const [k2, c2] = leaf([{ type: 7, ip: '8.8.8.8' }])
  assert.match(String(await handshake(k2, c2, ca, 'x')), /subtree/i)
})
