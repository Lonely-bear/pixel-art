import { describe, expect, it } from 'vitest';
import { normalizeAttachUrl } from '../src/attach.js';

describe('normalizeAttachUrl', () => {
  it('keeps a fully-qualified endpoint untouched', () => {
    expect(normalizeAttachUrl('http://127.0.0.1:7331/mcp')).toBe('http://127.0.0.1:7331/mcp');
  });

  it('assumes http and /mcp for a bare host:port', () => {
    expect(normalizeAttachUrl('127.0.0.1:7331')).toBe('http://127.0.0.1:7331/mcp');
    expect(normalizeAttachUrl('localhost:7331/')).toBe('http://localhost:7331/mcp');
  });

  it('preserves an explicit custom path', () => {
    expect(normalizeAttachUrl('http://host:1234/custom')).toBe('http://host:1234/custom');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeAttachUrl('  127.0.0.1:7331  ')).toBe('http://127.0.0.1:7331/mcp');
  });

  it('rejects an empty target', () => {
    expect(() => normalizeAttachUrl('')).toThrow(/requires a URL/);
    expect(() => normalizeAttachUrl('   ')).toThrow(/requires a URL/);
  });
});
