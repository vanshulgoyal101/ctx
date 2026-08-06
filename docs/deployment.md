# Deployment

`ctx` runs as a Cloudflare Worker with a custom domain at `ctx.vanshul.com`.

## Prerequisites

- A Cloudflare account (free plan is enough).
- `vanshul.com` managed as a Cloudflare zone (needed for the custom domain). Without
  it, deploy to a `*.workers.dev` subdomain instead.
- `npx wrangler login`.

## Configuration (`wrangler.toml`)

```toml
name = "vanshul-ctx"
main = "src/worker.ts"
compatibility_date = "2024-11-01"
compatibility_flags = ["nodejs_compat"]

[assets]
directory = "./public"

[[routes]]
pattern = "ctx.vanshul.com"
custom_domain = true
```

`nodejs_compat` is enabled but no npm packages are bundled — the tarball is
gunzipped with the runtime `DecompressionStream` and parsed in-process.

## Commands

```sh
cd ctx
npm install
npm run typecheck
npm test
npm run dev        # http://localhost:8787
npm run deploy
```

## Verify

```sh
curl -s https://ctx.vanshul.com/health
# {"ok":true,"server":{"name":"vanshul-ctx","version":"1.0.0"},"tools":[...]}

curl -s https://ctx.vanshul.com/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_files","arguments":{"repo":"octocat/Hello-World"}}}'
```

## Authentication (optional but recommended)

GitHub allows ~60 unauthenticated tarball requests/hour per IP — and a Worker's
egress IP is shared, so a busy deployment hits that quickly. Provide a GitHub
token as a **Worker secret** to lift the limit to 5,000/hour:

```sh
wrangler secret put GITHUB_TOKEN   # paste a fine-grained token with public-repo read
```

The token is read from `env.GITHUB_TOKEN` and sent as `Authorization: Bearer` on
GitHub requests. It is **never** accepted as a tool argument, so it can't leak to
an agent. With a token, ctx can also read private repos the token can access.

## Cost & limits

The Workers free plan (100k requests/day, ~10 ms CPU/request) is plenty for
personal use. Very large repos do more CPU work (gunzip + tar parse + pack); the
size/file caps in `github.ts` keep this bounded, and the Workers Paid plan raises
the CPU limit if ever needed.
