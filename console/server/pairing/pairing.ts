import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import QRCode from 'qrcode'

/* A phone pairs by opening a one-time code the PC shows as a QR; it gets a device token as a cookie.
   Codes live in memory for 5 minutes. Tokens are stored only as SHA-256 hashes. */

const CODE_TTL = 5 * 60e3
type Device = { id: string; name: string; hash: string; at: string; lastSeen?: string }
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

export class Pairing {
  private file: string; private now: () => number
  private codes = new Map<string, number>()
  private list: Device[]
  private flushAt = 0

  constructor(dir: string, now: () => number = Date.now) {
    mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'devices.json'); this.now = now
    this.list = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : []
  }

  private save() {
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.list, null, 1)); renameSync(tmp, this.file)
    this.flushAt = this.now()
  }

  newCode() {
    const t = this.now()
    for (const [c, exp] of this.codes) if (exp < t) this.codes.delete(c)
    const code = randomBytes(32).toString('base64url'), expires = t + CODE_TTL
    this.codes.set(code, expires)
    return { code, expires }
  }

  /** one use: a code is gone after the first attempt, right or late */
  redeem(code: string, name: string): { token: string; id: string } | null {
    const exp = typeof code === 'string' ? this.codes.get(code) : undefined
    if (exp === undefined) return null
    this.codes.delete(code)
    if (this.now() > exp) return null
    const token = randomBytes(32).toString('base64url'), id = randomBytes(6).toString('hex')
    this.list.push({ id, name: String(name || 'device').slice(0, 80), hash: sha(token), at: new Date(this.now()).toISOString() })
    this.save()
    return { token, id }
  }

  check(token: string | undefined): { id: string } | null {
    if (!token) return null
    const h = sha(token), d = this.list.find((x) => same(x.hash, h))
    if (!d) return null
    d.lastSeen = new Date(this.now()).toISOString()
    if (this.now() - this.flushAt > 60e3) this.save()
    return { id: d.id }
  }

  devices() { return this.list.map(({ id, name, at, lastSeen }) => ({ id, name, at, lastSeen })) }

  revoke(id: string) {
    const n = this.list.length
    this.list = this.list.filter((d) => d.id !== id)
    if (this.list.length === n) return false
    this.save()
    return true
  }
}

export function qrSvg(url: string): Promise<string> {
  return QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
}
