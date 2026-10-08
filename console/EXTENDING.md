# Extending a Work Console

How a workspace grows in a console folder that vendors the core (it has `core.lock.json`). Written for
the workspace agent and for a person editing by hand; both keep to the same lines.

## Where each change goes

| Change | Where | Gate |
|---|---|---|
| pack, board rule, playbooks, templates, demo data | `workspaces/<id>/page.ts` | checks pass |
| config defaults, pack settings, source, plugins | `workspaces/<id>/server.ts` | checks pass |
| UI: act handlers, panels, dialogs | `workspaces/<id>/ui.tsx` | checks pass, the build |
| a workspace's own logic and its tests | `workspaces/<id>/*.ts`, `*.test.ts` | checks pass |
| a helper several workspaces share | `tools/**` | every workspace's checks pass |
| packs, hosts, acts, run tools, MCP servers | `workspaces/<id>/grants.json` | the person's Accept |
| addresses, database, ports | `config.json` in the console's home | the person, by hand |

*The workspace agent changes `workspaces/<id>/**` and `tools/**` only; anything that widens what a
workspace may reach waits for the person in Approvals.*

## Never touched

- Core files: everything `core.lock.json` lists. The drift test fails on an edit, and the next
  update refuses to sync over it. A core change is made in the core repo and arrives by update.
- `core.lock.json` itself.
- `grants.json`: written only by an accepted grants change (`propose_grants`).
- The registries `workspaces/page.ts` and `workspaces/server.ts`: only `install.mjs` and
  `create_workspace` add a line.
- Another workspace's folder.

Workspace code may not import `child_process`, `net`, `http`, `https`, `http2`, `dgram`, `tls`,
`worker_threads`, `cluster`, `vm` or `module`, compute an import name, or use a global `fetch`,
`WebSocket`, `XMLHttpRequest` or `EventSource` (`server/agent/imports.ts`). It reaches the outside
through its ctx.

## The ctx API

A plugin gets `PluginCtx` (`server/workspace.ts`):

| Field | What it is |
|---|---|
| `id`, `cfg` | the workspace id; its config: `server.ts` `defaults` under `workspaces.<id>` of `config.json` |
| `home`, `artifactsDir` | the console's home; where run artifacts are kept |
| `jobs` | `all()`, `get(id)`, `create(newJob)`, `cmd(id, command)` |
| `source` | `available()`, `concepts()`, `read([concept])`, `get(concept, id)` over the granted packs |
| `http(url, init)` | `fetch` limited to `grants.hosts`; every redirect hop is checked (`guardedHttp`) |

- A plugin never calls `source.act`: an act runs from the page through `/api/act`, after the
  person confirms it.
- A plugin's routes answer under `/api/ws/<id>/<path>`; its `state()` lands in `/api/state` as
  `ws.<id>.plugins.<name>`, which the page holds as `LIVE.ws[<id>].plugins.<name>`.

## Patterns

Each pattern names the test that proves it. Tests sit beside the code as `workspaces/<id>/*.test.ts`
or `tools/**/*.test.ts`; `npm test` runs them, and `check` runs the workspace's and `tools/`'s with the drift
and registry tests, not the rest of the core's. A test that needs a folder takes it from `tempDir()` of
`server/testdirs.ts`, which removes it when the test file's process exits.

### UI section

```
 ui.tsx   Mount: () => S.ws === '<id>' ? <Panel /> : null      acts: { '<act>': { run(j) {…} } }
 view.ts  the panel's logic as plain functions
```

*`Mount` renders for every workspace, so it shows only while its own is open. Act names are
declared in `page.ts` `acts` and are unique across the console.*

- Test: the functions in `view.ts` on fixed input; `node --test` does not load `.tsx`, so the
  component itself is covered by `npm run typecheck` and the build.

### Auto filter

```
 filter.ts   needsMe(items, me) => items that match the rule          pure, no I/O
 server.ts   plugins: (x) => [{ name: 'triage', routes: [['GET', /^\/triage$/,
               async () => needsMe((await x.source.read(['mail'])).mail.items, ME)]] }]
```

*The rule decides on its own which items matter; the page shows what the route answers and the
person acts on it.*

- Test: `needsMe` on items shaped by `schemas/mail.item.schema.json`, matching and not.

### Playbook

```
 page.ts   playbooks: { 'my-review': { ws: '<id>', n: 'Review', ph: [
             { c: 'RV', n: 'Review', s: [ { id: 'rv1', t: 'Read it', m: 'llm', x: 'Notes written' },
                                          { id: 'rv2', t: 'Decide', m: 'you', x: 'Decided' } ] } ] } }
           board: { start: 'my-review', … }
```

*Playbook and step ids are unique across the console, and none repeats a core playbook's id.*

- Test: `checkWorkspaces([server])` passes, and `install([{ page }])` then `PB0['my-review']` has
  the steps.

### Pack config

```
 grants.json   packs ['azure-devops']  hosts ['dev.azure.com']           via propose_grants
 server.ts     defaults: { packConfig: { 'azure-devops': { org: 'my-org', project: 'Web' } } }
```

*A setting the person must choose stays out of the code: leave it to `config.json`
`workspaces.<id>.packConfig` and tell them which key.*

- Test: `grantedPacks(grantsFrom(grants)(cfg))` from `server/browser/packs.ts` has no problems for
  the workspace's `defaults`.

### Plugin route

```
 server.ts   plugins: (x) => [{ name: 'notes', routes: [['POST', /^\/notes\/([a-z0-9-]+)$/,
               async (r) => save(r.p[0], await r.body())]], state: () => ({ count }) }]
```

*`r.p` holds the path's capture groups and `r.q` the query; what the route returns is the JSON
answer. Throw `HttpError` (`server/events.ts`) for an answer the person should read; any other
error is a 500 that only the log explains.*

- Test: call the route's function with a `PluginReq` built in the test and a ctx whose `source`,
  `jobs` and `http` are stubs; assert the answer and the calls made.

## After a core update

An update that fails its checks leaves the folder as it was and the new core on a branch
`update/<sha>` in a worktree. The page offers Reintegrate: the workspace agent gets the failing
output and the core's diff, fixes the workspace there under the same limits, and applies; the
update then merges and restarts. Give up drops the branch.
