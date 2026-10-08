/* What a new workspace is made of: consumer/workspace-template rendered for its id, its entry in both registries and
   grants.json granting nothing. install.mjs makes home with these; the workspace agent's create_workspace the others. */

/** the template's files; ui.tsx is the page-only half, so the page registry lists it beside page.ts */
export const TEMPLATE_FILES = ['page.ts', 'server.ts', 'ui.tsx']

/** the workspace a new console starts with */
export const HOME = { id: 'home', prefix: 'H', title: 'Home' }

const RESERVED = new Set(('break case catch class const continue debugger default delete do else enum export extends false finally for '
  + 'function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static '
  + 'implements interface package private protected public await').split(' '))

/** the id as a camel-case identifier: my-crm → myCrm; a reserved word gets a ws prefix */
export function varName(id) {
  const v = id.replace(/-+([a-z0-9])/g, (_, c) => c.toUpperCase())
  return RESERVED.has(v) ? `ws${v[0].toUpperCase()}${v.slice(1)}` : v
}

export const render = (text, o) =>
  text.replaceAll('__ID__', o.id).replaceAll('__PREFIX__', o.prefix).replaceAll('__TITLE__', o.title).replaceAll('__VAR__', varName(o.id))

/** grants.json of a workspace granted nothing yet, byte for byte as the console writes it */
export const EMPTY_GRANTS_JSON = JSON.stringify({ packs: [], hosts: [], acts: [], runTools: [], mcp: {} }, null, 2) + '\n'

/** the registry with the workspace's import after the last import and its entry last in the array */
export function addRegistry(text, kind, id) {
  const v = varName(id), name = kind === 'page' ? v : `${v}Server`, entry = kind === 'page' ? `{ page: ${v}, ui: ${v}Ui }` : name
  const eol = text.includes('\r\n') ? '\r\n' : '\n', array = kind === 'page' ? 'WORKSPACES' : 'SERVERS'
  if (text.includes(`'./${id}/`) || new RegExp(`\\b(${name}|${v}Ui)\\b`).test(text)) throw new Error(`the registry already registers ${id}`)
  const open = new RegExp(`export const ${array}\\b[^=]*=\\s*\\[`).exec(text)
  if (!open) throw new Error(`the registry has no ${array} array`)
  const start = open.index + open[0].length
  let depth = 1, end = start
  for (; end < text.length && depth; end++) depth += text[end] === '[' ? 1 : text[end] === ']' ? -1 : 0
  end-- // the closing bracket
  const inner = text.slice(start, end)
  let next
  if (!inner.trim()) next = entry
  else if (inner.includes('\n')) {
    const body = inner.replace(/\s+$/, ''), indent = /\n([ \t]*)\S[^\n]*$/.exec(body)?.[1] ?? '  '
    next = `${body.endsWith(',') ? body : `${body},`}${eol}${indent}${entry},${inner.slice(body.length)}`
  } else next = `${inner.replace(/\s*,?\s*$/, '')}, ${entry}`
  const withEntry = text.slice(0, start) + next + text.slice(end)
  const imports = [...withEntry.matchAll(/^import [^\n]*$/gm)], last = imports.at(-1)
  const line = `import ${name} from './${id}/${kind}.ts'` + (kind === 'page' ? `${eol}import ${v}Ui from './${id}/ui.tsx'` : '')
  if (!last) return `${line}${eol}${withEntry}`
  const at = last.index + last[0].replace(/\r$/, '').length
  return withEntry.slice(0, at) + eol + line + withEntry.slice(at)
}
