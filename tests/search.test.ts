import { describe, it, expect } from 'vitest';
import { searchFiles } from '../src/search';

const FILES = [
  { path: 'src/auth/session.ts', text: 'function createSession(user) {\n  return signToken(user.id);\n}\n\nfunction verifySession(token) {\n  return checkToken(token);\n}' },
  { path: 'src/math.ts', text: 'export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;' },
  { path: 'README.md', text: '# Demo\n\nThis project handles authentication and session tokens.' },
];

describe('searchFiles', () => {
  it('returns only blocks that match, ranked by score', () => {
    const matches = searchFiles(FILES, 'session token', 5);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].score).toBeGreaterThanOrEqual(matches[matches.length - 1].score);
    expect(matches.some((m) => m.path === 'src/auth/session.ts')).toBe(true);
  });

  it('reports a file path and a 1-based line number', () => {
    const matches = searchFiles(FILES, 'verifySession', 5);
    const hit = matches.find((m) => m.snippet.includes('verifySession'));
    expect(hit?.path).toBe('src/auth/session.ts');
    expect(hit?.line).toBe(5); // block starts at the verifySession function
  });

  it('respects the max_matches limit', () => {
    expect(searchFiles(FILES, 'a', 1).length).toBe(1);
  });

  it('returns nothing for an empty query', () => {
    expect(searchFiles(FILES, '   ')).toEqual([]);
  });

  it('windows long blocks around the first match with ellipses', () => {
    const long = { path: 'big.txt', text: 'padding '.repeat(200) + 'NEEDLE ' + 'tail '.repeat(200) };
    const [m] = searchFiles([long], 'NEEDLE', 1, 100);
    expect(m.snippet).toContain('NEEDLE');
    expect(m.snippet.length).toBeLessThanOrEqual(102);
    expect(m.snippet.startsWith('…') || m.snippet.endsWith('…')).toBe(true);
  });
});
