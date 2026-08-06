import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPage, readCapped } from '../src/fetcher';

function html(body = '<html><body>ok</body></html>', status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html' } });
}
function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchPage — redirect re-validation (SSRF)', () => {
  it('returns the response for a direct 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => html()));
    expect((await fetchPage(new URL('https://example.com/'))).status).toBe(200);
  });

  it('refuses to follow a redirect to a private IP', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('example.com') ? redirect('http://127.0.0.1/admin') : html('secret'),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchPage(new URL('https://example.com/start'))).rejects.toThrow(/redirect/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a redirect to the cloud metadata endpoint', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('example.com') ? redirect('http://169.254.169.254/latest/') : html('token'),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchPage(new URL('https://example.com/start'))).rejects.toThrow(/redirect/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('follows a safe public redirect', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('start.example.com') ? redirect('https://final.example.com/p') : html('<html><body>final</body></html>'),
    );
    vi.stubGlobal('fetch', fetchMock);
    const res = await fetchPage(new URL('https://start.example.com/go'));
    expect(await res.text()).toContain('final');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws after too many redirects', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => redirect(`https://example.com/hop${n++}`)));
    await expect(fetchPage(new URL('https://example.com/loop'))).rejects.toThrow(/too many redirects/i);
  });
});

describe('readCapped', () => {
  it('returns the body when under the cap', async () => {
    expect(await readCapped(new Response('hello'), 1000)).toBe('hello');
  });
  it('returns null when Content-Length exceeds the cap', async () => {
    const res = new Response('x'.repeat(100), { headers: { 'content-length': '100' } });
    expect(await readCapped(res, 50)).toBeNull();
  });
  it('returns null when a streamed body exceeds the cap', async () => {
    const chunk = new Uint8Array(1024);
    const stream = new ReadableStream({ pull(c) { c.enqueue(chunk); } });
    expect(await readCapped(new Response(stream), 2048)).toBeNull();
  });
});
