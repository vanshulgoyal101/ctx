import { describe, it, expect } from 'vitest';
import { estimateTokens, packRepo } from '../src/pack';
import type { RepoBundle } from '../src/github';

function bundle(files: { path: string; text: string }[]): RepoBundle {
  return {
    slug: 'owner/repo',
    owner: 'owner',
    repo: 'repo',
    ref: 'main',
    files: files.map((f) => ({ ...f, bytes: f.text.length })),
    truncated: false,
  };
}

describe('estimateTokens', () => {
  it('is roughly chars/4', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });
});

describe('packRepo', () => {
  it('includes a header and one section per file', () => {
    const result = packRepo(bundle([
      { path: 'a.ts', text: 'const a = 1;' },
      { path: 'b.ts', text: 'const b = 2;' },
    ]));
    expect(result.text).toContain('# Repository: owner/repo@main');
    expect(result.text).toContain('==== a.ts ====');
    expect(result.text).toContain('==== b.ts ====');
    expect(result.files).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.tokens).toBeGreaterThan(0);
  });

  it('lists the included files in a manifest header', () => {
    const result = packRepo(bundle([
      { path: 'a.ts', text: 'const a = 1;' },
      { path: 'dir/b.ts', text: 'const b = 2;' },
    ]));
    expect(result.text).toContain('# Files (2):');
    expect(result.text).toContain('#   a.ts');
    expect(result.text).toContain('#   dir/b.ts');
  });

  it('stops at the token budget and marks truncated', () => {
    const big = 'x'.repeat(4000); // ~1000 tokens each
    const result = packRepo(bundle([
      { path: 'a.ts', text: big },
      { path: 'b.ts', text: big },
      { path: 'c.ts', text: big },
    ]), { maxTokens: 1200 });
    expect(result.truncated).toBe(true);
    expect(result.files).toBeLessThan(3);
    expect(result.text).toContain('==== a.ts ====');
  });

  it('always includes at least the first file even if over budget', () => {
    const result = packRepo(bundle([{ path: 'a.ts', text: 'x'.repeat(8000) }]), { maxTokens: 1 });
    expect(result.files).toBe(1);
  });
});
