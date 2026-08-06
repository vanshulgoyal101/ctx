/**
 * Load a GitHub repository as a set of text files, ready to pack into agent
 * context. Fetches the repo tarball, gunzips it with the Workers-native
 * `DecompressionStream`, parses the tar in-process (no dependencies), and drops
 * binaries, lockfiles and build/noise directories.
 *
 * The input is always a fixed `owner/repo` slug we turn into a github.com URL —
 * never an arbitrary user URL — so there is no SSRF surface here.
 */

export interface RepoRef {
  owner: string;
  repo: string;
  ref?: string;
}

export interface RepoFile {
  path: string;
  text: string;
  bytes: number;
}

export interface RepoBundle {
  slug: string;
  owner: string;
  repo: string;
  ref: string;
  files: RepoFile[];
  truncated: boolean;
}

export interface LoadOptions {
  include?: string[];
  exclude?: string[];
}

export class RepoError extends Error {}

const MAX_UNCOMPRESSED = 60_000_000; // 60 MB of tar bytes
const MAX_FILE_BYTES = 512_000; // per text file
const MAX_FILES = 3_000;
const FETCH_TIMEOUT_MS = 20_000;
const USER_AGENT = 'Mozilla/5.0 (compatible; VanshulCtx/1.0; +https://ctx.vanshul.com)';

const LOCKFILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
  'bun.lockb', 'cargo.lock', 'poetry.lock', 'pipfile.lock', 'gemfile.lock',
  'composer.lock', 'go.sum', 'flake.lock',
]);

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.cache',
  'vendor', '__pycache__', '.venv', 'venv', 'coverage', '.idea', 'target',
  '.svelte-kit', '.turbo', '.parcel-cache',
]);

const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'tiff', 'avif', 'svg',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'mp4', 'mov', 'avi', 'webm', 'wav', 'flac', 'ogg',
  'zip', 'gz', 'tgz', 'tar', 'rar', '7z', 'jar', 'bz2', 'xz', 'zst',
  'exe', 'dll', 'so', 'dylib', 'bin', 'wasm', 'class', 'o', 'a', 'node',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'parquet', 'db', 'sqlite', 'lockb', 'ds_store',
]);

/** Parse "owner/repo", a github.com URL, or a `.../tree/<ref>` URL into parts. */
export function parseRepoSlug(input: string): RepoRef {
  const raw = input.trim();
  if (!raw) throw new RepoError('No repository provided');

  let owner: string | undefined;
  let repo: string | undefined;
  let ref: string | undefined;

  const urlLike = /github\.com[/:]/i.test(raw) || raw.startsWith('http');
  if (urlLike) {
    const cleaned = raw.replace(/^git@github\.com:/i, 'https://github.com/');
    let u: URL;
    try {
      u = new URL(cleaned.startsWith('http') ? cleaned : `https://${cleaned}`);
    } catch {
      throw new RepoError('That does not look like a GitHub repository URL');
    }
    const parts = u.pathname.replace(/^\/+/, '').split('/');
    [owner, repo] = parts;
    repo = repo?.replace(/\.git$/, '');
    if ((parts[2] === 'tree' || parts[2] === 'blob') && parts[3]) ref = parts[3];
  } else {
    const parts = raw.split('/');
    if (parts.length === 2 || parts.length === 3) {
      [owner, repo, ref] = parts;
    }
  }

  if (!owner || !repo || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) {
    throw new RepoError('Expected a repository as "owner/repo" or a github.com URL');
  }
  return { owner, repo, ref };
}

const cache = new Map<string, { at: number; bundle: RepoBundle }>();
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX = 8;

/** Load a repo's text files, using a short-lived per-isolate cache. */
export async function loadRepo(ref: RepoRef, opts: LoadOptions = {}): Promise<RepoBundle> {
  const key = `${ref.owner}/${ref.repo}@${ref.ref ?? 'default'}|${(opts.include ?? []).join(',')}|${(opts.exclude ?? []).join(',')}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.bundle;

  const { url } = tarballUrl(ref);
  const tar = await download(url);
  const entries = parseTar(tar);
  const bundle = filterEntries(ref, entries, opts);

  cache.set(key, { at: Date.now(), bundle });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return bundle;
}

function tarballUrl(ref: RepoRef): { url: string } {
  const base = `https://api.github.com/repos/${ref.owner}/${ref.repo}/tarball`;
  return { url: ref.ref ? `${base}/${encodeURIComponent(ref.ref)}` : base };
}

