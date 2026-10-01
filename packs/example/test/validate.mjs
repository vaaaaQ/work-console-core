// A JS check of the schemas' keyword subset, so the pack is checked against
// the schemas the gateway enforces, not against a looser reading of them.
import { readFileSync } from 'node:fs';

const KNOWN = new Set(['$schema', '$id', 'title', 'description', 'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'minimum', 'maxItems', 'format']);

export function schema(key) {
  const s = JSON.parse(readFileSync(new URL(`../../../schemas/${key}.schema.json`, import.meta.url), 'utf8'));
  check(s, '#');
  return s;
}

function check(s, at) {
  for (const [k, v] of Object.entries(s)) {
    if (!KNOWN.has(k)) throw new Error(`${at}: unsupported keyword '${k}'`);
    if (k === 'properties') for (const [n, c] of Object.entries(v)) check(c, `${at}/properties/${n}`);
    if (k === 'items') check(v, `${at}/items`);
  }
}

const kind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const is = (type, v) => ({
  string: typeof v === 'string',
  number: typeof v === 'number',
  integer: Number.isInteger(v),
  boolean: typeof v === 'boolean',
  array: Array.isArray(v),
  object: v !== null && typeof v === 'object' && !Array.isArray(v),
  null: v === null,
})[type];

const formatOk = (f, s) => {
  if (f === 'date-time') return s.length >= 20 && (/Z$/.test(s) || /[+-]\d\d:\d\d$/.test(s)) && !isNaN(Date.parse(s));
  if (f === 'uri') { try { return ['https:', 'http:'].includes(new URL(s).protocol); } catch { return false; } }
  return true;
};

export function validate(s, value, path = '$', errors = []) {
  if (s.type !== undefined && !(Array.isArray(s.type) ? s.type : [s.type]).some((t) => is(t, value))) {
    errors.push(`${path}: expected ${s.type}, got ${kind(value)}`);
    return errors;
  }
  if (value === null) return errors;
  if (s.enum && !s.enum.some((o) => JSON.stringify(o) === JSON.stringify(value))) errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(s.enum)}`);
  if (s.minimum !== undefined && typeof value === 'number' && value < s.minimum) errors.push(`${path}: below ${s.minimum}`);
  if (s.format && typeof value === 'string' && !formatOk(s.format, value)) errors.push(`${path}: not a ${s.format}`);
  if (is('object', value)) {
    for (const r of s.required || []) if (!(r in value)) errors.push(`${path}.${r}: missing`);
    for (const [k, v] of Object.entries(value)) {
      if (s.properties && k in s.properties) validate(s.properties[k], v, `${path}.${k}`, errors);
      else if (s.additionalProperties === false) errors.push(`${path}.${k}: not allowed`);
    }
  }
  if (Array.isArray(value)) {
    if (s.maxItems !== undefined && value.length > s.maxItems) errors.push(`${path}: ${value.length} items, over ${s.maxItems}`);
    if (s.items) value.forEach((x, i) => validate(s.items, x, `${path}[${i}]`, errors));
  }
  return errors;
}
