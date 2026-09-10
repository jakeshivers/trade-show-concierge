import PptxGenJS from 'pptxgenjs';
import type { Deck, Slide } from './plan';

/**
 * A `Deck` as a .pptx file.
 *
 * Deliberately thin and deliberately dull: every decision about *what a slide
 * may claim* is in `plan.ts`, where it is pure and tested. This file knows about
 * inches and font sizes and nothing else, so a change to the wording rules never
 * has to be made in a module that imports a rendering library.
 *
 * Colours are literal here rather than semantic tokens, because a .pptx has no
 * stylesheet to read and no dark mode — the deck is opened in PowerPoint, where
 * a token means nothing. That is the one place in this codebase where naming a
 * colour is correct.
 */

const INK = '1F2933';
const MUTED = '6B7280';
const BRAND = '1D4ED8';
const RULE = 'E5E7EB';

export async function buildDeck(deck: Deck): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';
  pptx.title = deck.title;

  for (const slide of deck.slides) render(pptx, slide);

  // `write` with `nodebuffer` keeps this usable from both a route handler and a
  // CLI script; pptxgenjs types the return as a union, hence the cast.
  const out = await pptx.write({ outputType: 'nodebuffer' });
  return out as Buffer;
}

function render(pptx: PptxGenJS, slide: Slide): void {
  const s = pptx.addSlide();

  if (slide.kind === 'title') {
    s.addText(slide.title, { x: 0.6, y: 1.7, w: 8.8, h: 1.0, fontSize: 40, bold: true, color: INK });
    s.addText(slide.subtitle, { x: 0.6, y: 2.7, w: 8.8, h: 0.5, fontSize: 18, color: BRAND });
    s.addText(slide.stamp, { x: 0.6, y: 4.6, w: 8.8, h: 0.6, fontSize: 11, color: MUTED });
    return;
  }

  s.addText(slide.title, { x: 0.6, y: 0.4, w: 8.8, h: 0.6, fontSize: 26, bold: true, color: INK });
  let top = 1.1;
  if (slide.note) {
    s.addText(slide.note, { x: 0.6, y: top, w: 8.8, h: 0.6, fontSize: 12, color: MUTED });
    top += 0.75;
  }

  if (slide.kind === 'stats') {
    // Three across, wrapping — a KPI row that overflows the slide is worse than
    // one that takes two rows.
    slide.stats.forEach((stat, i) => {
      const col = i % 3;
      const row = Math.floor(i / 3);
      const x = 0.6 + col * 3.0;
      const y = top + row * 1.5;
      s.addText(stat.label.toUpperCase(), { x, y, w: 2.8, h: 0.3, fontSize: 10, color: MUTED, bold: true });
      s.addText(stat.value, { x, y: y + 0.3, w: 2.8, h: 0.55, fontSize: 22, bold: true, color: INK });
      if (stat.note) {
        s.addText(stat.note, { x, y: y + 0.85, w: 2.8, h: 0.5, fontSize: 10, color: MUTED });
      }
    });
    return;
  }

  if (slide.kind === 'bullets') {
    slide.bullets.forEach((b) => {
      s.addText(b.text, {
        x: 0.6,
        y: top,
        w: 8.8,
        h: 0.35,
        fontSize: 15,
        color: INK,
        bullet: { indent: 15 },
      });
      top += 0.42;
      if (b.sub) {
        s.addText(b.sub, { x: 0.95, y: top, w: 8.4, h: 0.45, fontSize: 11, color: MUTED });
        top += 0.55;
      }
    });
    return;
  }

  s.addTable(
    [
      slide.head.map((h) => ({
        text: h,
        options: { bold: true, color: MUTED, fontSize: 11 },
      })),
      ...slide.rows.map((r) => r.map((c) => ({ text: c, options: { fontSize: 12, color: INK } }))),
    ],
    { x: 0.6, y: top, w: 8.8, border: { type: 'solid', color: RULE, pt: 1 }, autoPage: false },
  );
}