async function download(url: string): Promise<Uint8Array> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/vnd.github+json' },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (res.status === 404) throw new RepoError('Repository or ref not found (is it public?)');
    if (res.status === 403) throw new RepoError('GitHub rate limit hit — try again shortly');
    if (!res.ok) throw new RepoError(`GitHub returned ${res.status}`);
    if (!res.body) throw new RepoError('Empty response from GitHub');

    const gunzipped = res.body.pipeThrough(new DecompressionStream('gzip'));
    return await readAll(gunzipped, MAX_UNCOMPRESSED);
  } catch (e) {
    if (e instanceof RepoError) throw e;
    if (e instanceof Error && e.name === 'AbortError') throw new RepoError('GitHub download timed out');
    throw new RepoError(`Failed to download repository: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }
}

async function readAll(stream: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > max) {
        await reader.cancel();
        throw new RepoError('Repository is too large to pack');
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

interface TarEntry {
  name: string;
  data: Uint8Array;
  type: string;
}

/** Minimal tar reader: handles ustar, GNU long names ('L') and pax ('x') paths. */
function parseTar(buf: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
  let offset = 0;
  let longName: string | null = null;
  let paxName: string | null = null;

  while (offset + 512 <= buf.byteLength) {
    const header = buf.subarray(offset, offset + 512);
    if (isZeroBlock(header)) break;

    const size = parseOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 0x30);
    let name = readString(decoder, header, 0, 100);
    const prefix = readString(decoder, header, 345, 155);
    if (prefix) name = `${prefix}/${name}`;

    const dataStart = offset + 512;
    const data = buf.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / 512) * 512;

    if (type === 'L') {
      longName = decoder.decode(data).replace(/\0+$/, '');
      continue;
    }
    if (type === 'x') {
      paxName = parsePaxPath(decoder.decode(data));
      continue;
    }
    if (type === 'g') continue; // global pax header

    const finalName = paxName ?? longName ?? name;
    longName = null;
    paxName = null;

    if (type === '0' || type === '\0' || type === '') {
      entries.push({ name: finalName, data, type });
    }
  }
  return entries;
}

function filterEntries(ref: RepoRef, entries: TarEntry[], opts: LoadOptions): RepoBundle {
  const includes = (opts.include ?? []).map(globToRegExp);
  const excludes = (opts.exclude ?? []).map(globToRegExp);
  const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
  const files: RepoFile[] = [];
  let truncated = false;
  let resolvedRef = ref.ref ?? 'HEAD';

  for (const entry of entries) {
    // GitHub tarballs nest everything under "<owner>-<repo>-<sha>/".
    const slash = entry.name.indexOf('/');
    if (slash === -1) continue;
    if (!ref.ref && resolvedRef === 'HEAD') {
      const top = entry.name.slice(0, slash);
      const dash = top.lastIndexOf('-');
      if (dash !== -1) resolvedRef = top.slice(dash + 1);
    }
    const path = entry.name.slice(slash + 1);
    if (!path) continue;

    if (shouldSkip(path)) continue;
    if (excludes.some((re) => re.test(path))) continue;
    if (includes.length && !includes.some((re) => re.test(path))) continue;
    if (entry.data.byteLength > MAX_FILE_BYTES) continue;
    if (looksBinary(entry.data)) continue;

    files.push({ path, text: decoder.decode(entry.data), bytes: entry.data.byteLength });
    if (files.length >= MAX_FILES) {
      truncated = true;
      break;
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return { slug: `${ref.owner}/${ref.repo}`, owner: ref.owner, repo: ref.repo, ref: resolvedRef, files, truncated };
}

function shouldSkip(path: string): boolean {
  const segments = path.split('/');
  if (segments.some((s) => SKIP_DIRS.has(s))) return true;
  const base = segments[segments.length - 1].toLowerCase();
  if (LOCKFILES.has(base)) return true;
  if (/\.min\.(js|css)$/.test(base)) return true;
  if (base.endsWith('.map')) return true;
  const dot = base.lastIndexOf('.');
  const ext = dot === -1 ? '' : base.slice(dot + 1);
  if (BINARY_EXT.has(ext)) return true;
  return false;
}

function looksBinary(data: Uint8Array): boolean {
  const n = Math.min(data.byteLength, 8192);
  for (let i = 0; i < n; i++) if (data[i] === 0) return true;
  return false;
}

function isZeroBlock(block: Uint8Array): boolean {
  for (let i = 0; i < block.byteLength; i++) if (block[i] !== 0) return false;
  return true;
}

function parseOctal(buf: Uint8Array, start: number, len: number): number {
  let s = '';
  for (let i = start; i < start + len; i++) {
    const c = buf[i];
    if (c === 0 || c === 0x20) continue;
    s += String.fromCharCode(c);
  }
  const n = parseInt(s, 8);
  return Number.isFinite(n) ? n : 0;
}

function readString(decoder: TextDecoder, buf: Uint8Array, start: number, len: number): string {
  let end = start;
  const max = start + len;
  while (end < max && buf[end] !== 0) end++;
  return decoder.decode(buf.subarray(start, end));
}

function parsePaxPath(records: string): string | null {
  // Records look like: "<len> path=<value>\n"
  const m = records.match(/\d+ path=([^\n]*)\n/);
  return m ? m[1] : null;
}

/** Tiny glob → RegExp supporting `**`, `*` and `?`, matched against the full path. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`, 'i');
}
