# Tool & API reference

JSON-RPC 2.0 over `POST https://ctx.vanshul.com/mcp` (MCP Streamable HTTP).
Also `GET /health`.

- Protocol version: `2025-06-18`
- Server info: `{ "name": "vanshul-ctx", "version": "1.0.0" }`

## Protocol methods

| Method | Notes |
| --- | --- |
| `initialize` | Protocol version, capabilities, server info, instructions. |
| `ping` | Returns `{}`. |
| `tools/list` | Lists the tools below with JSON Schemas. |
| `tools/call` | Runs a tool by `name` with `arguments`. |
| notifications (no `id`) | Accepted, answered with HTTP `202`, no body. |

Batches (arrays) are supported; notification entries produce no response.

## Common arguments

- `repo` *(required)* — `owner/repo`, `owner/repo/ref`, or a `github.com` URL.
- `ref` — branch, tag or commit SHA (defaults to the repo's default branch).
- `include` / `exclude` — arrays of globs (`**`, `*`, `?`) matched against the
  full file path. `include` keeps only matches; `exclude` drops matches. Build
  dirs, lockfiles and binaries are always dropped regardless.

## Tools

### `pack_repo`
Return the repo as one context blob.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `repo` | string | yes | Repo slug or URL. |
| `ref` | string | no | Branch/tag/SHA. |
| `include` / `exclude` | string[] | no | Globs. |
| `max_tokens` | number | no | Stop adding files once the estimate exceeds this. |

Output: a text blob — a header (`# Repository: owner/repo@ref`, file count) then
one `==== path ====` section per file, with a truncation note if capped.

### `search_context`
Return only the passages matching a query.

| Argument | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `repo` | string | yes | — | Repo slug or URL. |
| `query` | string | yes | — | Space-separated terms, case-insensitive. |
| `ref` / `include` / `exclude` | | no | — | As above. |
| `max_matches` | number | no | 5 | 1–50. |
| `context_chars` | number | no | 500 | Per-passage budget, 80–4000. |

Output JSON: `{ repo, ref, query, count, matches: [{ path, line, snippet, score }] }`.

### `list_files`
Output JSON: `{ repo, ref, count, truncated, files: [{ path, bytes }] }`.

### `get_file`
`{ repo, path, ref? }` → the full text of that file, or an `isError` result if
it's missing, binary, too large, or excluded.

## Errors

- **Protocol errors** use JSON-RPC codes: `-32700` parse, `-32600` invalid request,
  `-32601` method not found, `-32602` unknown tool, `-32603` internal.
- **Tool failures** (bad repo, 404, rate limit, missing file, repo too large) return
  a normal result with `isError: true` and a readable message, so the agent can recover.

## Examples

```sh
# Only the src/ TypeScript, as context
curl -s https://ctx.vanshul.com/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"pack_repo",
       "arguments":{"repo":"honojs/hono","include":["src/**/*.ts"],"exclude":["**/*.test.ts"],"max_tokens":12000}}}'

# Where is routing handled?
curl -s https://ctx.vanshul.com/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_context",
       "arguments":{"repo":"honojs/hono","query":"router match path","max_matches":3}}}'
```
