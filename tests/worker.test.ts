import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/worker';
import { makeTarball, tarballResponse } from './tarball';

afterEach(() => {
  vi.restoreAllMocks();
});

function rpc(body: unknown, ip = '203.0.113.1'): Request {
  return new Request('https://ctx.test/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify(body),
  });
}

describe('worker routing', () => {
  it('GET /health reports ok, server and tools', async () => {
    const res = await worker.fetch(new Request('https://ctx.test/health'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.tools).toContain('pack_repo');
  });

  it('answers CORS preflight with nosniff', async () => {
    const res = await worker.fetch(new Request('https://ctx.test/mcp', { method: 'OPTIONS' }));
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('rejects non-POST on /mcp', async () => {
    const res = await worker.fetch(new Request('https://ctx.test/mcp', { method: 'GET' }));
    expect(res.status).toBe(405);
  });

  it('returns a parse error for invalid JSON', async () => {
    const res = await worker.fetch(new Request('https://ctx.test/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.2' },
      body: '{ bad',
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32700);
  });

  it('handles tools/list end to end', async () => {
    const res = await worker.fetch(rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, '203.0.113.3'));
    expect(res.status).toBe(200);
    expect((await res.json()).result.tools.length).toBe(6);
  });

  it('returns 202 for a notification', async () => {
    const res = await worker.fetch(rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, '203.0.113.4'));
    expect(res.status).toBe(202);
  });

  it('threads GITHUB_TOKEN from env to GitHub as a Bearer header', async () => {
    const gz = await makeTarball({ 'README.md': '# hi' });
    const fetchMock = vi.fn(async () => tarballResponse(gz));
    vi.stubGlobal('fetch', fetchMock);
    await worker.fetch(
      rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'list_files', arguments: { repo: 'vanshul/demo' } } }, '203.0.113.8'),
      { GITHUB_TOKEN: 'env-secret' },
    );
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer env-secret');
  });

  it('rate-limits a noisy IP with a Retry-After header', async () => {
    let last: Response | undefined;
    for (let i = 0; i < 32; i++) {
      last = await worker.fetch(rpc({ jsonrpc: '2.0', id: i, method: 'ping' }, '198.51.100.7'));
    }
    expect(last?.status).toBe(429);
    expect(Number(last?.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('returns 404 for unknown paths', async () => {
    expect((await worker.fetch(new Request('https://ctx.test/nope'))).status).toBe(404);
  });
});
