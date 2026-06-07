import { describe, expect, it } from 'vitest';
import { chunkText, normalizeForChunking } from '@/lib/rag/kb-chunker';

// STAQPRO-148 — quality gate for the custom chunker. The unit-test suite
// is what justifies skipping langchain-text-splitters (per Plan agent's
// stress-test). If a regression here breaks paragraph preservation or
// overlap correctness, retrieval recall on KB docs will silently degrade.

describe('normalizeForChunking', () => {
  it('strips null bytes', () => {
    expect(normalizeForChunking('hello\0world')).toBe('helloworld');
  });

  it('normalizes CRLF and CR to LF', () => {
    expect(normalizeForChunking('a\r\nb\rc')).toBe('a b c');
  });

  it('preserves paragraph breaks (double-newline) but collapses other whitespace', () => {
    const input = 'paragraph one\nstill one.\n\nparagraph   two\twith\ttabs.';
    expect(normalizeForChunking(input)).toBe(
      'paragraph one still one.\n\nparagraph two with tabs.',
    );
  });

  it('drops empty paragraphs', () => {
    expect(normalizeForChunking('a\n\n\n\n\n\nb')).toBe('a\n\nb');
  });

  it('returns empty string on whitespace-only input', () => {
    expect(normalizeForChunking('   \n\n   \t\t   \n')).toBe('');
  });
});

describe('chunkText', () => {
  it('returns empty array for empty input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n   ')).toEqual([]);
  });

  it('produces a single chunk when input fits under chunkChars', () => {
    const text = 'short doc, one paragraph, fits easily.';
    const chunks = chunkText(text, { chunkChars: 200, overlapChars: 20 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].index).toBe(0);
    expect(chunks[0].text).toBe(text);
  });

  it('packs paragraphs greedily until they would exceed chunkChars', () => {
    // Three 30-char paragraphs; with chunkChars=70 they pack as 2+1.
    const p = (n: number) => `para ${n} ${'x'.repeat(20)}`; // 28 chars each
    const text = `${p(1)}\n\n${p(2)}\n\n${p(3)}`;
    const chunks = chunkText(text, { chunkChars: 70, overlapChars: 0 });
    expect(chunks).toHaveLength(2);
    expect(chunks[0].text).toContain('para 1');
    expect(chunks[0].text).toContain('para 2');
    expect(chunks[1].text).toContain('para 3');
  });

  it('falls back to fixed-size splits within a single oversized paragraph', () => {
    const huge = 'a'.repeat(500);
    const chunks = chunkText(huge, { chunkChars: 100, overlapChars: 0 });
    expect(chunks.length).toBeGreaterThanOrEqual(5);
    // Each chunk should be at most chunkChars in length (no overlap pre-flush
    // means exactly chunkChars; later chunks include some overlap).
    expect(chunks[0].text.length).toBeLessThanOrEqual(100);
  });

  it('emits sequential indices starting from 0', () => {
    const text = Array.from({ length: 10 }, (_, i) => `paragraph ${i} ${'x'.repeat(80)}`).join(
      '\n\n',
    );
    const chunks = chunkText(text, { chunkChars: 200, overlapChars: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c, i) => {
      expect(c.index).toBe(i);
    });
  });

  it('overlap appears at the start of subsequent chunks', () => {
    // Two distinct paragraphs that won't fit together. Chunker should put
    // each in its own chunk, with the second chunk prefixed by overlap from
    // the first.
    const para1 = `${'AAAA '.repeat(30).trim()}`; // ~150 chars
    const para2 = `${'BBBB '.repeat(30).trim()}`; // ~150 chars
    const text = `${para1}\n\n${para2}`;
    const chunks = chunkText(text, { chunkChars: 160, overlapChars: 40 });
    expect(chunks).toHaveLength(2);
    expect(chunks[0].text.startsWith('AAAA')).toBe(true);
    expect(chunks[1].text).toContain('AAAA'); // overlap from chunk 0
    expect(chunks[1].text).toContain('BBBB');
  });

  it('throws on invalid options', () => {
    expect(() => chunkText('x', { chunkChars: 0 })).toThrow(/chunkChars/);
    expect(() => chunkText('x', { chunkChars: 100, overlapChars: -1 })).toThrow(/overlapChars/);
    expect(() => chunkText('x', { chunkChars: 100, overlapChars: 100 })).toThrow(/overlapChars/);
  });
});
