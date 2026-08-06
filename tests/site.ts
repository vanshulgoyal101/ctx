import { vi } from 'vitest';

/** A doc page with a nav of links and a substantial article body (so Readability keeps it). */
export function docPage(title: string, body: string, links: string[] = []): string {
  const nav = links.map((h) => `<a href="${h}">${h}</a>`).join(' ');
  const para = `<p>${`${body} This page explains ${title} in careful detail with enough prose to read as real content. `.repeat(6)}</p>`;
  return `<!doctype html><html><head><title>${title}</title></head><body>` +
    `<nav>${nav}</nav><article><h1>${title}</h1>${para}</article></body></html>`;
}

/**
 * Build a small docs site under a unique host and a fetch stub that serves it.
 * Using a unique host per test avoids the crawl cache leaking across tests.
 */
export function buildSite(host: string, extra: Record<string, string> = {}) {
  const base = `https://${host}`;
  const pages: Record<string, string> = {
    [`${base}/docs/`]: docPage('Home', 'Welcome to the documentation.', ['/docs/a', '/docs/b', '/blog/x', 'https://other.example/z']),
    [`${base}/docs/a`]: docPage('Routing', 'The router matches a path to a handler.', ['/docs/c']),
    [`${base}/docs/b`]: docPage('Config', 'Configuration uses a separator option.', []),
    [`${base}/docs/c`]: docPage('Deep', 'A deeply nested page reached at depth two.', []),
    [`${base}/blog/x`]: docPage('Blog', 'A blog post outside the docs section.', []),
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [`${base}${k}`, v])),
  };
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const html = pages[url] ?? pages[url.replace(/\/$/, '')] ?? null;
    if (html === null) return new Response('not found', { status: 404 });
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  });
  return { base, fetchImpl };
}
