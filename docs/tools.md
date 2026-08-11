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

Output: a text blob — a header (`# Repository: owner/repo@ref`, a file manifest of
the included paths) then one `==== path ====` section per file, with a truncation
note if capped by `max_tokens`.

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

### `pack_docs`
Crawl a documentation site and return it as one context blob.

| Argument | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `url` | string | yes | — | Absolute `http(s)` URL to start crawling from. |
| `depth` | number | no | 1 | Link hops to follow (0–3). |
| `max_pages` | number | no | 10 | Pages to fetch (1–30). |
| `max_tokens` | number | no | — | Stop adding pages once the estimate exceeds this. |

The crawl stays within the start URL's **origin and top section** (e.g. everything
under `/docs`). It is **sitemap-aware**: if the site publishes `sitemap.xml`, the
in-section URLs it lists are crawled too (more complete than link-following alone).
Each page is extracted to Markdown; pages with no readable content are skipped but
still contribute links. Output: a header (start URL + page manifest) then one
`==== <page url> ====` section per page.

### `search_docs`
Crawl a docs site and return only the passages matching a query.

| Argument | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `url` | string | yes | — | Start URL. |
| `query` | string | yes | — | Space-separated terms, case-insensitive. |
| `depth` / `max_pages` | number | no | 1 / 10 | As above. |
| `max_matches` | number | no | 5 | 1–50. |
| `context_chars` | number | no | 500 | Per-passage budget, 80–4000. |

Output JSON: `{ startUrl, query, count, matches: [{ path, line, snippet, score }] }`
where `path` is the page URL.

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
