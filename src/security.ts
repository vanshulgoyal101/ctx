/**
 * SSRF protection: decide whether a caller-supplied URL is safe to fetch.
 *
 * `pack_docs` fetches ANY URL an agent passes in, so we must block private /
 * internal addresses (localhost, 192.168.x.x, cloud metadata endpoints) to
 * avoid Server-Side Request Forgery. We block literal private addresses and
 * obvious local hostnames — Workers can't do raw DNS lookups so DNS-rebinding
 * is out of scope for this personal tool.
 */

export interface UrlCheck {
  ok: boolean;
  reason?: string;
  url?: URL;
}

const BLOCKED_HOST_SUFFIXES = ['.local', '.internal', '.localhost'];
const BLOCKED_HOST_NAMES = new Set(['localhost', 'ip6-localhost', 'ip6-loopback']);

export function validateTargetUrl(input: string): UrlCheck {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: 'No URL provided' };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'That is not a valid URL' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'Only http and https URLs are allowed' };
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (BLOCKED_HOST_NAMES.has(host) || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    return { ok: false, reason: 'Refusing to fetch a local or internal address' };
  }

  if (isPrivateIpLiteral(host)) {
    return { ok: false, reason: 'Refusing to fetch a private or reserved IP address' };
  }

  return { ok: true, url };
}

/** True if `host` is an IP literal in a private/reserved/loopback range. */
export function isPrivateIpLiteral(host: string): boolean {
  const v4 = parseIpv4(host);
  if (v4) return isPrivateIpv4(v4);
  if (host.includes(':')) return isPrivateIpv6(host);
  return false;
}

function parseIpv4(host: string): [number, number, number, number] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    nums.push(n);
  }
  return nums as [number, number, number, number];
}

function isPrivateIpv4([a, b]: [number, number, number, number]): boolean {
  if (a === 10) return true; // 10.0.0.0/8   private
  if (a === 127) return true; // 127.0.0.0/8  loopback
  if (a === 0) return true; // 0.0.0.0/8    "this" network
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  return false;
}

function isPrivateIpv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === '::' || h === '::1') return true; // unspecified + loopback
  if (h.startsWith('fe80')) return true; // fe80::/10 link-local
  if (h.startsWith('fc') || h.startsWith('fd')) return true; // fc00::/7 unique-local
  const mapped = h.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) {
    const v4 = parseIpv4(mapped[1]);
    return v4 ? isPrivateIpv4(v4) : false;
  }
  return false;
}
