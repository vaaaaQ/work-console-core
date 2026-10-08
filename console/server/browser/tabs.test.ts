import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { cdpCarrier } from './cdp.ts'
import type { TabCarrier } from './cdp.ts'
import { startFakeCdp } from './fake-cdp.ts'
import type { FakeCdp } from './fake-cdp.ts'
import { TabPool } from './tabs.ts'

let cdp: FakeCdp
before(async () => { cdp = await startFakeCdp() })
after(async () => { await cdp.close() })

const clear = () => { for (const t of [...cdp.tabs]) cdp.closeTab(t.id) }
/** a carrier counting its list and open calls */
const counted = (c: TabCarrier) => {
  const n = { list: 0, open: 0 }
  return { n, c: { ...c, list: () => { n.list++; return c.list() }, open: (u: string) => { n.open++; return c.open(u) } } as TabCarrier }
}
const pool = (allowed = (h: string) => h.endsWith('.example')) => {
  const k = counted(cdpCarrier(() => cdp.url))
  const p = new TabPool(k.c, allowed)
  p.add('mail/app', { match: /^https:\/\/mail\.example\//, open: 'https://mail.example/inbox' })
  return { p, n: k.n }
}

test('an open tab that matches on an allowed host is reused and nothing is opened', async () => {
  clear()
  cdp.addTab('https://other.example/'); const t = cdp.addTab('https://mail.example/inbox/3')
  const { p, n } = pool()
  assert.equal(await p.resolve('mail/app'), t.id)
  assert.equal(n.open, 0)
})

test('a matching tab on a host that is not allowed is skipped, and the pack url is opened', async () => {
  clear()
  const t = cdp.addTab('https://mail.example/')
  const { p, n } = pool((h) => h !== 'mail.example')
  // the open url's host is refused too, so the pool opens nothing
  await assert.rejects(p.resolve('mail/app'), /mail\.example is not granted/)
  assert.equal(n.open, 0)
  const q = new TabPool(cdpCarrier(() => cdp.url), (h) => h === 'mail.example')
  q.add('mail/app', { match: /^https:\/\/(mail|evil)\.example\//, open: 'https://mail.example/inbox' })
  cdp.closeTab(t.id); const evil = cdp.addTab('https://evil.example/')
  const id = await q.resolve('mail/app')
  assert.notEqual(id, evil.id)
  assert.equal(cdp.tabs.find((x) => x.id === id)?.url, 'https://mail.example/inbox')
})

test('two resolves at once open one tab', async () => {
  clear()
  const { p, n } = pool()
  const [a, b] = await Promise.all([p.resolve('mail/app'), p.resolve('mail/app')])
  assert.equal(a, b)
  assert.equal(n.open, 1)
  assert.equal(cdp.tabs.length, 1)
})

test('a resolved tab is cached; forget makes the next resolve look again', async () => {
  clear()
  cdp.addTab('https://mail.example/')
  const { p, n } = pool()
  await p.resolve('mail/app'); await p.resolve('mail/app')
  assert.equal(n.list, 1)
  p.forget('mail/app'); await p.resolve('mail/app')
  assert.equal(n.list, 2)
})

test('onApp: true on the app, false once it moved to a sign-in page, true when the tab is gone, false with no CDP', async () => {
  clear()
  const t = cdp.addTab('https://mail.example/')
  const { p } = pool()
  assert.equal(await p.onApp('mail/app'), true)
  cdp.navigate(t.id, 'https://login.example/authorize')
  assert.equal(await p.onApp('mail/app'), false)
  cdp.closeTab(t.id)
  assert.equal(await p.onApp('mail/app'), true, 'gone counts as on the app: the reload finds that out')
  const down = new TabPool(cdpCarrier(() => null), () => true)
  down.add('mail/app', { match: /x/, open: 'https://mail.example/' })
  assert.equal(await down.onApp('mail/app'), false)
})

test('front opens the tab when needed and activates it', async () => {
  clear()
  const { p, n } = pool()
  await p.front('mail/app')
  assert.equal(n.open, 1)
  assert.deepEqual(cdp.activated.slice(-1), [cdp.tabs[0].id])
})

test('host is the open url hostname; keys lists the tabs; an unknown key throws', async () => {
  const { p } = pool()
  assert.equal(p.host('mail/app'), 'mail.example')
  assert.deepEqual(p.keys(), ['mail/app'])
  await assert.rejects(p.resolve('mail/none'), /no tab mail\/none/)
  assert.throws(() => p.host('mail/none'), /no tab mail\/none/)
})
