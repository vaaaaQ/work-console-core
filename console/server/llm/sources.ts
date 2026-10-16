import { KIND_LABEL } from '../../src/model/packs.ts'
import type { PackView } from '../../src/model/packs.ts'

/* ## Sources: what a run can read and do through the packs that are on, in each pack's own words. Candidates never
   reach it; a pack that is off is named only, so a run that needs it says so instead of hunting for tools. */

function stateLine(p: PackView): string {
  if (p.state === 'error') return `state: error: ${p.message ?? p.problem ?? 'did not load'}`
  if (p.state === 'signin_required') return `state: signin_required${p.host ? ` (sign in to ${p.host})` : ''}`
  return `state: ${p.state}${p.message && p.state !== 'ok' ? ` (${p.message})` : ''}`
}

/** managed: the workspace's packs are turned on in Settings, so the ones that are off are named */
/** an mcp pack's tools as a run calls them: the read ones, those that change things, and those not given */
function toolsLine(p: PackView): string {
  const ts = p.tools ?? [], full = (n: string) => `mcp__${p.name}__${n}`
  const read = ts.filter((t) => t.on && !t.act).map((t) => full(t.name)), act = ts.filter((t) => t.on && t.act).map((t) => full(t.name)), no = ts.filter((t) => !t.on).map((t) => t.name)
  return `Tools: ${read.join(', ') || 'none'}${act.length ? `; that change things: ${act.join(', ')}` : ''}.`
    + (no.length ? ` Not given: ${no.join(', ')}; ask with request_access {runTools} if a step needs one.` : '')
}

export function sourcesSection(views: PackView[], managed: boolean): string {
  const on = views.filter((p) => p.on), off = managed ? views.filter((p) => !p.on && p.listed && !p.problem) : []
  if (!on.length && !off.length) return ''
  const blocks = on.map((p) => [
    `### ${p.title} (${p.name}, ${KIND_LABEL[p.kind]})`,
    ...(p.about ? [p.about] : []),
    ...(p.mcp ? [`Server: ${p.mcp}`] : []),
    `Serves: ${p.concepts.join(', ') || '-'} · ${stateLine(p)}`,
    ...(p.scoped ? [p.scopes.length ? `Scopes: ${p.scopes.map((s) => (s.name ? `${s.name} (${s.id})` : s.id)).join(', ')}` : 'No scopes ticked: it serves nothing until they are ticked in Settings → Packs.'] : []),
    ...(p.llmActs.length ? [`Runs may call: ${p.llmActs.join(', ')}`] : []),
    ...(p.tools?.length ? [toolsLine(p)] : []),
    ...(p.guide.trim() ? ['', p.guide.trim()] : []),
  ].join('\n'))
  const tail = off.length ? [`Off: ${off.map((p) => `${p.title} (${p.name}${p.kind === 'mcp' ? ', MCP server' : ''})`).join(', ')}. They are turned on in Settings → Packs; a step that needs one says so in a not_done draft.`] : []
  return ['## Sources', ...blocks, ...tail].join('\n\n')
}
