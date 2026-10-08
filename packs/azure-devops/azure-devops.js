// An Azure DevOps pack, evaluated in a signed-in dev.azure.com tab as (script)(call): the REST API on
// the tab's own cookie session, with the organization, project, team and board from call.config.
async function (call, env) {
  env = env || { fetch: (url, init) => fetch(url, init), location: window.location, document: window.document };

  const SITE = 'dev.azure.com';
  const MAX_TEXT = 28000;
  const ORG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,48}[A-Za-z0-9])?$/;
  const NAME = /^[^\\/:*?"'<>;#$={},+\[\]|\u0000-\u001f\u007f]{1,64}$/;
  const COLUMN = /^[^\u0000-\u001f\u007f]{1,128}$/;
  const STATE = /^[^\u0000-\u001f\u007f]{1,64}$/;
  const FIELD = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;
  // the same defaults as pack.json, for a call that comes without them
  const DONE = ['Closed', 'Done', 'Removed'];
  const FIELDS = ['System.Reason', 'System.Tags', 'System.CreatedBy', 'System.CreatedDate', 'Microsoft.VSTS.Common.Priority', 'Microsoft.VSTS.Common.Severity',
    'Microsoft.VSTS.Scheduling.StoryPoints', 'Microsoft.VSTS.Scheduling.Effort', 'Microsoft.VSTS.Scheduling.RemainingWork', 'Microsoft.VSTS.Common.ValueArea'];

  // ---- envelope ----
  class Fail extends Error {
    constructor(code, message, retryAfter) { super(message); this.code = code; this.retryAfter = retryAfter; }
  }
  const fail = (code, message, retryAfter) => { throw new Fail(code, message, retryAfter); };
  // set once an action's write went out: from then on no failure is a sure one
  let wrote = false;
  const scrub = (s) => String(s).replace(/Bearer\s+[A-Za-z0-9._~+\/=-]+/g, 'Bearer [token]');

  // ---- text ----
  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
  const toText = (html) => String(html || '')
    .replace(/<img\b[^>]*>/gi, '[image]')
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e) => e[0] === '#'
      ? (ENTITIES[e] ?? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)))
      : (ENTITIES[e.toLowerCase()] ?? m))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const str = (v) => (v === null || v === undefined ? '' : String(v));
  // ISO-8601 UTC with milliseconds; accepts .NET's 7-digit fractions and zone-less UTC times
  const iso = (t) => {
    if (t === null || t === undefined || t === '') return null;
    let s = String(t).trim().replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1');
    if (!/(Z|[+-]\d\d:?\d\d)$/.test(s)) s += 'Z';
    const d = new Date(s);
    return isNaN(d) ? null : d.toISOString();
  };
  const isoOr = (t, fallback) => iso(t) ?? fallback;
  // a WIQL string literal
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";

  // ---- config ----
  const c = call.config || {};
  const one = (k, re, required) => {
    const v = c[k];
    if (v === undefined || v === null || v === '') { if (required) fail('bad_args', 'config.' + k + ' is required'); return undefined; }
    if (typeof v !== 'string' || !re.test(v)) fail('bad_args', 'config.' + k + ' is malformed');
    return v;
  };
  const list = (k, re, fallback, min = 0) => {
    const v = c[k];
    if (v === undefined || v === null) return fallback;
    if (!Array.isArray(v) || v.length < min || v.length > 50 || !v.every((x) => typeof x === 'string' && re.test(x)))
      fail('bad_args', 'config.' + k + ' must be a list of ' + (min ? 'at least ' + min + ' ' : '') + 'well-formed names');
    return v;
  };
  let ADO, PROJECT, TEAM, PROJECT_URL, TEAM_URL, BOARD, READY, HANDOFF, DONE_STATES, WANT_FIELDS;
  const settings = () => {
    const org = one('org', ORG, true);
    PROJECT = one('project', NAME, true);
    TEAM = one('team', NAME) || PROJECT + ' Team';
    BOARD = one('board', NAME);
    READY = one('ready', COLUMN);
    HANDOFF = list('handoff', COLUMN, []);
    DONE_STATES = list('doneStates', STATE, DONE, 1);
    WANT_FIELDS = list('fields', FIELD, FIELDS);
    ADO = 'https://' + SITE + '/' + org;
    PROJECT_URL = ADO + '/' + encodeURIComponent(PROJECT);
    TEAM_URL = PROJECT_URL + '/' + encodeURIComponent(TEAM);
  };

  // ---- http: the tab's cookies ----
  const http = async (method, url, { headers = {}, body, as = 'json' } = {}) => {
    const init = { method, credentials: 'include', headers: { Accept: 'application/json', 'X-TFS-FedAuthRedirect': 'Suppress', ...headers } };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      if (!init.headers['Content-Type']) init.headers['Content-Type'] = 'application/json';
    }
    const where = method + ' ' + url.split('?')[0].replace(/^https:\/\//, '');
    const lost = call.verb === 'act' && method !== 'GET' ? 'unknown' : 'source_error';
    if (lost === 'unknown') wrote = true;
    let res;
    try { res = await env.fetch(url, init); }
    catch (e) { fail(lost, where + ': ' + (e && e.message ? e.message : 'network error')); }
    // 203 is ADO's answer to a call whose session has lapsed
    if (res.status === 401 || res.status === 203) fail('unauthorized', where + ' → ' + res.status);
    if (res.status === 429) {
      const after = Number(res.headers.get('Retry-After'));
      fail('rate_limited', where + ' → 429', Number.isFinite(after) && after > 0 ? after : 60);
    }
    if (res.status === 404) fail('not_found', where + ' → 404');
    if (!res.ok) fail(res.status >= 500 ? lost : 'source_error', where + ' → ' + res.status);
    if (res.status === 204) return null;
    let text;
    try { text = await res.text(); }
    catch (e) { fail(lost, where + ': the answer broke off'); }
    if (as === 'text') return text;
    if (/^\s*</.test(text)) fail('unauthorized', where + ' answered with a page, not JSON');
    try { return text ? JSON.parse(text) : null; }
    catch { fail(lost, where + ': the answer is not JSON'); }
  };
  const ado = (method, url, body, contentType) => http(method, url, { body, headers: contentType ? { 'Content-Type': contentType } : {} });
  const v = (url) => url + (url.includes('?') ? '&' : '?') + 'api-version=7.1';
  const adoMe = async () => {
    const res = await ado('GET', ADO + '/_apis/connectionData');
    const u = res && res.authenticatedUser;
    if (!u || !u.id || u.id === '00000000-0000-0000-0000-000000000000') fail('unauthorized', 'Azure DevOps knows no signed-in user');
    return u.id;
  };

  // ---- args ----
  const argStr = (args, name, { max = 400 } = {}) => {
    const x = args ? args[name] : undefined;
    if (x === undefined || x === null) fail('bad_args', name + ' is required');
    if (typeof x !== 'string' || !x.trim()) fail('bad_args', name + ' must be a non-empty string');
    if (x.length > max) fail('bad_args', name + ' is longer than ' + max);
    return x;
  };
  const argId = (args, name) => { const x = argStr(args, name, { max: 20 }); if (!/^\d+$/.test(x)) fail('bad_args', name + ' must be a number'); return x; };
  const watched = (concept) => ((call.watch && call.watch[concept]) || []).filter((x) => typeof x === 'string' && /^\d{1,12}$/.test(x));
  const pool = async (items, n, fn) => {
    const out = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
    }));
    return out;
  };
  const orNull = (p) => p.catch((e) => { if (e instanceof Fail && e.code === 'not_found') return null; throw e; });

  // ---- review: pull requests ----
  const prLink = (pr) => PROJECT_URL + '/_git/' + encodeURIComponent(pr.repository.name) + '/pullrequest/' + pr.pullRequestId;
  const prById = (id) => ado('GET', v(PROJECT_URL + '/_apis/git/pullrequests/' + id));
  const threadsOf = (pr) => ado('GET', v(PROJECT_URL + '/_apis/git/repositories/' + encodeURIComponent(pr.repository.id) + '/pullRequests/' + pr.pullRequestId + '/threads'));
  const realThreads = (xs) => (xs || []).filter((t) => !t.isDeleted && t.status && t.status !== 'unknown');
  const votes = (pr) => (pr.reviewers || []).map((r) => ({ reviewer: str(r.displayName), vote: Number(r.vote) || 0 }));

  const reviewRead = async () => {
    const me = await adoMe();
    const mine = (role) => ado('GET', v(PROJECT_URL + '/_apis/git/pullrequests?searchCriteria.status=active&searchCriteria.' + role + '=' + me + '&$top=30'));
    const [asReviewer, asAuthor] = await Promise.all([mine('reviewerId'), mine('creatorId')]);
    const byId = new Map();
    for (const pr of [...(asReviewer.value || []), ...(asAuthor.value || [])]) byId.set(String(pr.pullRequestId), pr);
    for (const pr of await pool(watched('review').filter((id) => !byId.has(id)), 4, (id) => orNull(prById(id))))
      if (pr) byId.set(String(pr.pullRequestId), pr);
    const prs = [...byId.values()].sort((a, b) => str(b.creationDate).localeCompare(str(a.creationDate))).slice(0, 30);
    const threads = await pool(prs, 6, threadsOf);
    return prs.map((pr, i) => {
      const mineAs = (pr.reviewers || []).find((r) => r.id === me);
      return {
        id: String(pr.pullRequestId), repo: str(pr.repository.name), title: str(pr.title), author: (pr.createdBy && pr.createdBy.displayName) || '',
        myVote: mineAs ? Number(mineAs.vote) || 0 : null, votes: votes(pr),
        activeThreads: realThreads(threads[i] && threads[i].value).filter((t) => t.status === 'active').length,
        createdAt: isoOr(pr.creationDate, call.now), link: prLink(pr),
      };
    });
  };

  // policies only while active; a failed read of them is null, never a failed get
  const policiesOf = (pr) => ado('GET', PROJECT_URL + '/_apis/policy/evaluations?artifactId='
    + encodeURIComponent('vstfs:///CodeReview/CodeReviewId/' + pr.repository.project.id + '/' + pr.pullRequestId) + '&api-version=7.1-preview.1')
    .then((r) => ((r && r.value) || []).map((e) => {
      const cf = e.configuration || {};
      return { name: str((e.context && e.context.buildDefinitionName) || (cf.settings && cf.settings.displayName) || (cf.type && cf.type.displayName) || 'policy'),
        status: str(e.status), blocking: !!cf.isBlocking };
    })).catch(() => null);
  const branch = (ref) => str(ref).replace(/^refs\/heads\//, '');

  const reviewGet = async (id) => {
    if (!/^\d+$/.test(id)) fail('bad_args', 'a pull request id is a number');
    const pr = await prById(id);
    const active = pr.status === 'active' && pr.repository && pr.repository.project;
    const [res, policies] = await Promise.all([threadsOf(pr), active ? policiesOf(pr) : null]);
    return {
      pr: {
        title: str(pr.title), repo: str(pr.repository.name), link: prLink(pr), source: branch(pr.sourceRefName), target: branch(pr.targetRefName),
        status: str(pr.status), draft: !!pr.isDraft, author: (pr.createdBy && pr.createdBy.displayName) || '',
        closedAt: pr.status === 'active' ? null : iso(pr.closedDate), votes: votes(pr), merge: pr.mergeStatus ? str(pr.mergeStatus) : null, policies,
      },
      threads: realThreads(res && res.value).map((t) => ({
        id: String(t.id), status: str(t.status), file: (t.threadContext && t.threadContext.filePath) || null,
        comments: (t.comments || []).filter((x) => !x.isDeleted && x.commentType !== 'system')
          .map((x) => ({ author: (x.author && x.author.displayName) || '', at: isoOr(x.publishedDate, call.now), text: str(x.content) })),
      })),
    };
  };

  const reviewVote = async (args) => {
    const id = argId(args, 'id'), vote = args ? args.vote : undefined;
    if (![10, 5, 0, -5, -10].includes(vote)) fail('bad_args', 'vote must be one of 10, 5, 0, -5, -10');
    const [me, pr] = await Promise.all([adoMe(), prById(id)]);
    const res = await ado('PUT', v(PROJECT_URL + '/_apis/git/repositories/' + encodeURIComponent(pr.repository.id) + '/pullRequests/' + id + '/reviewers/' + me), { vote });
    return { id, vote: res && typeof res.vote === 'number' ? res.vote : vote };
  };

  const reviewComment = async (args) => {
    const id = argId(args, 'id'), text = argStr(args, 'text', { max: MAX_TEXT });
    const threadId = args.threadId === undefined ? undefined : argId(args, 'threadId');
    const pr = await prById(id);
    const base = PROJECT_URL + '/_apis/git/repositories/' + encodeURIComponent(pr.repository.id) + '/pullRequests/' + id + '/threads';
    if (threadId) {
      const res = await ado('POST', v(base + '/' + threadId + '/comments'), { content: text, parentCommentId: 1, commentType: 1 });
      return { id, threadId, commentId: res ? res.id : null };
    }
    const res = await ado('POST', v(base), { comments: [{ parentCommentId: 0, content: text, commentType: 1 }], status: 1 });
    return { id, threadId: res ? String(res.id) : null };
  };

  // ---- work: work items ----
  const WORK_FIELDS = ['System.Id', 'System.WorkItemType', 'System.Title', 'System.State', 'System.AssignedTo', 'System.ChangedDate', 'System.TeamProject'];
  const workLink = (f, id) => ADO + '/' + encodeURIComponent(f['System.TeamProject'] || PROJECT) + '/_workitems/edit/' + id;
  const person = (x) => (x && x.displayName) || null;
  const workItem = (w, f) => ({
    id: String(w.id), type: str(f['System.WorkItemType']), title: str(f['System.Title']), state: str(f['System.State']),
    assignedTo: person(f['System.AssignedTo']), changedAt: isoOr(f['System.ChangedDate'], call.now), link: workLink(f, w.id),
  });
  const wiql = (where) => ado('POST', v(PROJECT_URL + '/_apis/wit/wiql?$top=100'), { query: 'SELECT [System.Id] FROM WorkItems WHERE ' + where + ' ORDER BY [System.ChangedDate] DESC' });
  const notDone = () => '[System.State] NOT IN (' + DONE_STATES.map(q).join(', ') + ')';

  const workRead = async () => {
    const res = await wiql('[System.AssignedTo] = @Me AND ' + notDone());
    const ids = ((res && res.workItems) || []).map((w) => w.id);
    for (const w of watched('work')) if (!ids.includes(+w)) ids.push(+w);
    if (!ids.length) return [];
    const batch = await ado('POST', v(ADO + '/_apis/wit/workitemsbatch'), { ids: ids.slice(0, 100), fields: WORK_FIELDS, errorPolicy: 'omit' });
    return ((batch && batch.value) || []).filter(Boolean).map((w) => workItem(w, w.fields || {})).sort((a, b) => b.changedAt.localeCompare(a.changedAt));
  };

  // a field's label from its reference name: Microsoft.VSTS.Scheduling.StoryPoints → Story Points
  const label = (ref) => ref.split('.').pop().replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').trim();
  const fieldValue = (x) => {
    if (x === null || typeof x === 'number' || typeof x === 'boolean') return [x];
    if (typeof x === 'string') return [/<[a-z][^>]*>/i.test(x) ? toText(x) : /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(x) ? (iso(x) ?? x) : x];
    if (x && typeof x.displayName === 'string') return [x.displayName];
    return null;
  };
  // vstfs:///Git/PullRequestId/{project}%2F{repo}%2F{id}
  const prOf = (r) => {
    const m = /^vstfs:\/\/\/Git\/PullRequestId\/(.+)$/i.exec(str(r && r.url));
    try { return m ? decodeURIComponent(m[1]).split('/').pop() : ''; } catch { return ''; }
  };

  const workGet = async (id) => {
    if (!/^\d+$/.test(id)) fail('bad_args', 'a work item id is a number');
    // all fields: a fields= list naming one the process lacks fails the whole read
    const w = await ado('GET', v(ADO + '/_apis/wit/workitems/' + id) + '&$expand=relations');
    const f = (w && w.fields) || {};
    const res = await ado('GET', ADO + '/' + encodeURIComponent(f['System.TeamProject'] || PROJECT) + '/_apis/wit/workItems/' + id + '/comments?$top=20&order=desc&api-version=7.1-preview.4');
    const fields = [];
    for (const ref of [...new Set(WANT_FIELDS)]) {
      if (!Object.prototype.hasOwnProperty.call(f, ref)) continue;
      const x = fieldValue(f[ref]);
      if (x) fields.push({ ref, name: label(ref), value: x[0] });
    }
    const html = w && w._links && w._links.html && w._links.html.href;
    return {
      type: str(f['System.WorkItemType']), title: str(f['System.Title']), state: str(f['System.State']), assignedTo: person(f['System.AssignedTo']),
      link: /^https:\/\//.test(str(html)) ? html : workLink(f, id),
      area: str(f['System.AreaPath']), iteration: str(f['System.IterationPath']),
      prs: [...new Set(((w && w.relations) || []).map(prOf).filter((x) => /^\d+$/.test(x)))].slice(0, 50),
      description: toText(f['System.Description']), reproSteps: toText(f['Microsoft.VSTS.TCM.ReproSteps']),
      acceptanceCriteria: toText(f['Microsoft.VSTS.Common.AcceptanceCriteria']),
      comments: ((res && res.comments) || []).filter((x) => !x.isDeleted).slice(0, 20).map((x) => ({
        id: String(x.id), author: (x.createdBy && x.createdBy.displayName) || '', at: isoOr(x.createdDate, call.now), text: toText(x.text),
      })),
      fields: fields.slice(0, 50),
    };
  };

  const workSetState = async (args) => {
    const id = argId(args, 'id'), state = argStr(args, 'state', { max: 60 });
    const w = await ado('PATCH', v(ADO + '/_apis/wit/workitems/' + id), [{ op: 'add', path: '/fields/System.State', value: state }], 'application/json-patch+json');
    return { id, state: w && w.fields && w.fields['System.State'] ? w.fields['System.State'] : state };
  };

  const workComment = async (args) => {
    const id = argId(args, 'id'), text = argStr(args, 'text', { max: MAX_TEXT });
    const w = await ado('GET', v(ADO + '/_apis/wit/workitems/' + id + '?fields=System.TeamProject'));
    const project = (w && w.fields && w.fields['System.TeamProject']) || PROJECT;
    const res = await ado('POST', ADO + '/' + encodeURIComponent(project) + '/_apis/wit/workItems/' + id + '/comments?api-version=7.1-preview.4', { text });
    return { id, commentId: res ? res.id : null };
  };

  // ---- board: the team's board in three lanes ----
  // System.BoardColumn, not the board's own WEF column field: that one keeps stale values and refuses EVER
  const boardRead = async () => {
    if (!BOARD) fail('bad_args', 'config.board names the board this concept reads');
    const [board, team] = await Promise.all([
      ado('GET', v(TEAM_URL + '/_apis/work/boards/' + encodeURIComponent(BOARD))),
      ado('GET', v(TEAM_URL + '/_apis/work/teamsettings/teamfieldvalues')),
    ]);
    const columns = ((board && board.columns) || []).map((x) => str(x.name)).filter(Boolean);
    const types = Object.keys((board && board.columns && board.columns[0] && board.columns[0].stateMappings) || {});
    if (!columns.length || !types.length) fail('source_error', 'board ' + BOARD + ' names no columns or item types');
    const ready = READY || columns[0];
    if (!columns.includes(ready)) fail('bad_args', 'config.ready: ' + ready + ' is not a column of board ' + BOARD);
    const off = HANDOFF.filter((x) => !columns.includes(x));
    if (off.length) fail('bad_args', 'config.handoff: ' + off.join(', ') + ' not a column of board ' + BOARD);
    const field = str(team && team.field && team.field.referenceName) || 'System.AreaPath';
    if (!FIELD.test(field)) fail('source_error', 'team ' + TEAM + ' is scoped by a field that is no field name');
    const values = ((team && team.values) || []).filter((x) => x && typeof x.value === 'string' && x.value);
    if (!values.length) fail('source_error', 'team ' + TEAM + ' has no area');
    const area = '(' + values.map((x) => '[' + field + '] ' + (x.includeChildren && field === 'System.AreaPath' ? 'UNDER ' : '= ') + q(x.value)).join(' OR ') + ')';
    const scope = area + ' AND [System.WorkItemType] IN (' + types.map(q).join(', ') + ') AND ';
    const lanes = [['mine', scope + '[System.AssignedTo] = @Me AND ' + notDone()]];
    if (HANDOFF.length) lanes.push(['qa', scope + '[System.AssignedTo] EVER @Me AND (' + HANDOFF.map((x) => '[System.BoardColumn] EVER ' + q(x)).join(' OR ') + ') AND [System.ChangedDate] >= @Today - 90']);
    lanes.push(['free', scope + '[System.BoardColumn] = ' + q(ready) + " AND [System.AssignedTo] = ''"]);
    const hits = await Promise.all(lanes.map(([, where]) => wiql(where)));
    // the first lane an item turns up in wins: mine, then qa, then free
    const lane = new Map();
    lanes.forEach(([l], i) => { for (const w of (hits[i] && hits[i].workItems) || []) if (!lane.has(w.id)) lane.set(w.id, l); });
    // over the cap the lowest lanes are cut first
    const ids = [...lane.keys()].slice(0, 100);
    if (!ids.length) return [];
    const batch = await ado('POST', v(ADO + '/_apis/wit/workitemsbatch'), { ids, fields: [...WORK_FIELDS, 'System.BoardColumn', 'System.BoardLane'], errorPolicy: 'omit' });
    const rank = (l) => lanes.findIndex(([x]) => x === l);
    return ((batch && batch.value) || []).filter((w) => w && lane.has(w.id)).map((w) => {
      const f = w.fields || {}, it = workItem(w, f);
      return { id: it.id, type: it.type, title: it.title, state: it.state, column: str(f['System.BoardColumn']) || null, lane: lane.get(w.id),
        swimlane: str(f['System.BoardLane']) || null, assignedTo: it.assignedTo, changedAt: it.changedAt, link: it.link };
    }).sort((a, b) => rank(a.lane) - rank(b.lane) || b.changedAt.localeCompare(a.changedAt));
  };

  // ---- ci: builds ----
  const ciRead = async () => {
    const me = await adoMe();
    const res = await ado('GET', v(PROJECT_URL + '/_apis/build/builds?requestedFor=' + encodeURIComponent(me) + '&$top=50&queryOrder=queueTimeDescending'));
    const byId = new Map();
    for (const b of (res && res.value) || [])
      if ((b.requestedFor && b.requestedFor.id === me) || (b.requestedBy && b.requestedBy.id === me)) byId.set(String(b.id), b);
    const extra = watched('ci').filter((id) => !byId.has(id));
    if (extra.length) {
      const more = await ado('GET', v(PROJECT_URL + '/_apis/build/builds?buildIds=' + extra.slice(0, 30).join(',')));
      for (const b of (more && more.value) || []) byId.set(String(b.id), b);
    }
    return [...byId.values()].sort((a, b) => str(b.queueTime).localeCompare(str(a.queueTime))).slice(0, 30).map((b) => ({
      id: String(b.id), pipeline: str(b.definition && b.definition.name), status: str(b.status), result: b.result || null,
      branch: b.sourceBranch ? branch(b.sourceBranch) : null, startedAt: iso(b.startTime), finishedAt: iso(b.finishTime),
      link: b._links && b._links.web && /^https:\/\//.test(str(b._links.web.href)) ? b._links.web.href : PROJECT_URL + '/_build/results?buildId=' + b.id,
    }));
  };

  // the last 200 lines of the failed step's log, or of the last log
  const ciGet = async (id) => {
    if (!/^\d+$/.test(id)) fail('bad_args', 'a build id is a number');
    const base = PROJECT_URL + '/_apis/build/builds/' + id;
    const timeline = await orNull(ado('GET', v(base + '/timeline')));
    const failed = ((timeline && timeline.records) || []).filter((r) => r.result === 'failed' && r.log && r.log.id).map((r) => r.log.id);
    const logs = ((await ado('GET', v(base + '/logs'))) || {}).value || [];
    if (!logs.length) return { log: '' };
    const want = failed.length ? Math.max(...failed) : null;
    const pick = logs.find((l) => l.id === want) || logs.reduce((a, b) => (b.id > a.id ? b : a));
    const text = await http('GET', v(base + '/logs/' + pick.id + '?startLine=' + Math.max(1, (pick.lineCount || 0) - 200)), { headers: { Accept: 'text/plain' }, as: 'text' });
    return { log: text.length > 60000 ? text.slice(text.length - 60000) : text };
  };

  const READS = { work: workRead, review: reviewRead, ci: ciRead, board: boardRead };
  const GETS = { work: workGet, review: reviewGet, ci: ciGet };
  const ACTS = { 'work.setState': workSetState, 'work.comment': workComment, 'review.vote': reviewVote, 'review.comment': reviewComment };

  try {
    const doc = env.document;
    if (!doc || doc.readyState === 'loading' || !doc.body || doc.body.childElementCount === 0) fail('blank', 'the tab has not rendered');
    settings();
    const here = str(env.location && env.location.hostname);
    if (here !== SITE) fail('unauthorized', 'the tab is on ' + here + ', not ' + SITE + '; likely a sign-in page');
    const name = call.verb === 'act' ? call.action : call.concept;
    let data;
    if (call.verb === 'read' && READS[call.concept]) data = await READS[call.concept]();
    else if (call.verb === 'get' && GETS[call.concept]) data = await GETS[call.concept](str(call.id));
    else if (call.verb === 'act' && ACTS[call.action]) data = await ACTS[call.action](call.args || {});
    else fail('bad_args', 'unknown ' + call.verb + ' ' + name);
    return { ok: true, data };
  } catch (e) {
    if (e instanceof Fail) {
      const out = { ok: false, code: e.code, message: scrub(e.message) };
      if (e.retryAfter) out.retryAfter = e.retryAfter;
      return out;
    }
    return { ok: false, code: wrote ? 'unknown' : 'source_error', message: scrub((e && e.name ? e.name + ': ' : '') + (e && e.message ? e.message : String(e))) };
  }
}
