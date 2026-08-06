/**
 * Fetch a caller-supplied web page with hard limits: timeout, size cap, and
 * manual redirect following so every hop is re-validated against the SSRF
 * rules (a `redirect: 'follow'` could otherwise bounce an allowed URL to an
 * internal address like 127.0.0.1 or the cloud metadata endpoint).
 */

import { validateTargetUrl } from './security';

export const MAX_BYTES = 3_000_000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
const USER_AGENT = 'Mozilla/5.0 (compatible; VanshulCtx/1.0; +https://ctx.vanshul.com)';

export async function fetchPage(target: URL): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let current = target;
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      const res = await fetch(current.toString(), {
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
        redirect: 'manual',
        signal: controller.signal,
      });

      if (res.status < 300 || res.status >= 400) return res;

      const location = res.headers.get('location');
      if (!location) return res;

      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new Error('Redirect had an invalid Location header');
      }
      const check = validateTargetUrl(next.toString());
      if (!check.ok || !check.url) {
        throw new Error(`Refusing to follow redirect: ${check.reason ?? 'blocked target'}`);
      }
      current = check.url;
    }
    throw new Error('Too many redirects');
  } finally {
    clearTimeout(timer);
  }
}

/** Read the body but bail out if it exceeds `max` bytes. */
export async function readCapped(res: Response, max: number): Promise<string | null> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > max) return null;

  const reader = res.body?.getReader();
  if (!reader) {
    const buf = await res.arrayBuffer();
    if (buf.byteLength > max) return null;
    return new TextDecoder('utf-8').decode(buf);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > max) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8').decode(merged);
}
