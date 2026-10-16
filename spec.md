# AD-0026: Easy MCP server connection, with a catalog that ships with the core

## Why

Valery wants to connect an MCP server, for example one for SSH work, in a few clicks: either from a list
that ships with the core, or by adding a new one. He was not sure what the core supports today. This
section answers that from the code (core at `ac40594`, the same rev `D:\agents\services\work-console`
vendors).

### What the core does today

A run's MCP servers are put together in `server/llm/sdk.ts` `mcpServers()`, in this order: `bridge`,
`run`, the runs' `browser`, then the workspace's own servers. The workspace's own servers come from one of
three places:

| Path | Where | How a person does it |
|---|---|---|
| `llm.mcp` in `workspaces/<id>/server.ts` | unmanaged workspaces | by editing code |
| `grants.json` `mcp` | managed workspaces such as agents-dev | Settings → Access → "Add a server": a name and a raw JSON config; or the workspace agent's `propose_grants`, accepted in Approvals |
| a pack with `kind: "mcp"` | managed workspaces | Settings → Packs → turn it on. `applyPackChange` copies the pack's `mcp` config into `grants.mcp[<pack>]`. A run can ask for it with `request_access {add: {packs: [...]}}` |

So the mechanism for a catalog already exists: an `mcp` pack (`server/bridge/packs.ts` `checkPack`,
`readPack`; `catalogView.ts`; tested in `packs.test.ts` and `catalogView.test.ts`). Core `packs/` is
vendored into every consumer by `sync-core.mjs`.

### What is missing

1. **No MCP server in the catalog.** `packs/` holds only browser packs (`azure-devops`, `m365-mail`,
   `m365-teams`, `telegram-web`) and `example`. No pack uses `kind: "mcp"`. agents-dev's `grants.json` has `"mcp": {}`.
2. **A connected server's tools are not allowed.** Sessions run with `permissionMode: 'dontAsk'`, and
   `allowedTools` is only `ALLOW` + `runTools` (`permissions()` in `sdk.ts`; Cursor's `canMcp` in
   `cursor/policy.ts` works the same way). Neither "Add a server" nor turning on an `mcp` pack adds
   `mcp__<name>__<tool>` to `runTools`. The server starts, but every call to it is refused. Today a person
   has to know to type `mcp__<name>` into "another tool name" as well, and that allows every tool,
   including the ones that write.
3. **No way to check a server before a run uses it.** Nothing starts the server and lists its tools. A server
   that fails to start does not show either: `sessionEvents` reads only `session_id` from the SDK's
   `init` message and ignores its `mcp_servers` statuses.
4. **An `mcp` pack takes no settings.** `checkPack` refuses `config` on an `mcp` pack, so a server that
   needs a value from the workspace (for example, a folder list) cannot be a catalog entry.
5. **Windows commands.** A catalog server is started by a launcher such as `npx`, which on Windows is
   `npx.cmd`. Node's `spawn` cannot start a `.cmd` file without a shell, so a plain `{"command": "npx"}`
   can fail to start on this machine. The runs' browser avoids this because it starts as
   `process.execPath` plus a script path. The first test confirms whether the SDK handles this case itself.
6. **Secrets.** `grants.json` is committed to git, so an `env` with a password would end up in git.
   Nothing warns about this.

## What changes

All of the following is generic core. Server names appear only under `packs/<name>/`, never in
`console/` or `schemas/`. Console tests use fictional servers.

```
packs/ssh/pack.json  kind mcp ──▶ Settings → Packs card: Check · tools (read ✓ / act ☐) · Turn on
                                   │ one grants commit: mcp.ssh + runTools mcp__ssh__<each ticked tool>
                                   ▼
run session ── mcpServers (Windows-safe command) ── tools allowed by runTools ── init status → run feed
```

### 1. The catalog: `mcp` packs under core `packs/`

- **`packs/ssh/`**: `ssh-mcp` pinned at `2.19.1` (npm, MIT, github.com/tufantunc/ssh-mcp). It is
  stdio, `{"command": "npx", "args": ["-y", "ssh-mcp@2.19.1"]}`. Hosts, users and keys live in that
  server's own `config.toml` (on Windows `%APPDATA%\ssh-mcp\config.toml`). The server checks that file's
  ACL, and passwords go in env vars or the SSH agent. The console therefore stores no host and no secret.
  `guide.md` (at most 2000 characters) tells the person how to write that file, and the run how to use the tools.
