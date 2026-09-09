import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown, safeHref } from './markdown';

const text = (s: string) => ({ kind: 'text', text: s });

describe('parseInline', () => {
  it('reads the two things the assistant actually writes', () => {
    // Straight from a seeded transcript, which is what the reader complained about.
    expect(parseInline('**Draft filed:** ORD → MCO')).toEqual([
      { kind: 'bold', text: 'Draft filed:' },
      text(' ORD → MCO'),
    ]);
  });

  it('handles code and italics without eating the surrounding words', () => {
    expect(parseInline('set `FLIGHT_PROVIDER` or *nothing* happens')).toEqual([
      text('set '),
      { kind: 'code', text: 'FLIGHT_PROVIDER' },
      text(' or '),
      { kind: 'italic', text: 'nothing' },
      text(' happens'),
    ]);
  });

  it('leaves a lone asterisk alone rather than inventing emphasis', () => {
    expect(parseInline('2 * 3 = 6')).toEqual([text('2 * 3 = 6')]);
  });

  it('keeps an unclosed marker literal', () => {
    expect(parseInline('**not closed')).toEqual([text('**not closed')]);
  });
});

describe('links', () => {
  it('allows our own screens, http(s) and mailto', () => {
    expect(safeHref('/travel/abc')).toBe('/travel/abc');
    expect(safeHref('https://example.test')).toBe('https://example.test');
    expect(safeHref('mailto:a@b.test')).toBe('mailto:a@b.test');
  });

  it('refuses anything that would execute, and protocol-relative', () => {
    // An anchor is the one thing on the transcript that *does* something, and
    // model output is the least trusted text in this app.
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('  JavaScript:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,<script>')).toBeNull();
    expect(safeHref('//evil.test')).toBeNull();
  });

  it('renders a refused link as the literal token, never a half of it', () => {
    // Not `click` alone: the href pattern stops at the first `)`, so dropping
    // the href would leave a stray bracket — a mangled version of the thing we
    // just refused. Nothing here becomes an anchor, which is the point.
    const spans = parseInline('[click](javascript:alert(1))');
    expect(spans.every((s) => s.kind === 'text')).toBe(true);
    expect(spans.map((s) => s.text).join('')).toBe('[click](javascript:alert(1))');
  });

  it('does render a good link, including one to our own screens', () => {
    expect(parseInline('open [the request](/travel/abc) to confirm')).toEqual([
      text('open '),
      { kind: 'link', text: 'the request', href: '/travel/abc' },
      text(' to confirm'),
    ]);
  });
});

describe('parseMarkdown', () => {
  it('splits paragraphs on blank lines and joins wrapped lines', () => {
    const blocks = parseMarkdown('one\nstill one\n\ntwo');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ kind: 'paragraph', spans: [text('one still one')] });
  });

  it('reads a bullet list, with inline markup inside the items', () => {
    const [block] = parseMarkdown('- **Origin is ORD**, from your profile\n- No times given');
    expect(block.kind).toBe('bullets');
    expect(block).toMatchObject({
      items: [
        [{ kind: 'bold', text: 'Origin is ORD' }, text(', from your profile')],
        [text('No times given')],
      ],
    });
  });

  it('reads numbered lists and headings', () => {
    expect(parseMarkdown('1. first\n2. second')[0]).toMatchObject({ kind: 'numbers' });
    expect(parseMarkdown('## Why')[0]).toMatchObject({ kind: 'heading', level: 2 });
  });

  it('keeps a fenced block verbatim', () => {
    const [block] = parseMarkdown('```\nline one\n  indented\n```');
    expect(block).toEqual({ kind: 'code', text: 'line one\n  indented' });
  });

  it('degrades an unsupported table to the lines the model wrote', () => {
    // The rule: never a mangled approximation. A table comes out as prose,
    // which is exactly what the page did before and is at least honest.
    const blocks = parseMarkdown('| a | b |\n| - | - |');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('paragraph');
  });

  it('accounts for every line of a real answer', () => {
    const answer = [
      '**Draft filed:** ORD → MCO, out 15 Nov 2026.',
      '',
      '- **Origin is ORD**, taken from your profile.',
      '- **No times given**, so I filed whole-day windows.',
    ].join('\n');
    const blocks = parseMarkdown(answer);
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'bullets']);
  });

  it('returns nothing for empty input rather than an empty paragraph', () => {
    expect(parseMarkdown('')).toEqual([]);
    expect(parseMarkdown('   \n\n  ')).toEqual([]);
  });
});
