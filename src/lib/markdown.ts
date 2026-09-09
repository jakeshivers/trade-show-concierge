/**
 * The small slice of Markdown the assistant actually writes, parsed into tokens.
 *
 * The model was never told how to format, so it answers in Markdown — and the
 * transcript rendered it as literal text: `**Draft filed:**` and `- **Origin is
 * ORD**` on screen, asterisks and all, on the one page in this product whose
 * whole content is model prose.
 *
 * Three decisions worth keeping:
 *
 * 1. **Parsing is here and pure; rendering is a component.** Same split as every
 *    other module: the decision is testable in a `node` environment and the view
 *    is thin. That matters more than usual after the form-reset fix, which could
 *    only ever be checked in a browser — this one cannot escape the suite.
 * 2. **Anything unrecognised degrades to its own literal text, never to a
 *    mangled approximation.** A table or a nested list comes out as the plain
 *    lines the model wrote, which is exactly today's behaviour and is honest. A
 *    half-parsed table is worse than an unparsed one.
 * 3. **No HTML from the model, ever.** Tokens become React elements, so there is
 *    no `dangerouslySetInnerHTML` anywhere near this and no raw-HTML escape
 *    hatch to leave open. Model output is the least trusted text in the app: it
 *    is influenced by tool results, which are influenced by rows a stranger at a
 *    booth typed.
 */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'italic'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string };

export type Block =
  | { kind: 'paragraph'; spans: Inline[] }
  | { kind: 'heading'; level: 1 | 2 | 3; spans: Inline[] }
  | { kind: 'bullets'; items: Inline[][] }
  | { kind: 'numbers'; items: Inline[][] }
  | { kind: 'code'; text: string };

/**
 * A link the app will render.
 *
 * Relative paths (our own screens — the draft flow tells people to open one),
 * plus http(s) and mailto. Everything else — `javascript:` first among them —
 * is refused and the link renders as its own text, because an anchor is the one
 * thing on this page that *does* something when clicked.
 */
export function safeHref(href: string): string | null {
  const h = href.trim();
  if (h.startsWith('/') && !h.startsWith('//')) return h;
  if (/^https?:\/\//i.test(h) || /^mailto:/i.test(h)) return h;
  return null;
}

const INLINE = /(\[[^\]\n]+\]\([^)\s]+\))|(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(_[^_\n]+_)/;

/** One line of prose into spans. Unmatched syntax stays literal. */
export function parseInline(line: string): Inline[] {
  const out: Inline[] = [];
  let rest = line;
  const push = (text: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last?.kind === 'text') last.text += text;
    else out.push({ kind: 'text', text });
  };

  while (rest) {
    const m = INLINE.exec(rest);
    if (!m || m.index === undefined) break;
    push(rest.slice(0, m.index));
    const tok = m[0];
    if (m[1]) {
      const cut = tok.indexOf('](');
      const text = tok.slice(1, cut);
      const href = safeHref(tok.slice(cut + 2, -1));
      // A refused href degrades to the model's own **literal token**, not to its
      // link text. Rule 2, and it is not pedantry: the href pattern stops at the
      // first `)`, so a URL containing one leaves a stray bracket behind if only
      // the text survives — a mangled approximation of the thing we just refused
      // to render. The whole token is at least true.
      if (href) out.push({ kind: 'link', text, href });
      else push(tok);
    } else if (m[2]) out.push({ kind: 'code', text: tok.slice(1, -1) });
    else if (m[3]) out.push({ kind: 'bold', text: tok.slice(2, -2) });
    else out.push({ kind: 'italic', text: tok.slice(1, -1) });
    rest = rest.slice(m.index + tok.length);
  }
  push(rest);
  return out;
}

const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBER = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^(#{1,3})\s+(.*)$/;

/** A whole answer into blocks. */
export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];

  const flush = () => {
    if (!para.length) return;
    blocks.push({ kind: 'paragraph', spans: parseInline(para.join(' ').trim()) });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.trim().startsWith('```')) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) body.push(lines[i++]);
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }

    if (!line.trim()) {
      flush();
      continue;
    }

    const h = HEADING.exec(line);
    if (h) {
      flush();
      blocks.push({
        kind: 'heading',
        level: h[1].length as 1 | 2 | 3,
        spans: parseInline(h[2]),
      });
      continue;
    }

    const isBullet = BULLET.test(line);
    const isNumber = !isBullet && NUMBER.test(line);
    if (isBullet || isNumber) {
      flush();
      const re = isBullet ? BULLET : NUMBER;
      const items: Inline[][] = [];
      while (i < lines.length && re.test(lines[i])) {
        items.push(parseInline(re.exec(lines[i])![1]));
        i++;
      }
      i--;
      blocks.push({ kind: isBullet ? 'bullets' : 'numbers', items });
      continue;
    }

    para.push(line);
  }
  flush();
  return blocks;
}
