/* Where dictated words go in a field: at the cursor at once, then the tidied text over them. */

/** t put in v at the cursor (null: the end), spaced from its neighbours; a..b is where t landed */
export function insertAt(v: string, at: number | null, t: string) {
  const i = at == null ? v.length : Math.max(0, Math.min(at, v.length))
  const pre = v.slice(0, i), post = v.slice(i)
  const l = pre && !/\s$/.test(pre) ? ' ' : '', r = post && !/^\s/.test(post) ? ' ' : ''
  return { v: pre + l + t + r + post, a: i + l.length, b: i + l.length + t.length }
}

/** v with the raw text at a..b, or where it moved, replaced by t; null once the raw text was edited */
export function swap(v: string, a: number, b: number, raw: string, t: string) {
  if (v.slice(a, b) === raw) return v.slice(0, a) + t + v.slice(b)
  const i = v.indexOf(raw)
  return i < 0 ? null : v.slice(0, i) + t + v.slice(i + raw.length)
}