- **`packs/filesystem/`** (proposed second entry): `@modelcontextprotocol/server-filesystem`, pinned. It
  reads folders outside the run's work dir, and its `config` takes the folder list (see 2).
- Each catalog pack has a `test/` folder that checks `pack.json` and that its `tools` list matches a
  recorded `tools/list` of the pinned version. A version bump re-records that list.

### 2. The `mcp` pack manifest gains `tools` and `config`

- `tools: { read: string[], act?: string[] }`: the server's tool names, split by whether they change
  anything. `checkPack` refuses a name listed in both, and a pack with no `read`.
  - For ssh, `read` is `list-connections`, `list-sessions`, `read-command`, `read-session-output`,
    `sftp-list` and `sftp-download`.
  - For ssh, `act` is `open-session`, `close-session`, `run-command`, `privileged-command`,
    `sftp-upload`, `sftp-upload-file`, `sftp-download-file` and `signal-process`.
- `config` becomes allowed on an `mcp` pack, with the same `ConfigKey` rules as browser packs.
  `${config.<key>}` in `mcp.args`, `mcp.url` or `mcp.env` is filled in when the pack is turned on. A list
  key expands into several args. Settings → Packs already takes these values before turning a pack on.
- `checkPack` refuses an `env` or `headers` value in a pack that is a literal and looks like a secret
  (no placeholder). A pack may name a secret only as `${env:NAME}`. Whether this is allowed is open
  question 5. If it is not, v1 ships only servers that keep their secrets in their own config.

### 3. Turning a server on allows its read tools, and nothing more

- `applyPackChange` on: it adds `mcp.<pack>` and adds `mcp__<pack>__<t>` to `runTools` for each `read`
  tool. Off: it removes both. Per-tool ticks in the Packs card change the `runTools` entries of that pack only.
- `act` tools are listed in the card but cannot be ticked. A run that calls one is refused, as today. See
  open question 2 for opening them up.
- `applyAdd` (the run's `request_access` for packs) uses the same path, so a run that asks for `ssh` gets
  the read tools when Valery accepts.
- `grantsDiff` already names `+ mcp ssh` and `+ runTool mcp__ssh__read-command`, so the commit reason and
  the Approvals diff say exactly what is granted.

### 4. A new server added by hand gets the same treatment

- In Settings → Access → "Add a server", the person types a name and config, then presses **Check**. The
  card lists the server's tools from `tools/list`. Tools with `readOnlyHint` are ticked, and the others
  stay unticked. **Add** saves `mcp` and `runTools` in one `PUT /grants`, which `accessChangeIn` already
  takes both of. Before this change, a hand-added server got no tools.
- The **Check** button lets the person see the tools first. It does not guess which tools to allow.

### 5. Check: start a server, list its tools, stop it

- `server/mcp/check.ts`: `checkServer(config, {timeoutMs: 90_000})`. It starts the server with the same
  normalized command a run would use (see 6), sends `initialize` and `tools/list`, and stops it. It returns
  `{ok, tools: [{name, readOnly?, destructive?}], error?}`. `error` is the last 2 KB of stderr, passed
  through `scrub`. It uses `@modelcontextprotocol/sdk`'s client, which becomes a direct dependency (it is
  already installed through the agent SDK).
- `POST /api/ws/<id>/mcp/check {name}` checks a granted server, or a catalog pack with its settings
  filled in. `{config}` checks an unsaved one. Only the page calls it, never a run. Only one check runs at
  a time.
- The first `npx` run downloads the package, which is why the timeout is 90 s.

### 6. A Windows-safe command, and failures that show

- `mcpServers()` and Cursor's equivalent pass each own stdio server through `stdioCommand()`. On win32,
  a command found on `PATH` through `PATHEXT` as `.cmd` or `.bat` runs as `cmd.exe /d /s /c <cmd> <args>`.
  Every other command is left as it is.
- `sessionEvents` reads `init.mcp_servers`. For a server whose status is not `connected`, it yields one
  text line in the run's feed: "MCP server ssh did not start (failed)". The step's draft can then name
  the problem, instead of the run just lacking the tools.

### 7. The agent and the runs know the catalog

- The agent prompt and `request_access`'s description say that an MCP server comes as a catalog pack
  (`add.packs`), and list the `mcp` packs that are off. The run's `## Sources` already lists packs that
  are on, with `Server:`.

### Docs

