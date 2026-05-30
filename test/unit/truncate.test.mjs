import { describe, it, expect } from 'vitest';
import { truncateHeadTail, countHunks } from '../../scripts/lib/truncate.mjs';

const KB = 1024;

describe('countHunks', () => {
  it('returns 0 for empty string', () => {
    expect(countHunks('')).toBe(0);
  });

  it('returns 0 for non-null nullish input', () => {
    expect(countHunks(/** @type {any} */ (null))).toBe(0);
  });

  it('counts hunk headers', () => {
    const diff = '@@ -1,3 +1,4 @@\n context\n+added\n@@ -10,2 +11,2 @@\n more\n';
    expect(countHunks(diff)).toBe(2);
  });

  it('counts a single hunk', () => {
    expect(countHunks('@@ -1,1 +1,1 @@\n')).toBe(1);
  });
});

describe('truncateHeadTail', () => {
  it('returns empty string for null/undefined', () => {
    expect(truncateHeadTail(null)).toBe('');
    expect(truncateHeadTail(undefined)).toBe('');
    expect(truncateHeadTail('')).toBe('');
  });

  it('returns text verbatim when under cap', () => {
    const text = 'small diff\n';
    expect(truncateHeadTail(text)).toBe(text);
  });

  it('returns text verbatim when exactly at cap (no marker)', () => {
    const text = 'x'.repeat(200 * KB);
    const result = truncateHeadTail(text);
    expect(result).toBe(text);
    expect(result).not.toContain('omitted');
  });

  it('truncates with marker when over cap', () => {
    // Use configurable small caps so we can control exactly what's in head vs tail
    // head=20 bytes, tail=20 bytes, total cap=40
    // text: "AAAA...BBBB...CCCC..." where each section is 30 chars
    const text = 'A'.repeat(30) + 'B'.repeat(30) + 'C'.repeat(30); // 90 bytes
    const result = truncateHeadTail(text, { headBytes: 20, tailBytes: 20 });
    expect(result).toContain('…');
    expect(result.startsWith('AAAAAAAAAAAAAAAAAAAA')).toBe(true);
    expect(result.endsWith('CCCCCCCCCCCCCCCCCCCC')).toBe(true);
  });

  it('uses generic marker when no hunks are omitted (hunk count is not positive)', () => {
    // Text over cap but no hunk headers — marker should fall back to generic
    const text = 'a'.repeat(201 * KB);
    const result = truncateHeadTail(text);
    expect(result).toContain('… [diff truncated] …');
  });

  it('head+tail sizes are configurable', () => {
    const text = 'x'.repeat(100);
    const result = truncateHeadTail(text, { headBytes: 10, tailBytes: 10 });
    expect(result).toContain('…');
    expect(result.startsWith('xxxxxxxxxx')).toBe(true);
    expect(result.endsWith('xxxxxxxxxx')).toBe(true);
  });

  it('advertises exact omitted hunk count in marker', () => {
    // Each hunk header is "@@ -N,1 +N,1 @@\n" = 17 bytes.
    // With headBytes=17 and tailBytes=17, the head catches hunk1, tail catches
    // hunk3, and hunk2 is entirely in the omitted middle.
    const H = (/** @type {number} */ n) => `@@ -${n},1 +${n},1 @@\n`; // 17 bytes each
    const text = H(1) + H(2) + H(3); // 51 bytes, cap=34
    const result = truncateHeadTail(text, { headBytes: 17, tailBytes: 17 });
    expect(result).toMatch(/\[1 hunks omitted\]/);
  });
});
