import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleRpc, MCP_SERVER_INFO, MCP_TOOL_NAMES } from '../src/mcp';
import { makeTarball, tarballResponse } from './tarball';
import { buildSite } from './site';

const FILES = {
  'README.md': '# Demo\n\nThis app handles authentication and sessions.',
  'src/index.ts': 'export const answer = 42;',
  'src/auth.ts': 'export function verifySession(token: string) {\n  return token.length > 0;\n}',
  'yarn.lock': 'lockfile', // skipped
};

async function stubRepo(): Promise<void> {
  const gz = await makeTarball(FILES);
  vi.stubGlobal('fetch', vi.fn(async () => tarballResponse(gz)));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleRpc — protocol', () => {
  it('initializes with protocol version and server info', async () => {
    const res = (await handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize' })) as any;
    expect(res.result.protocolVersion).toBe('2025-06-18');
    expect(res.result.serverInfo).toEqual(MCP_SERVER_INFO);
  });

  it('lists the four tools', async () => {
    const res = (await handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })) as any;
    expect(res.result.tools.map((t: { name: string }) => t.name)).toEqual(MCP_TOOL_NAMES);
    expect(MCP_TOOL_NAMES).toEqual(['pack_repo', 'search_context', 'list_files', 'get_file', 'pack_docs', 'search_docs']);
  });

  it('returns null for notifications', async () => {
    expect(await handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
  });

  it('rejects an unknown method', async () => {
    const res = (await handleRpc({ jsonrpc: '2.0', id: 3, method: 'nope' })) as any;
    expect(res.error.code).toBe(-32601);
  });
});

describe('handleRpc — tools/call', () => {
  it('pack_repo returns a packed bundle with headers', async () => {
    await stubRepo();
    const res = (await handleRpc({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'pack_repo', arguments: { repo: 'vanshul/demo' } },
    })) as any;
    const text: string = res.result.content[0].text;
    expect(text).toContain('# Repository: vanshul/demo@');
    expect(text).toContain('==== src/index.ts ====');
    expect(text).not.toContain('yarn.lock');
  });

  it('list_files lists included files with sizes', async () => {
    await stubRepo();
    const res = (await handleRpc({
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'list_files', arguments: { repo: 'vanshul/demo' } },
    })) as any;
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.files.map((f: { path: string }) => f.path)).toContain('src/auth.ts');
    expect(payload.count).toBe(3);
  });

  it('search_context returns ranked passages with file + line', async () => {
    await stubRepo();
    const res = (await handleRpc({
      jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'search_context', arguments: { repo: 'vanshul/demo', query: 'verifySession' } },
    })) as any;
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.count).toBeGreaterThan(0);
    expect(payload.matches[0].path).toBe('src/auth.ts');
  });

  it('get_file returns one file body', async () => {
    await stubRepo();
    const res = (await handleRpc({
      jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: { name: 'get_file', arguments: { repo: 'vanshul/demo', path: 'src/index.ts' } },
    })) as any;
    expect(res.result.content[0].text).toContain('answer = 42');
  });

  it('get_file on a missing path is a recoverable tool error', async () => {
    await stubRepo();
    const res = (await handleRpc({
      jsonrpc: '2.0', id: 8, method: 'tools/call',
      params: { name: 'get_file', arguments: { repo: 'vanshul/demo', path: 'nope.ts' } },
    })) as any;
    expect(res.result.isError).toBe(true);
  });

  it('an invalid repo is a recoverable tool error', async () => {
    const res = (await handleRpc({
      jsonrpc: '2.0', id: 9, method: 'tools/call',
      params: { name: 'pack_repo', arguments: { repo: 'not a repo' } },
    })) as any;
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/owner\/repo|repository/i);
  });

  it('search_context requires a query', async () => {
    const res = (await handleRpc({
      jsonrpc: '2.0', id: 10, method: 'tools/call',
      params: { name: 'search_context', arguments: { repo: 'vanshul/demo', query: '' } },
    })) as any;
    expect(res.result.isError).toBe(true);
  });

  it('pack_docs crawls a site and returns a docs bundle', async () => {
    const { base, fetchImpl } = buildSite('mcp1.example');
    vi.stubGlobal('fetch', fetchImpl);
    const res = (await handleRpc({
      jsonrpc: '2.0', id: 11, method: 'tools/call',
      params: { name: 'pack_docs', arguments: { url: `${base}/docs/`, depth: 1 } },
    })) as any;
    const text: string = res.result.content[0].text;
    expect(res.result.isError).toBeUndefined();
    expect(text).toContain(`# Docs: ${base}/docs/`);
    expect(text).toContain(`==== ${base}/docs/a ====`);
  });

  it('search_docs returns ranked passages from a site', async () => {
    const { base, fetchImpl } = buildSite('mcp2.example');
    vi.stubGlobal('fetch', fetchImpl);
    const res = (await handleRpc({
      jsonrpc: '2.0', id: 12, method: 'tools/call',
      params: { name: 'search_docs', arguments: { url: `${base}/docs/`, query: 'separator option' } },
    })) as any;
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.count).toBeGreaterThan(0);
    expect(payload.matches[0].path).toContain('/docs/b');
  });

  it('pack_docs refuses a private start URL', async () => {
    const res = (await handleRpc({
      jsonrpc: '2.0', id: 13, method: 'tools/call',
      params: { name: 'pack_docs', arguments: { url: 'http://127.0.0.1/docs' } },
    })) as any;
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/private or reserved|local or internal/i);
  });
});
