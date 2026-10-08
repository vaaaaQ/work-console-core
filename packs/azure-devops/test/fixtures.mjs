// Synthetic Azure DevOps answers in the recorded shape; the organization, project and people are made up.
export const HOST = 'dev.azure.com';
export const CONFIG = { org: 'acme', project: 'Road Map', board: 'Stories', handoff: ['Verify'] };
export const A = 'https://dev.azure.com/acme';
export const P = A + '/Road%20Map';
export const T = P + '/Road%20Map%20Team';
export const ME = '00000000-0000-0000-0000-00000000a001';

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
// a URL that starts with s, then matches the pattern rest
export const re = (s, rest = '') => new RegExp('^' + esc(s) + rest);

const me = { id: ME, displayName: 'Robin Park', uniqueName: 'robin@acme.example' };
const sam = { id: '00000000-0000-0000-0000-00000000b002', displayName: 'Sam Diaz', uniqueName: 'sam@acme.example' };
const pr = (id, title, created, author, reviewers) => ({
  pullRequestId: id, title, creationDate: created, createdBy: { displayName: author }, status: 'active', isDraft: false,
  sourceRefName: 'refs/heads/feature/export', targetRefName: 'refs/heads/main', mergeStatus: 'succeeded',
  repository: { id: 'repo-guid', name: 'web app', project: { id: 'proj-guid' } }, reviewers,
});
const item = (id, type, title, state, column, to, changed, more = {}) => ({ id, fields: {
  'System.Id': id, 'System.WorkItemType': type, 'System.Title': title, 'System.State': state, 'System.BoardColumn': column,
  ...(to ? { 'System.AssignedTo': to } : {}), 'System.ChangedDate': changed, 'System.TeamProject': 'Road Map', ...more,
} });

