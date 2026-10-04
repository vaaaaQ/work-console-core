# Writing a pack

A pack is one directory: `pack.json` plus one script. The script is a single function, and the
carrier evaluates it in a signed-in tab of the tool. `packs/example/` is a worked pack for Jira
`work`. Copy it.

```mermaid
flowchart LR
  gw[Gateway] -->|call| carrier[Carrier]
  carrier -->|"(script)(call)"| tab[Tab on the tool's host]
  tab -->|fetch, credentials: include| api[Tool's own web API]
  tab -->|"{ok, data} | {ok:false, code}"| carrier --> gw
```
*The script runs as the page and uses the tab's own session. It never sees or returns a token.*

## pack.json

```json
{
  "name": "example",
  "zone": "UTC",
  "script": "example.js",
  "tabs": { "jira": { "match": "^https://[a-z0-9-]+\\.atlassian\\.net/", "open": "https://your-site.atlassian.net/jira/your-work" } },
  "concepts": { "work": { "tab": "jira", "interval": 30, "cap": 100 } },
  "actions": { "work.comment": { "tab": "jira", "concept": "work" } }
}
```

| Field | Meaning |
|---|---|
| `tabs.<name>.match` | Regex over the tab URL. The carrier runs the script only in a matching tab |
| `tabs.<name>.open` | Where to open the tab when no tab matches |
| `concepts.<c>.interval` | Seconds between reads |
| `concepts.<c>.cap` | Max items kept |
| `actions.<a>.concept` | Which concept to re-read after the act |

## The call

```js
async function (call, env) { ... }   // env is injected only by tests
```

| `call.verb` | Also has | Return `data` |
|---|---|---|
| `read` | `concept`, `watch`, `zone`, `now` | an array of items (`<concept>.item` schema) |
| `get` | `concept`, `id` | one detail (`<concept>.get` schema) |
| `act` | `action`, `args` | the act's result, small |

`watch` maps a concept to the ids that jobs follow. A read includes them even when they don't
match the pack's default query. A get-only concept, such as `image`, answers a read with `[]`.

## Errors

Return `{ok:false, code, message, retryAfter?}` and never throw out of the function.

| Code | When |
|---|---|
| `blank` | The tab has not rendered yet |
| `unauthorized` | 401 or 403, a sign-in host, or an HTML page where JSON was expected |
| `rate_limited` | 429, with `retryAfter` in seconds |
| `not_found` | 404 |
| `bad_args` | An unknown verb or concept, or invalid args. Check before any request |
| `source_error` | Anything else that surely did not change the source |
| `unknown` | Something failed after a write went out, so the outcome is unknown |

## Rules

- Check the tab's host for every concept and action, so the script never acts on a sign-in page.
- Validate every id against a strict regex before it reaches a URL or a query (`KEY` in the example).
- Scrub tokens from every message (`scrub`).
- Return times as ISO UTC. The `zone` field is for display only.
- Keep the script self-contained, with no imports. The carrier serializes it.

## Tests

`packs/example/test/` runs the script in Node against a fake tab:

- `harness.mjs` provides a routed `fetch` that records each request, plus `location` and `document`.
- `validate.mjs` is a small JSON-schema check against `schemas/`.

```bash
node --test "packs/**/test/*.test.mjs"
```

Each concept needs at least these tests: one item passes the schema, the watched ids are honored,
injection is dropped, and an error envelope is covered.
