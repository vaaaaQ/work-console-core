// A test pack for the gateway contract: serves window.DATA[concept] and window.GETS[concept][id]; it declares no action.
async function (call) {
  const w = globalThis;
  if (call.verb === 'read') return { ok: true, data: (w.DATA && w.DATA[call.concept]) || [] };
  if (call.verb === 'get') {
    const g = w.GETS && w.GETS[call.concept] && w.GETS[call.concept][call.id];
    return g === undefined ? { ok: false, code: 'not_found', message: 'no ' + call.id } : { ok: true, data: g };
  }
  return { ok: false, code: 'unknown_action', message: 'this pack runs no action' };
}
