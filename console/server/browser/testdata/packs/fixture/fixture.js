// A test pack: serves window.DATA[concept], window.GETS[concept][id] and window.FILES[concept][id/file]; window.MODE[name] overrides the envelope.
async function (call) {
  const w = globalThis;
  w.CALLS = (w.CALLS || []).concat([call]);
  const name = call.verb === 'act' ? call.action : call.concept;
  const mode = w.MODE && w.MODE[name];
  const forced = typeof mode === 'function' ? await mode(call) : mode;
  if (forced) return forced;
  if (call.verb === 'read') return { ok: true, data: (w.DATA && w.DATA[call.concept]) || [] };
  if (call.verb === 'get') {
    const g = w.GETS && w.GETS[call.concept] && w.GETS[call.concept][call.id];
    return g === undefined ? { ok: false, code: 'not_found', message: 'no ' + call.id } : { ok: true, data: g };
  }
  if (call.verb === 'file') {
    const f = w.FILES && w.FILES[call.concept] && w.FILES[call.concept][call.id + '/' + call.file];
    return f === undefined ? { ok: false, code: 'not_found', message: 'no file ' + call.file } : { ok: true, data: f };
  }
  if (call.verb === 'candidates') return { ok: false, code: 'bad_args', message: 'no verb candidates' };
  w.ACTS = (w.ACTS || []).concat([call]);
  return { ok: true, data: { done: call.action } };
}
