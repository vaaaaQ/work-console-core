/* An MCP server's question (elicitation) as a form on the page. MCP keeps the requested schema flat: each property is a
   string, a number or integer, a boolean, or a string enum, so the form is drawn from it without knowing the server. */

export type Choice = { v: string; label: string }
export type ConfirmField =
  | { key: string; kind: 'boolean'; label: string; about?: string; required: boolean; value: boolean }
  | { key: string; kind: 'choice'; label: string; about?: string; required: boolean; choices: Choice[]; value: string }
  | { key: string; kind: 'number'; label: string; about?: string; required: boolean; integer?: true; value: string }
  | { key: string; kind: 'text'; label: string; about?: string; required: boolean; value: string }
export type ConfirmValues = Record<string, string | boolean>

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** the schema's fields, in its order, each with its default; anything not flat is a text field */
export function confirmFields(schema: Record<string, unknown> | undefined): ConfirmField[] {
  const props = isObj(schema?.properties) ? schema!.properties as Record<string, Record<string, unknown>> : {}
  const req = Array.isArray(schema?.required) ? schema!.required as string[] : []
  return Object.entries(props).map(([key, p]): ConfirmField => {
    const base = { key, label: typeof p.title === 'string' && p.title ? p.title : key, ...(typeof p.description === 'string' && p.description ? { about: p.description } : {}), required: req.includes(key) }
    if (p.type === 'boolean') return { ...base, kind: 'boolean', value: p.default === true }
    if (Array.isArray(p.enum)) {
      const names = Array.isArray(p.enumNames) ? p.enumNames : []
      const choices = p.enum.map((v, i) => ({ v: String(v), label: typeof names[i] === 'string' ? names[i] as string : String(v) }))
      return { ...base, kind: 'choice', choices, value: typeof p.default === 'string' ? p.default : choices[0]?.v ?? '' }
    }
    if (p.type === 'number' || p.type === 'integer') return { ...base, kind: 'number', ...(p.type === 'integer' ? { integer: true as const } : {}), value: typeof p.default === 'number' ? String(p.default) : '' }
    return { ...base, kind: 'text', value: typeof p.default === 'string' ? p.default : '' }
  })
}

/** the answer's content from the form's values; missing = the labels of required fields left empty and of numbers that are not */
export function confirmContent(fields: ConfirmField[], values: ConfirmValues): { content: Record<string, string | number | boolean>; missing: string[] } {
  const content: Record<string, string | number | boolean> = {}, missing: string[] = []
  for (const f of fields) {
    const v = values[f.key] ?? f.value
    // an optional checkbox goes only when touched: a server may read an explicit false as a no to the whole question
    if (f.kind === 'boolean') { if (f.required || f.key in values) content[f.key] = v === true; continue }
    const s = String(v).trim()
    if (!s) { if (f.required) missing.push(f.label); continue }
    if (f.kind === 'number') {
      const n = Number(s)
      if (!Number.isFinite(n) || (f.integer && !Number.isInteger(n))) { missing.push(f.label); continue }
      content[f.key] = n
    } else content[f.key] = s
  }
  return { content, missing }
}
