/**
 * Model Context Protocol (MCP) over Streamable HTTP for ctx.vanshul.com.
 *
 * JSON-RPC 2.0 over a single POST endpoint: `initialize`, `ping`, `tools/list`
 * and `tools/call`. Tools turn a GitHub repo into agent-ready context.
 *
 * Spec: https://modelcontextprotocol.io  ·  Protocol version 2025-06-18.
 */

import { loadRepo, parseRepoSlug, RepoError, type LoadOptions, type RepoBundle } from './github';
import { packRepo } from './pack';
import { searchFiles } from './search';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER = { name: 'vanshul-ctx', version: '1.0.0' };

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>, ctx: RpcContext) => Promise<string>;
}

/** Per-request context. `token` is a GitHub token from a Worker secret — never a tool argument. */
export interface RpcContext {
  token?: string;
}

class ToolError extends Error {}

const repoProp = { type: 'string', description: 'A GitHub repo as "owner/repo" or a github.com URL.' };
const refProp = { type: 'string', description: 'Optional branch, tag or commit SHA (defaults to the default branch).' };
const globProp = { type: 'array', items: { type: 'string' }, description: 'Optional glob patterns (support **, *, ?).' };

const TOOLS: ToolDef[] = [
  {
    name: 'pack_repo',
    description:
      'Fetch a GitHub repository and return it as one agent-ready context blob: text files concatenated with clear "==== path ====" headers, binaries/lockfiles/build dirs stripped, with a token estimate. Use include/exclude globs to focus, and max_tokens to fit a budget.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: repoProp,
        ref: refProp,
        include: globProp,
        exclude: globProp,
        max_tokens: { type: 'number', description: 'Stop adding files once the estimate exceeds this many tokens.' },
      },
      required: ['repo'],
    },
    async run(args, ctx) {
      const bundle = await load(args, ctx);
      const maxTokens = typeof args.max_tokens === 'number' ? args.max_tokens : undefined;
      const result = packRepo(bundle, { maxTokens });
      const note = result.truncated
        ? `\n\n(Truncated: included ${result.files} of ${result.totalFiles} files, ~${result.tokens} tokens.)`
        : '';
      return result.text + note;
    },
  },
  {
    name: 'search_context',
    description:
      'Search a GitHub repository and return only the passages that match a query — each with its file path, line number and a relevance score. Far more token-efficient than pack_repo when you need a specific detail (e.g. "where is auth handled?").',
    inputSchema: {
      type: 'object',
      properties: {
        repo: repoProp,
        query: { type: 'string', description: 'Space-separated search terms; matching is case-insensitive.' },
        ref: refProp,
        include: globProp,
        exclude: globProp,
        max_matches: { type: 'number', description: 'Max passages to return (1–50, default 5).' },
        context_chars: { type: 'number', description: 'Per-passage character budget (80–4000, default 500).' },
      },
      required: ['repo', 'query'],
    },
    async run(args, ctx) {
      if (typeof args.query !== 'string' || args.query.trim() === '') {
        throw new ToolError('The "query" argument is required and must be a non-empty string.');
      }
      const bundle = await load(args, ctx);
      const maxMatches = typeof args.max_matches === 'number' ? args.max_matches : undefined;
      const contextChars = typeof args.context_chars === 'number' ? args.context_chars : undefined;
      const matches = searchFiles(bundle.files, args.query, maxMatches, contextChars);
      return JSON.stringify({ repo: bundle.slug, ref: bundle.ref, query: args.query, count: matches.length, matches }, null, 2);
    },
  },
  {
    name: 'list_files',
    description:
      'List the text files ctx would include for a repository (after stripping binaries, lockfiles and build dirs), with their byte sizes. Cheap way for an agent to see the layout before packing.',
    inputSchema: {
      type: 'object',
      properties: { repo: repoProp, ref: refProp, include: globProp, exclude: globProp },
      required: ['repo'],
    },
    async run(args, ctx) {
      const bundle = await load(args, ctx);
      const files = bundle.files.map((f) => ({ path: f.path, bytes: f.bytes }));
      return JSON.stringify({ repo: bundle.slug, ref: bundle.ref, count: files.length, truncated: bundle.truncated, files }, null, 2);
    },
  },
  {
    name: 'get_file',
    description: 'Return the full text of a single file in a repository, by path. Use after list_files or search_context to drill in.',
    inputSchema: {
      type: 'object',
      properties: { repo: repoProp, path: { type: 'string', description: 'File path within the repo.' }, ref: refProp },
      required: ['repo', 'path'],
    },
    async run(args, ctx) {
      if (typeof args.path !== 'string' || !args.path.trim()) {
        throw new ToolError('The "path" argument is required.');
      }
      const bundle = await load(args, ctx);
      const target = args.path.replace(/^\.?\//, '');
      const file = bundle.files.find((f) => f.path === target);
      if (!file) throw new ToolError(`No text file at "${target}" (it may be binary, too large, or excluded).`);
      return file.text;
    },
  },
];

function toGlobs(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string' && value.trim()) return [value];
  return undefined;
}

async function load(args: Record<string, unknown>, ctx: RpcContext): Promise<RepoBundle> {
  if (typeof args.repo !== 'string') throw new ToolError('The "repo" argument is required and must be a string.');
  let ref;
  try {
    ref = parseRepoSlug(args.repo);
  } catch (e) {
    throw new ToolError(e instanceof RepoError ? e.message : 'Invalid repository');
  }
  if (typeof args.ref === 'string' && args.ref.trim()) ref.ref = args.ref.trim();
  const opts: LoadOptions = { include: toGlobs(args.include), exclude: toGlobs(args.exclude) };
  return loadRepo(ref, opts, ctx.token);
}

/** Handle one JSON-RPC message; returns the response object, or null for notifications. */
export async function handleRpc(message: unknown, ctx: RpcContext = {}): Promise<object | null> {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return err(null, -32600, 'Invalid Request: expected a JSON-RPC object');
  }
  const { id, method, params } = message as JsonRpcRequest;

  if (id === undefined || id === null) return null;
  if (typeof method !== 'string') return err(id, -32600, 'Invalid Request: "method" must be a string');

  try {
    switch (method) {
      case 'initialize':
        return ok(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER,
          instructions: 'Tools to turn a GitHub repo into agent-ready context. Pass a repo as "owner/repo" or a github.com URL.',
        });

      case 'ping':
        return ok(id, {});

      case 'tools/list':
        return ok(id, {
          tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        });

      case 'tools/call': {
        const name = (params?.name as string) ?? '';
        const args = (params?.arguments as Record<string, unknown>) ?? {};
        const tool = TOOLS.find((t) => t.name === name);
        if (!tool) return err(id, -32602, `Unknown tool: ${name}`);
        try {
          const text = await tool.run(args, ctx);
          return ok(id, { content: [{ type: 'text', text }] });
        } catch (e) {
          const message = e instanceof ToolError || e instanceof RepoError ? e.message : messageOf(e);
          return ok(id, { content: [{ type: 'text', text: `Error: ${message}` }], isError: true });
        }
      }

      default:
        return err(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    return err(id, -32603, messageOf(e));
  }
}

function ok(id: JsonRpcRequest['id'], result: unknown): object {
  return { jsonrpc: '2.0', id, result };
}
function err(id: JsonRpcRequest['id'], code: number, message: string): object {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const MCP_SERVER_INFO = SERVER;
export const MCP_TOOL_NAMES = TOOLS.map((t) => t.name);
