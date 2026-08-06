import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadRepo, parseRepoSlug, globToRegExp, RepoError } from '../src/github';
import { makeTarball, tarballResponse } from './tarball';

afterEach(() => {
  vi.restoreAllMocks();
});

const FILES = {
  'README.md': '# Demo\n\nHello world.',
  'src/index.ts': 'export const answer = 42;\n',
  'src/util/math.ts': 'export const add = (a: number, b: number) => a + b;\n',
  'package-lock.json': '{"lockfileVersion":3}', // lockfile → skipped
  'assets/logo.png': 'not really a png but .png ext', // binary ext → skipped
  'node_modules/dep/index.js': 'module.exports = 1;', // skip dir → skipped
  'bin/blob': new Uint8Array([1, 2, 0, 3, 4]), // NUL byte → binary → skipped
};

async function stubRepo(files = FILES, topdir?: string): Promise<void> {
  const gz = await makeTarball(files, topdir);
  vi.stubGlobal('fetch', vi.fn(async () => tarballResponse(gz)));
}

describe('parseRepoSlug', () => {
  it('parses owner/repo', () => {
    expect(parseRepoSlug('vanshul/demo')).toEqual({ owner: 'vanshul', repo: 'demo', ref: undefined });
  });
  it('parses owner/repo/ref', () => {
    expect(parseRepoSlug('vanshul/demo/main')).toMatchObject({ owner: 'vanshul', repo: 'demo', ref: 'main' });
  });
  it('parses a github.com URL with /tree/<ref>', () => {
    expect(parseRepoSlug('https://github.com/vanshul/demo/tree/dev')).toMatchObject({ owner: 'vanshul', repo: 'demo', ref: 'dev' });
  });
  it('strips a trailing .git', () => {
    expect(parseRepoSlug('git@github.com:vanshul/demo.git')).toMatchObject({ owner: 'vanshul', repo: 'demo' });
  });
  it('rejects nonsense', () => {
    expect(() => parseRepoSlug('not a repo')).toThrow(RepoError);
    expect(() => parseRepoSlug('')).toThrow(RepoError);
  });
});

describe('globToRegExp', () => {
  it('matches * within a path segment only', () => {
    expect(globToRegExp('src/*.ts').test('src/index.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/util/math.ts')).toBe(false);
  });
  it('matches ** across segments', () => {
    expect(globToRegExp('src/**/*.ts').test('src/util/math.ts')).toBe(true);
  });
});

describe('loadRepo', () => {
  it('returns text files and strips binaries/lockfiles/build dirs', async () => {
    await stubRepo();
    const bundle = await loadRepo({ owner: 'vanshul', repo: 'demo' });
    const paths = bundle.files.map((f) => f.path);
    expect(paths).toEqual(['README.md', 'src/index.ts', 'src/util/math.ts']);
    expect(paths).not.toContain('package-lock.json');
    expect(paths).not.toContain('assets/logo.png');
    expect(paths.some((p) => p.startsWith('node_modules'))).toBe(false);
  });

  it('resolves the ref from the tarball top directory', async () => {
    await stubRepo(FILES, 'owner-repo-abc123def');
    const bundle = await loadRepo({ owner: 'vanshul', repo: 'demo2' });
    expect(bundle.ref).toBe('abc123def');
  });

  it('applies include globs', async () => {
    await stubRepo();
    const bundle = await loadRepo({ owner: 'vanshul', repo: 'demo3' }, { include: ['src/**'] });
    expect(bundle.files.map((f) => f.path)).toEqual(['src/index.ts', 'src/util/math.ts']);
  });

  it('applies exclude globs', async () => {
    await stubRepo();
    const bundle = await loadRepo({ owner: 'vanshul', repo: 'demo4' }, { exclude: ['**/util/**'] });
    expect(bundle.files.map((f) => f.path)).toEqual(['README.md', 'src/index.ts']);
  });

  it('surfaces a 404 as a RepoError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    await expect(loadRepo({ owner: 'no', repo: 'such' })).rejects.toThrow(RepoError);
  });

  it('reads the real file contents', async () => {
    await stubRepo();
    const bundle = await loadRepo({ owner: 'vanshul', repo: 'demo5' });
    const idx = bundle.files.find((f) => f.path === 'src/index.ts');
    expect(idx?.text).toContain('answer = 42');
  });
});
