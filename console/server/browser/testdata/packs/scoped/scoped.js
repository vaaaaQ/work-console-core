// A test pack with a scoped chat: serves window.DATA[concept] and window.GETS[concept][id] whatever the scope, so the console's own filter is what the tests see.
async function (call) {
  const w = globalThis;
  w.CALLS = (w.CALLS || []).concat([call]);
  if (call.verb === 'read') return { ok: true, data: (w.DATA && w.DATA[call.concept]) || [] };
  if (call.verb === 'get') {
    const g = w.GETS && w.GETS[call.concept] && w.GETS[call.concept][call.id];
    return g === undefined ? { ok: false, code: 'not_found', message: 'no ' + call.id } : { ok: true, data: g };
  }
  w.ACTS = (w.ACTS || []).concat([call]);
  return { ok: true, data: { done: call.action } };
}
