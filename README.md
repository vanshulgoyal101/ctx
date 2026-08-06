# ctx.vanshul.com

A public **Model Context Protocol (MCP)** server, running as a Cloudflare
Worker, that turns a **GitHub repository into agent-ready context**. Point an AI
agent at it and it can pack a whole repo into one token-counted blob — or search
the repo and get back only the relevant passages, each with its file and line.

It's the agent-first companion to [`mcp/`](../mcp): where `mcp` reads the live
web, `ctx` reads code. Zero runtime dependencies — the tarball is fetched,
gunzipped and parsed in-process.

## Endpoint

```
POST https://ctx.vanshul.com/mcp     # JSON-RPC 2.0 (MCP)
GET  https://ctx.vanshul.com/health  # { ok: true, tools: [...] }
```

## Tools

| Tool | Input | Returns |
| --- | --- | --- |
| `pack_repo` | `{ repo, ref?, include?, exclude?, max_tokens? }` | The repo as one context blob with `==== path ====` headers + token estimate |
| `search_context` | `{ repo, query, ref?, include?, exclude?, max_matches?, context_chars? }` | Only the passages matching `query`, each with file, line and score |
| `list_files` | `{ repo, ref?, include?, exclude? }` | JSON: the text files ctx would include, with byte sizes |
| `get_file` | `{ repo, path, ref? }` | The full text of a single file |

`repo` is `owner/repo`, `owner/repo/ref`, or a `github.com` URL.

## Connect from an MCP client

```json
{ "mcpServers": { "ctx": { "url": "https://ctx.vanshul.com/mcp" } } }
```

Stdio-only clients bridge with `npx mcp-remote https://ctx.vanshul.com/mcp`.

## Try it with curl

```sh
# Pack a repo, capped to 8000 tokens
curl -s https://ctx.vanshul.com/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"pack_repo","arguments":{"repo":"sindresorhus/slugify","max_tokens":8000}}}'

# Search a repo for just the relevant passages
curl -s https://ctx.vanshul.com/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call",
       "params":{"name":"search_context","arguments":{"repo":"sindresorhus/slugify","query":"replace separator"}}}'
```

## Layout

```
ctx/
├── src/
│   ├── worker.ts     # entry: routes /mcp, /health, rate limit, CORS
│   ├── mcp.ts        # JSON-RPC dispatch + the four tool definitions
│   ├── github.ts     # fetch tarball, gunzip, parse tar, filter files (no deps)
│   ├── pack.ts       # assemble the context blob + token estimate
│   └── search.ts     # ranked passage search over files (file + line)
├── public/
│   ├── index.html    # landing page (served for non-API paths)
│   ├── og.png / og.svg
│   ├── robots.txt
│   └── sitemap.xml
├── tests/            # vitest: github (tar parsing), pack, search, mcp, worker
├── docs/             # architecture, tools/API reference, deployment
├── wrangler.toml
├── package.json
└── tsconfig.json
```

## Develop & deploy

```sh
cd ctx
npm install
npm run typecheck
npm test           # vitest — full suite
npm run dev        # local worker at http://localhost:8787  (POST /mcp)
npm run deploy     # wrangler deploy
```

## How it works

```
owner/repo → github.com tarball → DecompressionStream('gzip')
           → in-process tar parse → drop binaries/lockfiles/build dirs
           → pack (concat + token estimate) OR search (ranked passages)
```

The GitHub URL is always constructed from a fixed `owner/repo` slug, so there is
no SSRF surface. Downloads are bounded (timeout, uncompressed size cap, per-file
and file-count caps) and results are cached per-isolate for a few minutes.

## Security & limits

- **No SSRF:** input is a repo slug, not an arbitrary URL; only github.com is fetched.
- **Bounded:** 20s download timeout, ~60 MB uncompressed cap, 512 KB/file, ≤3000 files, per-IP rate limit.
- **Stateless & private:** public repos only, no code stored, no LLM in the loop.

## Documentation

- [docs/architecture.md](docs/architecture.md) — modules, pipeline, tar parsing, limits
- [docs/tools.md](docs/tools.md) — full tool & JSON-RPC API reference
- [docs/deployment.md](docs/deployment.md) — Cloudflare Worker + custom-domain deploy

## License

[MIT](./LICENSE) © Vanshul Goyal
