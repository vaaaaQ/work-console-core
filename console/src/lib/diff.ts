export type DiffLine = { k: '=' | '+' | '-'; t: string }

/** a line diff by longest common subsequence; past ~4M cells it shows the text replaced whole */
export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a ? a.split('\n') : [], y = b ? b.split('\n') : [], n = x.length, m = y.length
  if (n * m > 4_000_000) return [...x.map((t) => ({ k: '-' as const, t })), ...y.map((t) => ({ k: '+' as const, t }))]
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
  const out: DiffLine[] = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push({ k: '=', t: x[i] }); i++; j++ }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push({ k: '-', t: x[i++] })
    else out.push({ k: '+', t: y[j++] })
  }
  while (i < n) out.push({ k: '-', t: x[i++] })
  while (j < m) out.push({ k: '+', t: y[j++] })
  return out
}
