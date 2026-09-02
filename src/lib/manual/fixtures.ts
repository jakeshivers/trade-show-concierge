/**
 * A synthetic exhibitor service manual, and a PDF writer small enough to read.
 *
 * **This proves internal consistency and structurally cannot catch a layout the
 * real manuals use and ours does not.** That is `duffel/fixtures.ts`'s sentence
 * about itself, and it is repeated here rather than paraphrased because the
 * situation is the same one: the document below and the prompt in
 * `integrations/extract/anthropic/client.ts` were written by the same person, so
 * a suite built on it can only ever show that our own halves agree.
 *
 * What it *does* prove is worth having and is most of this feature: that the page
 * reader numbers pages the way a person does, that the anchor check rejects a
 * citation that is not on its page, that a penalty figure absent from the
 * evidence is dropped while its words survive, that a missing hour is flagged
 * rather than assumed away, that every candidate is accounted for, and that the
 * coverage sweep notices a date nothing claimed. None of those need a real
 * manual, and all of them are the parts that make confirming safe.
 *
 * The part that needs a real manual is **recall**, and nothing in this file can
 * speak to it. `pnpm manual:probe` is what does — see SCOPE.md §5a.
 *
 * The PDF writer exists so the tests exercise `unpdf` for real instead of
 * handing `readManual` a string it never had to parse. It emits the smallest
 * valid document that carries a text layer: no compression, one font, one
 * content stream per page.
 */

/** Escape the three characters that are syntax inside a PDF string literal. */
function escapePdfText(line: string): string {
  return line.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

export function buildPdf(pages: string[][]): Uint8Array {
  const objects: string[] = [];
  const kids = pages.map((_, i) => `${4 + 2 * i} 0 R`).join(' ');

  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  pages.forEach((lines, i) => {
    const body = lines.map((l) => `(${escapePdfText(l)}) Tj T*\n`).join('');
    const content = `BT /F1 11 Tf 50 750 Td 14 TL\n${body}ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + 2 * i} 0 R >>`,
    );
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}

/**
 * Four pages, carrying one of each thing the planner has to handle: a deadline
 * with a printed hour, one with no hour at all, a percentage penalty with no
 * dollar figure, a date that is a revision footer rather than a deadline, and a
 * cutoff printed twice.
 */
export const SYNTHETIC_MANUAL_PAGES: string[][] = [
  [
    'ACME CONVENTION SERVICES',
    'EXHIBITOR SERVICE MANUAL - MedTech Summit 2027',
    '',
    'Deadline summary',
    'Advance order discount deadline: February 3, 2027',
    'Advance warehouse receiving closes 4:00 PM on January 20, 2027',
    '',
    'Document revised 03/2019. (c) 1998 Acme Convention Services.',
  ],
  [
    'SECTION 2 - ELECTRICAL',
    '',
    'Electrical orders received after February 3, 2027 are surcharged 30%.',
    'A $450.00 late processing fee applies to on-site electrical orders.',
  ],
  [
    'SECTION 3 - FREIGHT',
    '',
    'Advance warehouse receiving closes 4:00 PM on January 20, 2027.',
    'Show-site receiving opens at move-in and not before.',
    'Rigging labor must be ordered by January 27, 2027.',
  ],
  [
    'SECTION 4 - REGISTRATION',
    '',
    'Exhibitor badge registration closes February 17, 2027.',
  ],
];

export const SYNTHETIC_MANUAL = () => buildPdf(SYNTHETIC_MANUAL_PAGES);
