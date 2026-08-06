/**
 * Crawl a documentation site into agent-ready context.
 *
 * Breadth-first from a start URL, staying within the same origin and the start
 * path's top section (e.g. everything under `/docs`), extracting each page to
 * Markdown. Bounded by depth, page count, per-page size and a short-lived
 * per-isolate cache. SSRF-safe: every URL (and redirect hop) is re-validated.
 */

import { fetchPage, readCapped, MAX_BYTES } from './fetcher';
import { extract, extractLinks, ExtractionError } from './extract';
import { validateTargetUrl } from './security';
import { estimateTokens } from './pack';

export interface DocPage {
  url: string;
  title: string | null;
  markdown: string;
}

export interface DocsBundle {
  startUrl: string;
  pages: DocPage[];
  truncated: boolean;
}

export interface CrawlOptions {
  depth?: number;
  maxPages?: number;
}

export class DocsError extends Error {}

const DEFAULT_DEPTH = 1;
const MAX_DEPTH = 3;
const DEFAULT_MAX_PAGES = 10;
const HARD_MAX_PAGES = 30;
const ASSET_RE = /\.(png|jpe?g|gif|webp|svg|ico|pdf|zip|gz|tgz|mp4|mp3|css|js|json|xml|woff2?|ttf)(\?|#|$)/i;

const cache = new Map<string, { at: number; bundle: DocsBundle }>();
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX = 8;

export async function crawlDocs(startUrl: string, opts: CrawlOptions = {}): Promise<DocsBundle> {
  const depth = clamp(opts.depth ?? DEFAULT_DEPTH, 0, MAX_DEPTH);
  const maxPages = clamp(opts.maxPages ?? DEFAULT_MAX_PAGES, 1, HARD_MAX_PAGES);

  const start = validateTargetUrl(startUrl);
  if (!start.ok || !start.url) throw new DocsError(start.reason ?? 'Invalid URL');

  const key = `${start.url.toString()}|${depth}|${maxPages}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.bundle;

  const origin = start.url.origin;
  const sectionPrefix = topSection(start.url.pathname);

  const visited = new Set<string>([normalize(start.url.toString())]);
  const queue: Array<{ url: string; d: number }> = [{ url: start.url.toString(), d: 0 }];
  const pages: DocPage[] = [];
  let truncated = false;
  let isStart = true;

  while (queue.length && pages.length < maxPages) {
    const { url, d } = queue.shift()!;
    let result: { title: string | null; markdown: string | null; links: string[] };
    try {
      result = await fetchAndExtract(url);
    } catch (e) {
      if (isStart) throw e instanceof DocsError ? e : new DocsError(messageOf(e));
      continue; // a broken sub-page shouldn't sink the whole crawl
    } finally {
      isStart = false;
    }

    if (result.markdown) pages.push({ url, title: result.title, markdown: result.markdown });

    if (d < depth) {
      for (const link of result.links) {
        const norm = normalize(link);
        if (visited.has(norm)) continue;
        if (!inSection(link, origin, sectionPrefix) || ASSET_RE.test(link)) continue;
        visited.add(norm);
        queue.push({ url: link, d: d + 1 });
        if (visited.size > maxPages * 6) break; // bound queue growth
      }
    }
  }
  if (queue.length) truncated = true;

  const bundle: DocsBundle = { startUrl: start.url.toString(), pages, truncated };
  cache.set(key, { at: Date.now(), bundle });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return bundle;
}

async function fetchAndExtract(url: string): Promise<{ title: string | null; markdown: string | null; links: string[] }> {
  const check = validateTargetUrl(url);
  if (!check.ok || !check.url) throw new DocsError(check.reason ?? 'Invalid URL');

  const res = await fetchPage(check.url);
  if (!res.ok) throw new DocsError(`Upstream returned ${res.status}`);
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('html')) throw new DocsError(`Page is not HTML (got ${contentType || 'unknown'})`);

  const html = await readCapped(res, MAX_BYTES);
  if (html === null) throw new DocsError('Page is too large to process');

  const links = extractLinks(html, check.url.toString(), 300).map((l) => l.href);
  try {
    const article = extract(html, check.url.toString());
    return { title: article.title, markdown: article.markdown || null, links };
  } catch (e) {
    if (!(e instanceof ExtractionError)) throw e;
    return { title: htmlTitle(html), markdown: null, links }; // keep links, skip empty content
  }
}

export interface DocsPackResult {
  text: string;
  tokens: number;
  pages: number;
  totalPages: number;
  truncated: boolean;
}

export function packDocs(bundle: DocsBundle, maxTokens?: number): DocsPackResult {
  const budget = typeof maxTokens === 'number' && maxTokens > 0 ? Math.floor(maxTokens) : Infinity;
  const included: DocPage[] = [];
  let tokens = 0;
  let truncated = bundle.truncated;

  for (const page of bundle.pages) {
    const section = pageSection(page);
    const cost = estimateTokens(section);
    if (included.length > 0 && tokens + cost > budget) {
      truncated = true;
      break;
    }
    included.push(page);
    tokens += cost;
  }

  const header =
    `# Docs: ${bundle.startUrl}\n` +
    `# Pages (${included.length}${truncated ? ` of ${bundle.pages.length}` : ''}):\n` +
    included.map((p) => `#   ${p.url}`).join('\n') + '\n' +
    `# Generated by ctx.vanshul.com — agent-ready context\n`;

  const text = header + included.map(pageSection).join('');
  return { text, tokens: estimateTokens(text), pages: included.length, totalPages: bundle.pages.length, truncated };
}

function pageSection(page: DocPage): string {
  const title = page.title ? `# ${page.title}\n` : '';
  return `\n==== ${page.url} ====\n${title}${page.markdown.trim()}\n`;
}

/** The first path segment as a section prefix (`/docs/x` → `/docs`); `` for root. */
function topSection(pathname: string): string {
  const seg = pathname.split('/').filter(Boolean)[0];
  return seg ? `/${seg}` : '';
}

function inSection(url: string, origin: string, prefix: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.origin !== origin) return false;
  return prefix === '' || u.pathname === prefix || u.pathname.startsWith(`${prefix}/`);
}

function normalize(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return url;
  }
}

function htmlTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
