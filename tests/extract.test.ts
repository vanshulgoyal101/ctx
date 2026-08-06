import { describe, it, expect } from 'vitest';
import { extract, extractLinks, ExtractionError } from '../src/extract';

const ARTICLE = `
<!doctype html>
<html>
  <head><title>Page Title Tag</title></head>
  <body>
    <nav><a href="/">Home</a> <a href="/about">About</a></nav>
    <article>
      <h1>The Real Headline</h1>
      <p>This is the first substantial paragraph of the article with enough words to
         look like genuine body content rather than navigation or boilerplate text.</p>
      <p>Here is a second paragraph with a <a href="/rel">relative link</a> and more
         readable prose to reinforce that this is the main content of the page.</p>
    </article>
    <script>console.log('junk');</script>
  </body>
</html>`;

describe('extract', () => {
  it('keeps the article body and drops nav/scripts', () => {
    const result = extract(ARTICLE, 'https://example.com/post');
    expect(result.markdown).toContain('first substantial paragraph');
    expect(result.markdown).not.toContain('junk');
  });

  it('resolves relative links to absolute', () => {
    const result = extract(ARTICLE, 'https://example.com/post');
    expect(result.markdown).toContain('https://example.com/rel');
  });

  it('throws ExtractionError when there is no readable content', () => {
    expect(() => extract('<html><body></body></html>', 'https://example.com')).toThrow(ExtractionError);
  });
});

describe('extractLinks', () => {
  it('returns absolute http(s) links, de-duplicated, without fragments', () => {
    const html = '<a href="/a#top">A</a><a href="/a">A again</a><a href="mailto:x@y.z">mail</a><a href="https://ok.example/b">B</a>';
    const links = extractLinks(html, 'https://example.com/');
    const hrefs = links.map((l) => l.href);
    expect(hrefs).toContain('https://example.com/a');
    expect(hrefs).toContain('https://ok.example/b');
    expect(hrefs.some((h) => h.startsWith('mailto:'))).toBe(false);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});
