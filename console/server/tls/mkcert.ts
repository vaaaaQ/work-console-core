import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname, networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import forge from 'node-forge'

/* The LAN listener's certificate. A local CA is made once and kept, because every paired phone
   trusts it; the server certificate is reissued on every run, so a new LAN address only needs a
   re-run. iOS refuses server certificates valid for more than 825 days. The CA is name-constrained
   to this PC's name and private addresses, so its key could not vouch for any other site. */

const DAY = 86400e3
const pki = forge.pki

function keys() {
  const k = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs1', format: 'pem' } })
  return { privateKey: pki.privateKeyFromPem(k.privateKey), publicKey: pki.publicKeyFromPem(k.publicKey) }
}

function cert(pub: forge.pki.PublicKey, days: number) {
  const c = pki.createCertificate()
  c.publicKey = pub
  c.serialNumber = '01' + randomBytes(15).toString('hex')
  c.validity.notBefore = new Date(Date.now() - DAY)
  c.validity.notAfter = new Date(Date.now() + days * DAY)
  return c
}

/** the address ranges the CA may vouch for: loopback, link-local and the private ranges */
const PRIVATE: [string, number][] = [['127.0.0.0', 8], ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['169.254.0.0', 16]]
const ipNum = (ip: string) => ip.split('.').reduce((n, b) => n * 256 + Number(b), 0)
const isPrivate = (ip: string) => PRIVATE.some(([net, bits]) => Math.floor(ipNum(ip) / 2 ** (32 - bits)) === Math.floor(ipNum(net) / 2 ** (32 - bits)))

/** RFC 5280 nameConstraints with permitted subtrees only; forge has no encoder for it */
function nameConstraints(host: string) {
  const a = forge.asn1, ctx = a.Class.CONTEXT_SPECIFIC
  const sub = (tag: number, bytes: string) => a.create(a.Class.UNIVERSAL, a.Type.SEQUENCE, true, [a.create(ctx, tag, false, bytes)])
  const net = ([ip, bits]: [string, number]) => {
    const mask = bits ? (2 ** 32 - 2 ** (32 - bits)) : 0
    const b4 = (n: number) => String.fromCharCode(n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255)
    return sub(7, b4(ipNum(ip)) + b4(mask))
  }
  const permitted = [...new Set([host, `${host}.local`, 'localhost'])].map((d) => sub(2, d)).concat(PRIVATE.map(net))
  return { id: '2.5.29.30', critical: true, value: a.create(a.Class.UNIVERSAL, a.Type.SEQUENCE, true, [a.create(ctx, 0, true, permitted)]) }
}

/** the IPv4 addresses a phone on the home network can reach this PC by */
export function lanIps(): string[] {
  return Object.values(networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a!.address)
}

export function ensureCerts(dir: string, o: { host?: string; ips?: string[] } = {}) {
  // an address outside the CA's constraints would fail the whole chain, so it is left out
  const host = (o.host || hostname()).toLowerCase(), ips = (o.ips ?? lanIps()).filter(isPrivate)
  mkdirSync(dir, { recursive: true })
  const caKeyF = join(dir, 'ca.key'), caCrtF = join(dir, 'ca.crt')
  let caKey: forge.pki.rsa.PrivateKey, caCrt: forge.pki.Certificate
  if (existsSync(caKeyF) && existsSync(caCrtF)) {
    caKey = pki.privateKeyFromPem(readFileSync(caKeyF, 'utf8')) as forge.pki.rsa.PrivateKey
    caCrt = pki.certificateFromPem(readFileSync(caCrtF, 'utf8'))
  } else {
    const k = keys()
    caCrt = cert(k.publicKey, 3650)
    const name = [{ name: 'commonName', value: `Work Console CA (${host})` }]
    caCrt.setSubject(name); caCrt.setIssuer(name)
    caCrt.setExtensions([
      { name: 'basicConstraints', cA: true, critical: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
      { name: 'subjectKeyIdentifier' },
      nameConstraints(host),
    ])
    caCrt.sign(k.privateKey, forge.md.sha256.create())
    caKey = k.privateKey as forge.pki.rsa.PrivateKey
    writeFileSync(caKeyF, pki.privateKeyToPem(caKey)); writeFileSync(caCrtF, pki.certificateToPem(caCrt))
  }

  const k = keys(), c = cert(k.publicKey, 800)
  c.setSubject([{ name: 'commonName', value: host }]); c.setIssuer(caCrt.subject.attributes)
  c.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [{ type: 2, value: host }, { type: 2, value: 'localhost' }, ...['127.0.0.1', ...ips].map((ip) => ({ type: 7, ip }))] },
  ])
  c.sign(caKey, forge.md.sha256.create())
  writeFileSync(join(dir, 'server.key'), pki.privateKeyToPem(k.privateKey)); writeFileSync(join(dir, 'server.crt'), pki.certificateToPem(c))
  return { ca: caCrtF, host, ips }
}

// install.ps1 runs this with the console's home directory
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = ensureCerts(join(process.argv[2] || '.', 'tls'))
  console.log(`certificate for ${r.host}, localhost, 127.0.0.1${r.ips.length ? ', ' + r.ips.join(', ') : ''}; the phone installs ${r.ca}`)
}
