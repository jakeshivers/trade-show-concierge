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
  /**
   * Emphasis carries spans, not a string, because the assistant bolds a bare
   * path — the draft flow's "open this to confirm" wraps `/travel/<id>` in
   * double asterisks — and a bold token holding plain text could never make
   * that clickable.
   *
   * (Writing that example literally is what broke this file once: a bolded
   * path starts with the three characters that also end a block comment.)
   */
  | { kind: 'bold'; spans: Inline[] }
  | { kind: 'italic'; spans: Inline[] }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string };

/**
 * Whether a bare path the model wrote is a screen in this app.
 *
 * Supplied by the caller rather than known here: `src/lib` has no business
 * holding a list of routes, and a hand-written one beside a nav that grows is
 * the `SOURCE_LABEL` trap. `_components/prose.tsx` derives it from `nav.ts`.
 */
export type IsAppPath = (path: string) => boolean;

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

/**
 * A bare path in prose. Deliberately conservative: it will not match a lone `/`,
 * and trailing sentence punctuation is left outside the href — "open /travel/x."
 * links `/travel/x`, not `/travel/x.`.
 */
const BARE_PATH = /\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*/g;

/** One line of prose into spans. Unmatched syntax stays literal. */
export function parseInline(line: string, isAppPath?: IsAppPath): Inline[] {
  const out: Inline[] = [];

  const pushText = (text: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last?.kind === 'text') last.text += text;
    else out.push({ kind: 'text', text });
  };

  /**
   * Text, with any path this app actually serves turned into a link.
   *
   * Only ever applied to *text* runs, so a path inside `code` stays code — the
   * one place a path is being shown rather than offered.
   */
  const push = (text: string) => {
    if (!text) return;
    if (!isAppPath) return pushText(text);
    let at = 0;
    BARE_PATH.lastIndex = 0;
    for (let m = BARE_PATH.exec(text); m; m = BARE_PATH.exec(text)) {
      const raw = m[0].replace(/[.,;:!?)\]]+$/, '');
      if (!raw.includes('/') || !isAppPath(raw)) continue;
      pushText(text.slice(at, m.index));
      out.push({ kind: 'link', text: raw, href: raw });
      at = m.index + raw.length;
      BARE_PATH.lastIndex = at;
    }
    pushText(text.slice(at));
  };

  let rest = line;
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
    else if (m[3]) out.push({ kind: 'bold', spans: parseInline(tok.slice(2, -2), isAppPath) });
    else out.push({ kind: 'italic', spans: parseInline(tok.slice(1, -1), isAppPath) });
    rest = rest.slice(m.index + tok.length);
  }
  push(rest);
  return out;
}

const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBER = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^(#{1,3})\s+(.*)$/;

/** A whole answer into blocks. */
export function parseMarkdown(src: string, isAppPath?: IsAppPath): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];

  const flush = () => {
    if (!para.length) return;
    blocks.push({ kind: 'paragraph', spans: parseInline(para.join(' ').trim(), isAppPath) });
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
        spans: parseInline(h[2], isAppPath),
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
        items.push(parseInline(re.exec(lines[i])![1], isAppPath));
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
