import { describe, expect, it } from 'vitest';
import { normalizeLineEndings, stripFrontMatter } from './normalize';

describe('normalizeLineEndings', () => {
  it('converts CRLF to LF', () => {
    expect(normalizeLineEndings('a\r\nb\r\nc')).toBe('a\nb\nc');
  });

  it('leaves text with no CRLF unchanged', () => {
    expect(normalizeLineEndings('a\nb')).toBe('a\nb');
  });
});

describe('stripFrontMatter', () => {
  it('strips a well-formed front matter block', () => {
    const input = '---\ntitle: Refund Policy\ntags: [a, b]\n---\n# Heading\n\nBody.';
    expect(stripFrontMatter(input)).toBe('# Heading\n\nBody.');
  });

  it('accepts "..." as the closing delimiter', () => {
    const input = '---\ntitle: X\n...\nBody.';
    expect(stripFrontMatter(input)).toBe('Body.');
  });

  it('leaves text unchanged when there is no closing delimiter', () => {
    const input = '---\ntitle: X\n# Heading\nBody.';
    expect(stripFrontMatter(input)).toBe(input);
  });

  it('leaves text unchanged when it does not start with "---"', () => {
    const input = '# Heading\n\nBody.';
    expect(stripFrontMatter(input)).toBe(input);
  });

  it('handles a document that is only front matter', () => {
    const input = '---\ntitle: X\n---\n';
    expect(stripFrontMatter(input)).toBe('');
  });
});