- `docs/pack-authoring.md`: how to write an `mcp` pack (`tools`, `config`, pinning, no secrets, the recorded tools test).
- `docs/architecture.md`: the Grants and Access rows (tools come with a server; Check).

## How it will be proven

| Check | Where |
|---|---|
| `checkPack`: `tools` and `config` on an `mcp` pack, a tool in both lists, a missing `read`, a literal secret | `bridge/packs.test.ts` |
| on and off add and remove `mcp` and exactly the read `runTools`; a tick changes only that pack's tools; `request_access` for packs gets the same result | `catalogView.test.ts`, `access.test.ts` |
| `${config.x}` fills args, url and env; a list key expands | `bridge/packs.test.ts` |
| `stdioCommand`: `.cmd` wrapped on win32, `node` and absolute paths untouched, no change off win32 | `llm/sdk.test.ts`, `cursor/sdk.test.ts` |
| a session's init with a failed server yields one feed line | `llm/sdk.test.ts` |
| `checkServer` against a fixture stdio server (`.mjs`), a fixture HTTP server, one that exits, and one that hangs (timeout); a secret in stderr is scrubbed | `mcp/check.test.ts` |
| `packs/ssh` and `packs/filesystem`: manifest valid; `tools` equal the recorded `tools/list` | `node --test "packs/**/test/*.test.mjs"` |
| `npm test`, `npm run typecheck`, `npm run build && npm run smoke` all green; `core-lock.test.ts` green after sync | console |

**Deploy.** Merge to core master. Then `sync-core.mjs --to D:\agents\services\work-console`, commit
there, and restart the console. These go through the playbook's Merge and Deploy steps, with commands
approved there.

**End to end on agents-dev (the SSH check).**
1. Start a throwaway OpenSSH server in Docker on `127.0.0.1:2222` (Docker 28 runs here), with a
   throwaway ed25519 key in a temp folder. Nothing on the machine's own sshd changes.
2. Write an ssh-mcp profile `e2e` for that host and key (where it goes: open question 4).
3. Settings → Packs on agents-dev → ssh card → **Check**: 14 tools appear, 6 of them read. Take a screenshot.
4. Turn it on (Valery's click). Show the grants commit's diff: `+ pack ssh`, `+ mcp ssh`, and 6 `+ runTool` lines.
5. Run a test job whose run calls `list-connections`, then `read-command` with `uname -a` and
   `cat /etc/os-release`. Quote the output from the run's feed.
6. Have the run call `run-command`, and show that it is refused.
7. Stop the server (`docker stop` the container), start a run, and show the "did not start" line, or the
   tool's own error.
8. Remove the container, the key and the `e2e` profile. The pack stays on or goes off as Valery decides.

## Open questions (notes)

1. **Which "core".** I read "connect MCP servers to the agents platform" as the Work Console core: the
   catalog goes in `packs/`, reaches agents-dev and every console that vendors the core, and its runs get
   the tools. The Azure platform's own hosted servers (`mcp/*` behind API Management) are not part of this.
   They could become catalog entries later, as HTTP servers with OAuth. Is that right?
2. **SSH write tools.** CLAUDE.md says no run changes state in a tool, except the runs' browser and
   `llmActs`. `run-command` or `sftp-upload` on a remote host changes state there. v1 offers read tools
   only. Should an `act` tool be tickable later, as a third exception that you grant per workspace
   (with a CLAUDE.md change)?
3. **The rest of the catalog.** I propose ssh plus filesystem. Should anything else go in v1? A
   candidate is git, but `mcp-server-git` needs Python and `uvx`. Every entry has to start with no secret
   in `grants.json`.
4. **Where ssh-mcp's config lives.** By default it is `%APPDATA%\ssh-mcp\config.toml`, which is per user
   and outside the console, and its ACL check passes there. Is it OK for the e2e to add an `e2e` profile
   to that file and remove it afterwards? Or should the pack point ssh-mcp at a config under the console's
   home, if the server takes a path flag (not yet checked)? Which real host do you want after the e2e?
5. **Secrets for future servers.** Should a pack be allowed `${env:NAME}`, filled in from the console's
   environment when a session starts and never written to `grants.json`? Or should v1 keep only servers
   that hold their own secrets?
6. **Downloading on first start.** A pinned `npx -y pkg@ver` fetches from npm the first time it runs.
   That is our machine reaching a public registry, not a cloud of ours. The alternative is installing the
   packages into the console's home on Check. Which do you prefer?