export const ado = {
  connectionData: { authenticatedUser: { id: ME, providerDisplayName: 'Robin Park' } },
  asReviewer: { value: [pr(101, 'Fix login', '2026-09-29T10:00:00.1234567Z', 'Sam Diaz', [{ id: ME, displayName: 'Robin Park', vote: 0 }, { id: 'x', displayName: 'Lee Chan', vote: 10 }])] },
  asAuthor: { value: [pr(102, 'Add export', '2026-09-30T10:00:00Z', 'Robin Park', [{ id: 'y', displayName: 'Lee Chan', vote: -5 }])] },
  pr90: { ...pr(90, 'Old one', '2026-09-01T10:00:00Z', 'Sam Diaz', []), status: 'completed', closedDate: '2026-09-02T10:00:00Z' },
  pr101: pr(101, 'Fix login', '2026-09-29T10:00:00Z', 'Sam Diaz', [{ id: ME, displayName: 'Robin Park', vote: 0 }]),
  threads: { value: [
    { id: 1, status: 'active', threadContext: { filePath: '/src/a.ts' }, comments: [{ id: 1, author: { displayName: 'Sam Diaz' }, publishedDate: '2026-09-30T10:00:00.1Z', content: 'please fix', commentType: 'text' }] },
    { id: 2, status: 'fixed', threadContext: null, comments: [
      { id: 1, author: { displayName: 'Sam Diaz' }, publishedDate: '2026-09-30T11:00:00Z', content: 'ok', commentType: 'text' },
      { id: 2, author: { displayName: 'Sam Diaz' }, publishedDate: '2026-09-30T11:00:00Z', content: 'gone', commentType: 'text', isDeleted: true },
      { id: 3, author: { displayName: 'System' }, publishedDate: '2026-09-30T11:00:00Z', content: 'Robin voted', commentType: 'system' }] },
    { id: 3, comments: [{ id: 1, author: { displayName: 'System' }, publishedDate: '2026-09-30T11:00:00Z', content: 'Robin voted', commentType: 'system' }] },
    { id: 4, status: 'active', isDeleted: true, comments: [] },
  ] },
  policies: { value: [
    { status: 'approved', configuration: { isBlocking: true, type: { displayName: 'Build' } }, context: { buildDefinitionName: 'web app CI' } },
    { status: 'queued', configuration: { isBlocking: false, settings: { displayName: 'Two reviewers' } } },
  ] },

  wiql: { workItems: [{ id: 95512 }, { id: 95513 }] },
  batch: { value: [
    { id: 95512, fields: { 'System.Id': 95512, 'System.WorkItemType': 'Bug', 'System.Title': 'Login fails', 'System.State': 'Active', 'System.AssignedTo': me, 'System.ChangedDate': '2026-09-30T08:00:00.12Z', 'System.TeamProject': 'Road Map' } },
    { id: 95513, fields: { 'System.Id': 95513, 'System.WorkItemType': 'Task', 'System.Title': 'Write tests', 'System.State': 'New', 'System.ChangedDate': '2026-09-30T09:00:00Z', 'System.TeamProject': 'Side Quest' } },
    null,
  ] },
  workItem: {
    id: 95512,
    fields: {
      'System.TeamProject': 'Road Map', 'System.WorkItemType': 'Bug', 'System.Title': 'Duplicate check on save', 'System.State': 'Active',
      'System.AssignedTo': me, 'System.AreaPath': 'Road Map\\Apps', 'System.IterationPath': 'Road Map\\Sprint 7',
      'System.Description': '<div>Steps:<br>1. open <img src="https://dev.azure.com/acme/_apis/wit/attachments/1b2c?fileName=a.png"></div>',
      'Microsoft.VSTS.TCM.ReproSteps': '<ol><li>Add a name</li><li>Save</li></ol>', 'Microsoft.VSTS.Common.AcceptanceCriteria': '<p>Save refuses a duplicate</p>',
      'Microsoft.VSTS.Common.Priority': 2, 'System.Tags': 'ui; export', 'System.CreatedBy': sam, 'System.CreatedDate': '2026-09-20T10:00:00.1234567Z',
      'Custom.RiskNotes': '<p>Low <b>risk</b>, see <img src="x.png"></p>', 'Custom.ReleaseTrain': 'Autumn', 'Custom.Blocked': false, 'Custom.Matrix': { a: 1 },
    },
    relations: [
      { rel: 'ArtifactLink', url: 'vstfs:///Git/PullRequestId/proj-guid%2Frepo-guid%2F101', attributes: { name: 'Pull Request' } },
      { rel: 'ArtifactLink', url: 'vstfs:///Git/PullRequestId/proj-guid%2Frepo-guid%2F101', attributes: { name: 'Pull Request' } },
      { rel: 'System.LinkTypes.Hierarchy-Reverse', url: 'https://dev.azure.com/acme/_apis/wit/workItems/95000' },
    ],
    _links: { html: { href: 'https://dev.azure.com/acme/Road%20Map/_workitems/edit/95512' } },
  },
  comments: { comments: [
    { id: 7, createdBy: { displayName: 'Sam Diaz' }, createdDate: '2026-09-30T09:00:00Z', text: '<p>seen <img src="y.png"></p>' },
    { id: 6, isDeleted: true, createdBy: { displayName: 'Sam Diaz' }, createdDate: '2026-09-30T08:00:00Z', text: 'x' },
  ] },

  builds: { value: [
    { id: 500, definition: { name: 'web app CI' }, status: 'completed', result: 'failed', sourceBranch: 'refs/heads/feature/x', queueTime: '2026-09-30T09:00:00Z',
      startTime: '2026-09-30T09:01:00.1234567Z', finishTime: '2026-09-30T09:20:00Z', requestedFor: { id: ME },
      _links: { web: { href: 'https://dev.azure.com/acme/Road%20Map/_build/results?buildId=500' } } },
    { id: 499, definition: { name: 'Other' }, status: 'completed', result: 'succeeded', sourceBranch: 'refs/heads/main', queueTime: '2026-09-30T08:00:00Z', requestedFor: { id: 'someone' } },
  ] },
  build501: { value: [
    { id: 501, definition: { name: 'web app CI' }, status: 'inProgress', result: null, sourceBranch: 'refs/heads/develop', queueTime: '2026-09-30T10:00:00Z', startTime: null, finishTime: null, requestedFor: { id: 'someone' } },
  ] },
  timeline: { records: [{ result: 'succeeded', log: { id: 3 } }, { result: 'failed', log: { id: 5 } }] },
  logs: { value: [{ id: 3, lineCount: 10 }, { id: 5, lineCount: 900 }, { id: 9, lineCount: 4 }] },

  // the team's board: its first column's state mappings name the item types it holds
  board: {
    id: 'board-guid', name: 'Stories',
    columns: [
      { id: 'c1', name: 'New', columnType: 'incoming', stateMappings: { 'User Story': 'New', Bug: 'New' } },
      { id: 'c2', name: 'Ready', columnType: 'inProgress', stateMappings: { 'User Story': 'Active', Bug: 'Active' } },
      { id: 'c3', name: 'Doing', columnType: 'inProgress', stateMappings: { 'User Story': 'Active', Bug: 'Active' } },
      { id: 'c4', name: 'Verify', columnType: 'inProgress', stateMappings: { 'User Story': 'Resolved', Bug: 'Resolved' } },
      { id: 'c5', name: "Won't do", columnType: 'inProgress', stateMappings: { 'User Story': 'Removed', Bug: 'Removed' } },
      { id: 'c6', name: 'Closed', columnType: 'outgoing', stateMappings: { 'User Story': 'Closed', Bug: 'Closed' } },
    ],
    rows: [{ id: '00000000-0000-0000-0000-000000000000', name: null }, { id: 'r2', name: 'Expedite' }],
  },
  area: { field: { referenceName: 'System.AreaPath' }, defaultValue: 'Road Map\\Apps', values: [
    { value: 'Road Map\\Apps', includeChildren: true }, { value: "Road Map\\Ops'Desk", includeChildren: false },
  ] },
  lanes: {
    mine: { workItems: [{ id: 96011 }, { id: 96010 }] },
    qa: { workItems: [{ id: 96010 }, { id: 96020 }, { id: 96021 }] },
    free: { workItems: [{ id: 96030 }] },
  },
  boardBatch: { value: [
    item(96010, 'Bug', 'Grid loses its filter', 'Active', 'Doing', me, '2026-09-29T10:00:00Z', { 'System.BoardLane': '' }),
    item(96011, 'User Story', 'Export to a sheet', 'Active', 'Doing', me, '2026-09-30T10:00:00.1234567Z', { 'System.BoardLane': 'Expedite' }),
    item(96020, 'Bug', 'Save stays disabled', 'Resolved', 'Verify', sam, '2026-09-28T10:00:00Z'),
    item(96021, 'Bug', 'Typo on the start page', 'Closed', '', null, '2026-07-01T10:00:00Z'),
    item(96030, 'User Story', 'Attachments on notes', 'New', 'New', null, '2026-09-27T10:00:00Z'),
    null,
  ] },
};

