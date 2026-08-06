import { afterEach, describe, expect, it, vi } from 'vitest';
import { crawlDocs, packDocs, DocsError } from '../src/docs';
import { searchFiles } from '../src/search';
import { buildSite } from './site';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('crawlDocs', () => {
  it('crawls the start page and same-section links at depth 1', async () => {
    const { base, fetchImpl } = buildSite('t1.example');
    vi.stubGlobal('fetch', fetchImpl);
    const bundle = await crawlDocs(`${base}/docs/`, { depth: 1 });
    const urls = bundle.pages.map((p) => p.url);
    expect(urls).toContain(`${base}/docs/a`);
    expect(urls).toContain(`${base}/docs/b`);
    // depth 2 page not reached at depth 1
    expect(urls).not.toContain(`${base}/docs/c`);
  });

  it('stays within the same origin and section', async () => {
    const { base, fetchImpl } = buildSite('t2.example');
    vi.stubGlobal('fetch', fetchImpl);
    const bundle = await crawlDocs(`${base}/docs/`, { depth: 1 });
    const urls = bundle.pages.map((p) => p.url);
    expect(urls.some((u) => u.includes('/blog/'))).toBe(false); // other section
    expect(urls.some((u) => u.includes('other.example'))).toBe(false); // other origin
  });

  it('follows an extra hop at depth 2', async () => {
    const { base, fetchImpl } = buildSite('t3.example');
    vi.stubGlobal('fetch', fetchImpl);
    const bundle = await crawlDocs(`${base}/docs/`, { depth: 2 });
    expect(bundle.pages.map((p) => p.url)).toContain(`${base}/docs/c`);
  });

  it('respects max_pages and marks truncated', async () => {
    const { base, fetchImpl } = buildSite('t4.example');
    vi.stubGlobal('fetch', fetchImpl);
    const bundle = await crawlDocs(`${base}/docs/`, { depth: 1, maxPages: 2 });
    expect(bundle.pages.length).toBe(2);
    expect(bundle.truncated).toBe(true);
  });

  it('does not fetch each page more than once', async () => {
    const { base, fetchImpl } = buildSite('t5.example');
    vi.stubGlobal('fetch', fetchImpl);
    await crawlDocs(`${base}/docs/`, { depth: 2 });
    const urls = fetchImpl.mock.calls.map((c) => (typeof c[0] === 'string' ? c[0] : String(c[0])));
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('refuses a private/internal start URL (SSRF)', async () => {
    await expect(crawlDocs('http://127.0.0.1/docs')).rejects.toThrow(DocsError);
    await expect(crawlDocs('http://localhost/')).rejects.toThrow(DocsError);
  });

  it('throws if the start page cannot be fetched', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    await expect(crawlDocs('https://gone.example/docs/')).rejects.toThrow(DocsError);
  });
});

describe('packDocs', () => {
  it('produces a header with page URLs and one section per page', async () => {
    const { base, fetchImpl } = buildSite('t6.example');
    vi.stubGlobal('fetch', fetchImpl);
    const bundle = await crawlDocs(`${base}/docs/`, { depth: 1 });
    const result = packDocs(bundle);
    expect(result.text).toContain(`# Docs: ${base}/docs/`);
    expect(result.text).toContain(`==== ${base}/docs/a ====`);
    expect(result.pages).toBeGreaterThan(0);
  });

  it('honours a token budget', async () => {
    const { base, fetchImpl } = buildSite('t7.example');
    vi.stubGlobal('fetch', fetchImpl);
    const bundle = await crawlDocs(`${base}/docs/`, { depth: 2 });
    const result = packDocs(bundle, 60);
    expect(result.truncated).toBe(true);
    expect(result.pages).toBeLessThan(bundle.pages.length);
  });
});

describe('search over crawled docs', () => {
  it('finds the passage matching a query', async () => {
    const { base, fetchImpl } = buildSite('t8.example');
    vi.stubGlobal('fetch', fetchImpl);
    const bundle = await crawlDocs(`${base}/docs/`, { depth: 1 });
    const pages = bundle.pages.map((p) => ({ path: p.url, text: p.markdown }));
    const matches = searchFiles(pages, 'separator option', 3);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].path).toContain('/docs/b');
  });
});
