// A test pack for a real Edge: reads the test page's items with the tab's own cookie.
async function (call) {
  if (call.verb !== 'read') return { ok: false, code: 'not_found', message: 'this pack only reads' };
  const r = await fetch('/app/data.json', { credentials: 'include' });
  if (r.status === 401) return { ok: false, code: 'unauthorized', message: 'the test page wants its cookie' };
  if (!r.ok) return { ok: false, code: 'source_error', message: 'data.json answered ' + r.status };
  return { ok: true, data: await r.json() };
}
