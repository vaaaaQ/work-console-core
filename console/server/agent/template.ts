import { join } from 'node:path'
import { CONSOLE } from '../config.ts'
import { PREFIX, WS_ID } from '../workspace.ts'

/* The new-workspace template (consumer/workspace-template) and the two registry edits that add a workspace to it. */

export const TEMPLATE = join(CONSOLE, 'consumer', 'workspace-template')

const RESERVED = new Set(('break case catch class const continue debugger default delete do else enum export extends false finally for '
  + 'function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static '
  + 'implements interface package private protected public await').split(' '))

/** the id as a camel-case identifier: my-crm → myCrm; a reserved word gets a ws prefix */
export function varName(id: string): string {
  const v = id.replace(/-+([a-z0-9])/g, (_, c: string) => c.toUpperCase())
  return RESERVED.has(v) ? `ws${v[0].toUpperCase()}${v.slice(1)}` : v
}

export interface NewWorkspace { id: string; prefix: string; title: string }

export const render = (text: string, o: NewWorkspace) =>
  text.replaceAll('__ID__', o.id).replaceAll('__PREFIX__', o.prefix).replaceAll('__TITLE__', o.title).replaceAll('__VAR__', varName(o.id))

/** why a workspace cannot be made so, or null */
export function newWorkspaceIssue(o: NewWorkspace, taken: { ids: string[]; prefixes: string[]; exists(id: string): boolean }): string | null {
  if (!WS_ID.test(o.id)) return `id ${o.id} must match ${WS_ID}`
  if (!PREFIX.test(o.prefix)) return `prefix ${o.prefix} must match ${PREFIX}`
  if (taken.ids.includes(o.id)) return `the id ${o.id} is taken`
  if (taken.prefixes.includes(o.prefix)) return `the prefix ${o.prefix} is taken by another workspace`
  if (taken.exists(o.id)) return `workspaces/${o.id} already exists`
  if (!/^[^\\'"`\r\n]{1,60}$/.test(o.title) || o.title.includes('*/') || !o.title.trim()) return 'the title is 1-60 characters on one line, without quotes or backslashes'
  return null
}

/** the registry with the workspace's import after the last import and its entry last in the array */
export function addRegistry(text: string, kind: 'page' | 'server', id: string): string {
  const v = varName(id), name = kind === 'page' ? v : `${v}Server`, entry = kind === 'page' ? `{ page: ${v} }` : name
  const eol = text.includes('\r\n') ? '\r\n' : '\n', array = kind === 'page' ? 'WORKSPACES' : 'SERVERS'
  if (text.includes(`'./${id}/`) || new RegExp(`\\b${name}\\b`).test(text)) throw new Error(`the registry already registers ${id}`)
  const open = new RegExp(`export const ${array}\\b[^=]*=\\s*\\[`).exec(text)
  if (!open) throw new Error(`the registry has no ${array} array`)
  const start = open.index + open[0].length
  let depth = 1, end = start
  for (; end < text.length && depth; end++) depth += text[end] === '[' ? 1 : text[end] === ']' ? -1 : 0
  end-- // the closing bracket
  const inner = text.slice(start, end)
  let next: string
  if (!inner.trim()) next = entry
  else if (inner.includes('\n')) {
    const body = inner.replace(/\s+$/, ''), indent = /\n([ \t]*)\S[^\n]*$/.exec(body)?.[1] ?? '  '
    next = `${body.endsWith(',') ? body : `${body},`}${eol}${indent}${entry},${inner.slice(body.length)}`
  } else next = `${inner.replace(/\s*,?\s*$/, '')}, ${entry}`
  const withEntry = text.slice(0, start) + next + text.slice(end)
  const imports = [...withEntry.matchAll(/^import [^\n]*$/gm)], last = imports.at(-1)
  const line = `import ${name} from './${id}/${kind}.ts'`
  if (!last) return `${line}${eol}${withEntry}`
  const at = last.index + last[0].replace(/\r$/, '').length
  return withEntry.slice(0, at) + eol + line + withEntry.slice(at)
}
