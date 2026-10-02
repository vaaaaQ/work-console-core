/** RFC 4180 rows; the separator is whichever of , ; or tab the first line holds most of */
export function parseCsv(t: string): string[][] {
  t = t.replace(/^﻿/, '')
  const first = t.slice(0, t.search(/\r?\n|$/)), cnt = (c: string) => first.split(c).length
  const sep = [';', '\t'].find((c) => cnt(c) > cnt(',')) || ','
  const rows: string[][] = []
  let row: string[] = [], f = '', q = false
  for (let i = 0; i < t.length; i++) {
    const c = t[i]
    if (q) {
      if (c !== '"') f += c
      else if (t[i + 1] === '"') { f += '"'; i++ } else q = false
    } else if (c === '"' && f === '') q = true
    else if (c === sep) { row.push(f); f = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++
      row.push(f); rows.push(row); row = []; f = ''
    } else f += c
  }
  if (f || row.length) { row.push(f); rows.push(row) }
  return rows
}
