/* Work Console service worker: shows pushes and opens the console where a push points. No caching. */
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('push', (e) => {
  let m = { title: 'Work Console', body: '', url: '/' }
  try { m = { ...m, ...e.data.json() } } catch { if (e.data) m.body = e.data.text() }
  e.waitUntil(self.registration.showNotification(m.title, { body: m.body, data: { url: m.url }, icon: '/icon.svg', tag: m.url }))
})

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href
  e.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const w = open.find((c) => new URL(c.url).origin === self.location.origin)
    if (w) { await w.focus(); return w.navigate(url) }
    return self.clients.openWindow(url)
  })())
})
