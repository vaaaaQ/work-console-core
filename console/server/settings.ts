import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HttpError } from './events.ts'
import { isProvider, PROVIDER_IDS, PROVIDERS } from './llm/providers.ts'
import type { ProviderSettings } from './llm/providers.ts'

/* The console's provider choice, one file for the person and the machine: <home>/providers.json.
   Read on every use, so a change applies from the next run without a restart. A key the file lacks
   or gets wrong reads as its default; a write is checked key by key and refused whole. */

const DEFAULTS: ProviderSettings = { auto: 'claude', manual: 'claude' }
const PATHS = ['claudePath', 'cursorPath'] as const

const isFile = (p: string) => { try { return statSync(p).isFile() } catch { return false } }

export class Settings {
  private file: string
  constructor(home: string) { this.file = join(home, 'providers.json') }

  read(): ProviderSettings {
    let raw: Record<string, unknown> = {}
    try { const v = JSON.parse(readFileSync(this.file, 'utf8')); if (v && typeof v === 'object') raw = v } catch { /* no file or not JSON: the defaults */ }
    const out: ProviderSettings = {
      auto: isProvider(raw.auto) ? raw.auto : DEFAULTS.auto,
      manual: isProvider(raw.manual) ? raw.manual : DEFAULTS.manual,
    }
    for (const k of PATHS) if (typeof raw[k] === 'string' && raw[k]) out[k] = raw[k] as string
    return out
  }

  /** b = the keys to change; a path of '' drops it. Nothing is launched to check a path */
  write(b: Record<string, unknown>): ProviderSettings {
    const next = this.read()
    for (const k of ['auto', 'manual'] as const) {
      if (b[k] === undefined) continue
      if (!isProvider(b[k])) throw new HttpError(400, 'bad_args', `${k} is one of ${PROVIDER_IDS.join(', ')}`)
      if (k === 'auto' && !PROVIDERS[b[k]].auto) throw new HttpError(400, 'bad_args', `${PROVIDERS[b[k]].label} cannot run by itself yet`)
      next[k] = b[k]
    }
    for (const k of PATHS) {
      const v = b[k]
      if (v === undefined) continue
      if (typeof v !== 'string') throw new HttpError(400, 'bad_args', `${k} is a path`)
      const p = v.trim()
      if (!p) { delete next[k]; continue }
      if (!isFile(p)) throw new HttpError(400, 'bad_args', `${k}: ${p} is not an existing file`)
      next[k] = p
    }
    writeFileSync(this.file, JSON.stringify(next, null, 2) + '\n')
    return this.read()
  }

  list() { return PROVIDER_IDS.map((id) => ({ id, label: PROVIDERS[id].label, auto: !!PROVIDERS[id].auto })) }
}
