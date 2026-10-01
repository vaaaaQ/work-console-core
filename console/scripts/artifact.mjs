// Turns the Vite single-file build into a standalone demo fragment for a host page that wraps it:
// no doctype/html/head/body (the host wraps the page), <title> first, React from
// cdnjs before the app script, and the app as a classic script at the end.
import { readFileSync, writeFileSync } from 'node:fs'

const src = readFileSync('dist/index.html', 'utf8')
const one = (re, what) => {
  const m = src.match(re)
  if (!m) throw new Error(`artifact: no ${what} in dist/index.html`)
  return m
}

const title = one(/<title>[\s\S]*?<\/title>/, '<title>')[0]
const links = src.match(/<link [^>]*>/g) ?? []
const styles = [...src.matchAll(/<style(?![^>]*data-preview)[^>]*>([\s\S]*?)<\/style>/g)]
  .map((m) => `<style>${m[1].replace(/\/\*\$vite\$:\d+\*\/\s*$/, '')}</style>`)
const cdn = src.match(/<script src="[^"]+"><\/script>/g) ?? []
const app = one(/<script type="module" crossorigin>([\s\S]*?)<\/script>/, 'app script')[1]
const body = one(/<body>([\s\S]*)<\/body>/, '<body>')[1].replace(/<script[\s\S]*?<\/script>\s*/g, '').trim()

const allowed = ['https://cdnjs.cloudflare.com/', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com']
for (const tag of [...links, ...cdn]) {
  const url = tag.match(/(?:href|src)="([^"]+)"/)?.[1] ?? ''
  if (!allowed.some((a) => url.startsWith(a))) throw new Error(`artifact: ${url} is outside the CDN allowlist`)
}
if (styles.length !== 1) throw new Error(`artifact: expected one app <style>, found ${styles.length}`)

const out = [title, ...links, ...styles, body, ...cdn, `<script>${app}</script>`].join('\n') + '\n'
writeFileSync('dist/artifact.html', out)
console.log(`dist/artifact.html  ${(out.length / 1024).toFixed(1)} kB`)
