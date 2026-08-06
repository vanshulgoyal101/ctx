import { describe, it, expect } from 'vitest';
import { validateTargetUrl, isPrivateIpLiteral } from '../src/security';

describe('validateTargetUrl', () => {
  it('accepts normal http/https URLs', () => {
    expect(validateTargetUrl('https://example.com/docs').ok).toBe(true);
    expect(validateTargetUrl('http://example.com').ok).toBe(true);
  });

  it('rejects empty, malformed and non-http input', () => {
    expect(validateTargetUrl('').ok).toBe(false);
    expect(validateTargetUrl('not a url').ok).toBe(false);
    expect(validateTargetUrl('ftp://example.com').ok).toBe(false);
    expect(validateTargetUrl('file:///etc/passwd').ok).toBe(false);
  });

  it('blocks localhost and internal hostnames', () => {
    expect(validateTargetUrl('http://localhost/').ok).toBe(false);
    expect(validateTargetUrl('http://api.internal/').ok).toBe(false);
    expect(validateTargetUrl('http://db.local/').ok).toBe(false);
  });

  it('blocks private and reserved IPs (SSRF)', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '169.254.169.254']) {
      expect(validateTargetUrl(`http://${ip}/`).ok).toBe(false);
    }
    expect(validateTargetUrl('http://[::1]/').ok).toBe(false);
  });
});

describe('isPrivateIpLiteral', () => {
  it('flags private/reserved ranges', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.31.255.255', '100.64.0.1', '::ffff:192.168.0.1', 'fe80::1']) {
      expect(isPrivateIpLiteral(ip)).toBe(true);
    }
  });
  it('passes public addresses', () => {
    expect(isPrivateIpLiteral('8.8.8.8')).toBe(false);
    expect(isPrivateIpLiteral('172.32.0.1')).toBe(false);
    expect(isPrivateIpLiteral('example.com')).toBe(false);
  });
});
