import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/* A png of a page, taken by the browser already installed on the PC (Edge or Chrome), so the console
   downloads none. A run proves a UI change with it; the runner keeps the png as the step's artifact. */

export type Shot = { url: string; width?: number; height?: number; fullPage?: boolean }

/** the standard install paths, first found wins */
function standard(env: NodeJS.ProcessEnv = process.env): string[] {
  if (process.platform === 'win32') {
    const pf = env.ProgramFiles ?? 'C:\\Program Files', pf86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    return [join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'), join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ...(env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')] : [])]
  }
  if (process.platform === 'darwin') return ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  return ['/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
}

/** the configured browser, else an installed Edge or Chrome; null = none */
export function findBrowser(path?: string | null): string | null {
  return path || standard().find((p) => existsSync(p)) || null
}

/** http, https and file only: never javascript:, data: or a browser-internal page */
export function checkUrl(u: string): URL {
  let x: URL
  try { x = new URL(u) } catch { throw new Error(`not a url: ${u}`) }
  if (!['http:', 'https:', 'file:'].includes(x.protocol)) throw new Error(`only http, https and file urls, not ${x.protocol}`)
  return x
}

/** p is root or below it, links resolved */
async function under(root: string, p: string) {
  try {
    const rel = relative(await realpath(root), await realpath(p))
    return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
  } catch { return false }
}

const side = (n: number | undefined, d: number) => Math.min(4000, Math.max(200, Math.round(n ?? d)))

/** a page that renders after load, as a single-page app does, is blank at load: wait until the DOM has been
    quiet for quietMs, counted from load if the body already shows something, else from the first change; at most capMs */
function settle([quietMs, capMs]: [number, number]) {
  return new Promise<void>((done) => {
    let t: ReturnType<typeof setTimeout> | undefined
    const o = new MutationObserver(() => { clearTimeout(t); t = setTimeout(end, quietMs) })
    const cap = setTimeout(end, capMs)
    function end() { o.disconnect(); clearTimeout(t); clearTimeout(cap); done() }
    o.observe(document, { subtree: true, childList: true, characterData: true, attributes: true })
    if (document.body?.innerText.trim() || document.images.length) t = setTimeout(end, quietMs)
  })
}

/** fileRoot: the only dir the page, its frames and its images may read files from; none = no files at all.
    blocked = the file urls the page asked for and did not get */
export async function shoot(o: Shot & { out: string; browserPath?: string | null; timeoutMs?: number; fileRoot?: string }): Promise<{ blocked: string[] }> {
  const url = checkUrl(o.url), exe = findBrowser(o.browserPath)
  if (!exe) throw new Error('no browser found: set browserPath in config.json')
  // loaded on first use, so a console that never shoots never loads it
  const { chromium } = await import('playwright-core')
  const b = await chromium.launch({ executablePath: exe, headless: true, timeout: 30000 })
  try {
    const p = await b.newPage({ viewport: { width: side(o.width, 1280), height: side(o.height, 800) } })
    // a page under the work dir could frame any file on the PC, the console's tokens among them
    const blocked: string[] = []
    await p.route('**/*', async (r) => {
      const u = r.request().url()
      if (!u.startsWith('file:') || (o.fileRoot && await under(o.fileRoot, fileURLToPath(u)))) return r.continue()
      blocked.push(u)
      return r.abort('accessdenied')
    })
    await p.goto(url.href, { waitUntil: 'load', timeout: o.timeoutMs ?? 30000 })
    await p.evaluate(settle, [500, 10000] as [number, number])
    await p.screenshot({ path: o.out, fullPage: o.fullPage ?? false, type: 'png' })
    return { blocked }
  } finally { await b.close() }
}