// the work concept's query names no area; the board's lanes each name one
const wiqlAnswer = (req) => {
  const q = req.body.query;
  if (!q.includes('AreaPath')) return { json: ado.wiql };
  if (q.includes('EVER')) return { json: ado.lanes.qa };
  if (q.includes('[System.AssignedTo] = @Me')) return { json: ado.lanes.mine };
  return { json: ado.lanes.free };
};

export const routes = () => [
  ['GET', re(A + '/_apis/connectionData'), { json: ado.connectionData }],
  ['GET', re(P + '/_apis/git/pullrequests?', '.*reviewerId=' + ME), { json: ado.asReviewer }],
  ['GET', re(P + '/_apis/git/pullrequests?', '.*creatorId=' + ME), { json: ado.asAuthor }],
  ['GET', re(P + '/_apis/git/pullrequests/90?'), { json: ado.pr90 }],
  ['GET', re(P + '/_apis/git/pullrequests/101?'), { json: ado.pr101 }],
  ['GET', re(P + '/_apis/git/pullrequests/', '\\d+\\?'), { status: 404, text: '{}' }],
  ['GET', re(P + '/_apis/git/repositories/repo-guid/pullRequests/', '\\d+/threads\\?'), { json: ado.threads }],
  ['GET', re(P + '/_apis/policy/evaluations?artifactId='), { json: ado.policies }],
  ['POST', re(P + '/_apis/git/repositories/repo-guid/pullRequests/', '\\d+/threads/\\d+/comments\\?'), { json: { id: 2 } }],
  ['POST', re(P + '/_apis/git/repositories/repo-guid/pullRequests/', '\\d+/threads\\?'), { json: { id: 44 } }],
  ['PUT', re(P + '/_apis/git/repositories/repo-guid/pullRequests/', '\\d+/reviewers/' + ME + '\\?'), (req) => ({ json: { vote: req.body.vote } })],

  ['POST', re(P + '/_apis/wit/wiql?'), wiqlAnswer],
  ['POST', re(A + '/_apis/wit/workitemsbatch?'), (req) => ({ json: req.body.fields.includes('System.BoardColumn') ? ado.boardBatch : ado.batch })],
  ['GET', re(A + '/_apis/wit/workitems/', '\\d+\\?fields='), { json: { id: 95512, fields: { 'System.TeamProject': 'Side Quest' } } }],
  ['GET', re(A + '/_apis/wit/workitems/', '\\d+\\?api-version='), { json: ado.workItem }],
  ['PATCH', re(A + '/_apis/wit/workitems/', '\\d+\\?'), (req) => ({ json: { fields: Object.fromEntries(req.body.map((o) => [o.path.slice(8), o.value])) } })],
  ['GET', re(P + '/_apis/wit/workItems/', '\\d+/comments\\?'), { json: ado.comments }],
  ['POST', re(A + '/Side%20Quest/_apis/wit/workItems/', '\\d+/comments\\?'), { json: { id: 8 } }],

  ['GET', re(P + '/_apis/build/builds?requestedFor=' + ME + '&$top='), { json: ado.builds }],
  ['GET', re(P + '/_apis/build/builds?buildIds=501'), { json: ado.build501 }],
  ['GET', re(P + '/_apis/build/builds/500/timeline?'), { json: ado.timeline }],
  ['GET', re(P + '/_apis/build/builds/500/logs?'), { json: ado.logs }],
  ['GET', re(P + '/_apis/build/builds/500/logs/5?'), { text: 'line 1\nerror TS2304: boom\n' }],

  ['GET', re(T + '/_apis/work/boards/Stories?'), { json: ado.board }],
  ['GET', re(T + '/_apis/work/teamsettings/teamfieldvalues?'), { json: ado.area }],
];
