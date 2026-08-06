/**
 * Turn a messy HTML page into clean content for AI agents.
 *
 * Pipeline (deterministic — no LLM):
 *   1. Parse HTML into a DOM (linkedom — runs in the Workers runtime).
 *   2. Mozilla Readability finds the main article, dropping nav/ads/footers.
 *   3. Turndown converts the cleaned article HTML to compact Markdown.
 *
 * Also exposes `extractLinks` for crawling.
 */

import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';

export interface ExtractResult {
  title: string | null;
  byline: string | null;
  siteName: string | null;
  excerpt: string | null;
  markdown: string;
  wordCount: number;
}

export interface PageLink {
  text: string;
  href: string;
}

export class ExtractionError extends Error {}

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});

export function extract(html: string, sourceUrl: string): ExtractResult {
  const { document } = parseHTML(injectBase(html, sourceUrl));

  type ReadabilityDoc = ConstructorParameters<typeof Readability>[0];
  const article = new Readability(document as unknown as ReadabilityDoc).parse();

  if (!article || !article.content) {
    throw new ExtractionError('Could not find readable article content on that page');
  }

  // Turndown parses HTML strings via a global DOMParser/`document`, which the
  // Workers runtime doesn't have. Build a detached node from the linkedom
  // document instead and hand that to Turndown — that path clones the node and
  // needs no global document.
  const container = document.createElement('div');
  container.innerHTML = article.content;
  const markdown = turndown
    .turndown(container as unknown as Parameters<typeof turndown.turndown>[0])
    .trim();

  return {
    title: article.title ?? null,
    byline: article.byline ?? null,
    siteName: article.siteName ?? null,
    excerpt: article.excerpt ?? null,
    markdown,
    wordCount: countWords(markdown),
  };
}

/** All absolute http(s) links on the page, de-duplicated, with anchor text. */
export function extractLinks(html: string, sourceUrl: string, limit = 200): PageLink[] {
  const { document } = parseHTML(injectBase(html, sourceUrl));
  const seen = new Set<string>();
  const out: PageLink[] = [];
  const anchors = document.querySelectorAll('a[href]') as unknown as Iterable<{
    getAttribute(name: string): string | null;
    textContent: string | null;
  }>;
  for (const a of Array.from(anchors)) {
    const raw = a.getAttribute('href') ?? '';
    let parsed: URL;
    try {
      parsed = new URL(raw, sourceUrl);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
    parsed.hash = '';
    const abs = parsed.toString();
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push({ text: (a.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 120), href: abs });
    if (out.length >= limit) break;
  }
  return out;
}

function injectBase(html: string, sourceUrl: string): string {
  const baseTag = `<base href="${escapeAttr(sourceUrl)}">`;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => `${m}${baseTag}`);
  }
  return `${baseTag}${html}`;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function countWords(text: string): number {
  const words = text.match(/\S+/g);
  return words ? words.length : 0;
}
