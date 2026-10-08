import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { parseSync } from 'rolldown/utils'

/* A best-effort static check of what an agent wrote: no process, socket, server or VM modules, no require or import of a
   computed name, and no global fetch (or WebSocket, XMLHttpRequest, EventSource): a plugin reaches the network through
   ctx.http, which keeps to the granted hosts. Code can still get around a static check; this catches the plain ways.
   It parses with vite's own parser (rolldown's oxc), since TypeScript 7 has no compiler API in JavaScript. */

export const BANNED = ['child_process', 'net', 'http', 'https', 'http2', 'dgram', 'tls', 'worker_threads', 'cluster', 'vm', 'module']
const GLOBALS = new Set(['fetch', 'WebSocket', 'XMLHttpRequest', 'EventSource'])
const ROOTS = new Set(['globalThis', 'window', 'self', 'global'])
const EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
/** keys whose subtree is a type, a label or a name, never a value reference */
const TYPE_KEYS = new Set(['typeAnnotation', 'returnType', 'typeParameters', 'typeArguments', 'superTypeArguments', 'label'])
const TYPE_DECLS = new Set(['TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'TSModuleDeclaration', 'TSDeclareFunction', 'TSEnumDeclaration'])

type N = { type: string; start: number; [k: string]: unknown }
const isNode = (x: unknown): x is N => !!x && typeof x === 'object' && typeof (x as N).type === 'string'
const str = (n: unknown) => (isNode(n) && n.type === 'Literal' && typeof n.value === 'string' ? n.value as string : null)

export const bannedModule = (spec: string) => {
  const m = /^(?:node:)?([^/]+)/.exec(spec)
  return !!m && BANNED.includes(m[1])
}

/** what one file does that the check refuses, as `line: why` */
export function importIssues(file: string, text: string): string[] {
  const lang = /\.tsx$/.test(file) ? 'tsx' : /\.[mc]?ts$/.test(file) ? 'ts' : /\.jsx$/.test(file) ? 'jsx' : 'js'
  const r = parseSync(file, text, { lang, sourceType: 'module' })
  if (r.errors.length) return [`1: does not parse: ${r.errors[0].message}`]
  const out: { at: number; why: string }[] = [], locals = new Set<string>(), uses: N[] = []
  const bad = (n: N, why: string) => out.push({ at: n.start, why })
  const spec = (n: N, e: unknown, how: string) => {
    if (!isNode(e)) return
    const s = str(e) ?? (e.type === 'TemplateLiteral' && (e.expressions as unknown[]).length === 0 ? ((e.quasis as { value: { cooked: string } }[])[0].value.cooked) : null)
    if (s === null) bad(n, `${how} of a computed name`)
    else if (bannedModule(s)) bad(n, `${how} ${s}`)
  }
  /** binding = a declared name's position; ref = a value reference's */
  const walk = (n: N, ctx: 'ref' | 'binding' | 'name') => {
    const t = n.type
    if (TYPE_DECLS.has(t)) return
    if (t === 'ImportDeclaration') { if (n.importKind !== 'type') spec(n, n.source, 'imports') }
    else if (t === 'ExportAllDeclaration' || (t === 'ExportNamedDeclaration' && n.source)) { if (n.exportKind !== 'type') spec(n, n.source, 'exports from') }
    else if (t === 'TSImportEqualsDeclaration') {
      const m = n.moduleReference as N
      if (n.importKind !== 'type' && m.type === 'TSExternalModuleReference') spec(n, m.expression, 'imports')
    } else if (t === 'ImportExpression') spec(n, n.source, 'imports')
    else if (t === 'CallExpression' && isNode(n.callee) && n.callee.type === 'Identifier' && n.callee.name === 'require') spec(n, (n.arguments as unknown[])[0], 'requires')
    else if (t === 'MemberExpression' && isNode(n.object) && n.object.type === 'Identifier' && ROOTS.has(n.object.name as string)) {
      const p = n.property as N, name = n.computed ? str(p) : p.name as string
      if (n.computed && name === null) bad(n, `uses ${n.object.name}[${String(p.type)}]`)
      else if (GLOBALS.has(name!)) bad(n, n.computed ? `uses ${n.object.name}['${name}']` : `uses ${name}: use ctx.http`)
    } else if (t === 'Identifier' && GLOBALS.has(n.name as string)) {
      if (ctx === 'binding') locals.add(n.name as string)
      else if (ctx === 'ref') uses.push(n)
    }
    for (const [k, v] of Object.entries(n)) {
      if (TYPE_KEYS.has(k)) continue
      for (const c of Array.isArray(v) ? v : [v]) if (isNode(c)) walk(c, childCtx(n, k, ctx))
    }
  }
  walk(r.program as unknown as N, 'ref')
  for (const u of uses) if (!locals.has(u.name as string)) bad(u, `uses ${u.name}: use ctx.http`)
  const line = (at: number) => text.slice(0, at).split('\n').length
  return out.sort((a, b) => a.at - b.at).map((x) => `${line(x.at)}: ${x.why}`)
}

/** what a child of n under key k is: a declared name, a non-reference name, or a value */
function childCtx(n: N, k: string, ctx: 'ref' | 'binding' | 'name'): 'ref' | 'binding' | 'name' {
  const t = n.type
  if ((t === 'MemberExpression' && k === 'property' && !n.computed)) return 'name'
  if ((t === 'Property' || t === 'MethodDefinition' || t === 'PropertyDefinition' || t === 'TSPropertySignature' || t === 'TSMethodSignature' || t === 'AccessorProperty') && k === 'key' && !n.computed) return 'name'
  if (t === 'Property' && k === 'value' && ctx === 'binding') return 'binding'
  if (t === 'ExportSpecifier' || t === 'ImportAttribute') return 'name'
  if ((t === 'VariableDeclarator' && k === 'id') || (/Function/.test(t) && (k === 'id' || k === 'params')) || (/^Class/.test(t) && k === 'id')
    || (t === 'CatchClause' && k === 'param') || (/^Import(Default|Namespace)?Specifier$/.test(t) && k === 'local') || t === 'TSParameterProperty') return 'binding'
  if (t === 'ImportSpecifier' && k === 'imported') return 'name'
  if (ctx === 'binding' && (t === 'ObjectPattern' || t === 'ArrayPattern' || t === 'RestElement' || (t === 'AssignmentPattern' && k === 'left'))) return 'binding'
  if (t === 'AssignmentPattern' && k === 'right') return 'ref'
  return ctx === 'binding' && (t === 'ObjectPattern' || t === 'ArrayPattern') ? 'binding' : 'ref'
}

function* files(dir: string): Generator<string> {
  if (!existsSync(dir)) return
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* files(p)
    else if (e.isFile() && EXT.test(e.name)) yield p
  }
}

/** every code file under dirs (relative to root), checked; lines `path:line: why` */
export function importCheck(root: string, dirs: string[]): string[] {
  const out: string[] = []
  for (const d of dirs) for (const f of files(join(root, d))) {
    const rel = relative(root, f).split(sep).join('/')
    for (const l of importIssues(f, readFileSync(f, 'utf8'))) out.push(`${rel}:${l}`)
  }
  return out
}
