# Features — ctx.vanshul.com (MCP server)

> **TL;DR** — Capability catalog: ✅ shipped, 🔜 proposed, ⛔ non-goal. A public MCP
> server (Cloudflare Worker) that turns a **GitHub repo or docs site into
> agent-ready context** — pack it, or search it for only the relevant passages.

**Legend:** ✅ shipped · 🔜 proposed/potential · ⛔ deliberate non-goal.

## MCP tools (✅ shipped)

| Tool | Returns |
|------|---------|
| `pack_repo` | the repo as one context blob (`==== path ====` headers) + token estimate |
| `search_context` | only the passages matching a query, each with file, line, score |
| `list_files` | the text files ctx would include, with byte sizes |
| `get_file` | the full text of one file |
| `pack_docs` | a crawled docs site as one blob (each page → Markdown) |
| `search_docs` | only the docs passages matching a query, each with page URL + line |

`repo` = `owner/repo`, `owner/repo/ref`, or a `github.com` URL.

## Platform (✅)

- ✅ **Cloudflare Worker**, JSON-RPC 2.0 (MCP) at `POST /mcp`; `GET /health`
  (`{ ok, tools }`).
- ✅ **Repo pipeline** — fetch tarball, gunzip, parse tar, filter files, **in-process
  with zero dependencies**; token counting + include/exclude globs + `max_tokens`.
- ✅ **Docs pipeline** — crawl + extract via Mozilla Readability + Turndown.
- ✅ Rate limiting + CORS; **listed in the MCP Registry** (`io.github.vanshulgoyal101/ctx`).
- ✅ Bridged for stdio clients via `npx mcp-remote`.

## Proposed / potential 🔜

- More source types (e.g. private repos via token, non-GitHub hosts); caching of
  packed repos; per-language smarter chunking for `search_*`.

## Non-goals ⛔

- **LLM/synthesis** — ctx returns raw context + matches; reasoning is the agent's job.
- **Statefulness** — each call is independent; no stored user data.
