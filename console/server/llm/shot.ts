import { existsSync } from 'node:fs'
import { join } from 'node:path'

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

const side = (n: number | undefined, d: number) => Math.min(4000, Math.max(200, Math.round(n ?? d)))

export async function shoot(o: Shot & { out: string; browserPath?: string | null; timeoutMs?: number }): Promise<void> {
  const url = checkUrl(o.url), exe = findBrowser(o.browserPath)
  if (!exe) throw new Error('no browser found: set browserPath in config.json')
  // loaded on first use, so a console that never shoots never loads it
  const { chromium } = await import('playwright-core')
  const b = await chromium.launch({ executablePath: exe, headless: true, timeout: 30000 })
  try {
    const p = await b.newPage({ viewport: { width: side(o.width, 1280), height: side(o.height, 800) } })
    await p.goto(url.href, { waitUntil: 'load', timeout: o.timeoutMs ?? 30000 })
    await p.screenshot({ path: o.out, fullPage: o.fullPage ?? false, type: 'png' })
  } finally { await b.close() }
}
