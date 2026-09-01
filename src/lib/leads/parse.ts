import { readBasis, type LawfulBasis } from './consent';

/**
 * A badge-scanner CSV, turned into rows we will admit to holding.
 *
 * Pure, and the whole file is about the two ways a lead count goes wrong. §8c
 * says the count is the weakest link in the ROI story and blames rep behaviour,
 * which is right about the cause and incomplete about the mechanism. Import has
 * its own two:
 *
 * **Silent loss.** A parser that skips a malformed row reports a smaller number
 * with the same confidence as a correct one, and nobody re-counts a CSV. So
 * every row read lands in exactly one bucket — accepted, rejected, or duplicate
 * — the three sum to `rowsRead`, and `planImport` returns the rejections with
 * their row numbers and reasons rather than a count of them. `store.ts` writes
 * that list to `lead_imports.problems` so the arithmetic survives the screen.
 *
 * **Silent gain.** Scanners re-export, people import the same file twice, and
 * two staff scan the same badge an hour apart. Duplicates inflate the count in
 * the flattering direction, which is the direction nobody audits, and
 * cost-per-lead is a *quotient* — a 15% duplicate rate makes a show look 15%
 * cheaper per lead than it was. `dedupe.ts` decides what a duplicate is; this
 * file only asks it.
 *
 * **Mapping is declared, never guessed.** `inferMapping` proposes, from the
 * header names badge vendors actually ship, and a person confirms it. The
 * failure it avoids is a column called `Company` that is really the *exhibitor*
 * company, which a silent auto-map would file as the lead's employer on every
 * row, plausibly, forever.
 */

/* --------------------------------- parsing --------------------------------- */

export class CsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvError';
  }
}

/**
 * RFC 4180 enough for the files that exist: quoted fields, embedded commas and
 * newlines, doubled quotes, CRLF, and a BOM — which Excel writes and which,
 * unstripped, turns the first header into `﻿First Name` and makes the
 * mapping silently miss exactly one column.
 */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  let started = false;

  const endField = () => {
    row.push(field);
    field = '';
    started = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < src.length) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"' && !started) {
      quoted = true;
      started = true;
      i += 1;
      continue;
    }
    if (c === ',') {
      endField();
      i += 1;
      continue;
    }
    if (c === '\r') {
      i += 1;
      continue;
    }
    if (c === '\n') {
      endRow();
      i += 1;
      continue;
    }
    field += c;
    started = true;
    i += 1;
  }
  if (quoted) throw new CsvError('The file ends inside a quoted field. It is truncated or not CSV.');
  // A trailing newline is a line terminator, not an empty final record.
  if (field.length > 0 || row.length > 0) endRow();

  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

/* --------------------------------- mapping --------------------------------- */

/** The lead fields an import can fill. `fullName` is the only required one. */
export type LeadField =
  | 'fullName'
  | 'email'
  | 'phone'
  | 'company'
  | 'title'
  | 'notes'
  | 'interests'
  | 'externalRef'
  | 'consentBasis'
  | 'consentNotice';

export const FIELD_LABEL: Record<LeadField, string> = {
  fullName: 'Name',
  email: 'Email',
  phone: 'Phone',
  company: 'Company',
  title: 'Job title',
  notes: 'Notes',
  interests: 'Interests',
  externalRef: 'Scanner reference',
  consentBasis: 'Lawful basis',
  consentNotice: 'Consent notice',
};

/** header (as written in the file) → field, or null for "do not import". */
export type ColumnMapping = Record<string, LeadField | null>;

const CANDIDATES: [LeadField, string[]][] = [
  ['fullName', ['full name', 'name', 'attendee name', 'contact name', 'lead name']],
  ['email', ['email', 'e-mail', 'email address', 'work email']],
  ['phone', ['phone', 'telephone', 'mobile', 'phone number', 'cell']],
  ['company', ['company', 'organization', 'organisation', 'account', 'employer']],
  ['title', ['title', 'job title', 'position', 'role']],
  ['notes', ['notes', 'note', 'comments', 'rep notes']],
  ['interests', ['interests', 'products', 'product interest', 'topics']],
  ['externalRef', ['badge id', 'badge', 'scan id', 'registration id', 'external id', 'ref']],
  ['consentBasis', ['consent', 'opt in', 'opt-in', 'marketing consent', 'lawful basis']],
  ['consentNotice', ['consent notice', 'notice', 'privacy notice']],
];

const norm = (h: string) => h.trim().toLowerCase().replace(/[_\s]+/g, ' ');

/**
 * A proposal, not a decision. First header that matches wins a field, and a
 * field already claimed is not re-assigned — so a file with both `Name` and
 * `Contact Name` maps the first and offers the second as unmapped rather than
 * quietly preferring one.
 */
export function inferMapping(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const taken = new Set<LeadField>();
  for (const header of headers) {
    const n = norm(header);
    const hit = CANDIDATES.find(([field, names]) => !taken.has(field) && names.includes(n));
    if (hit) {
      taken.add(hit[0]);
      mapping[header] = hit[0];
    } else {
      mapping[header] = null;
    }
  }
  return mapping;
}

/* ------------------------------ import planning ---------------------------- */

export type DraftLead = {
  fullName: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  title: string | null;
  notes: string | null;
  interests: string[] | null;
  externalRef: string | null;
  basis: LawfulBasis;
  consentNotice: string | null;
};

export type ImportProblem = { row: number; reason: string };

export type ImportPlan = {
  /** Header row excluded. Accepted + rejected + duplicates always equals this. */
  rowsRead: number;
  accepted: DraftLead[];
  rejected: ImportProblem[];
  /** Rows that match something already here, or an earlier row in this file. */
  duplicates: ImportProblem[];
  /**
   * Said once, on the plan rather than on every row: no column was mapped to a
   * lawful basis, so every lead in this file arrives with none recorded.
   */
  basisUnmapped: boolean;
};

export type PlanOptions = {
  /**
   * Decides whether a draft duplicates something. Injected because "already
   * here" is a database question and this file is pure — see `dedupe.ts` for
   * what it actually compares.
   */
  isDuplicate?: (draft: DraftLead) => string | null;
};

/**
 * Rows → drafts, with every input row accounted for.
 *
 * A row is rejected for exactly three reasons, and all three are stated back:
 * no name (there is no lead without a person), a column count that does not
 * match the header (a broken file, and guessing which field shifted is how a
 * phone number becomes a job title), and a duplicate.
 */
export function planImport(
  rows: string[][],
  mapping: ColumnMapping,
  opts: PlanOptions = {},
): ImportPlan {
  if (rows.length === 0) throw new CsvError('The file has no rows.');
  const [headers, ...body] = rows;

  const index = new Map<LeadField, number>();
  headers.forEach((h, i) => {
    const field = mapping[h];
    if (field && !index.has(field)) index.set(field, i);
  });
  if (!index.has('fullName')) {
    throw new CsvError('No column is mapped to Name. A lead without a person is not a lead.');
  }

  const plan: ImportPlan = {
    rowsRead: body.length,
    accepted: [],
    rejected: [],
    duplicates: [],
    basisUnmapped: !index.has('consentBasis'),
  };

  const seenInFile = new Map<string, number>();
  const get = (row: string[], field: LeadField): string | null => {
    const i = index.get(field);
    if (i === undefined) return null;
    const v = (row[i] ?? '').trim();
    return v === '' ? null : v;
  };

  body.forEach((row, n) => {
    // +2: one for the header, one because people count from 1.
    const lineNo = n + 2;
    if (row.length !== headers.length) {
      plan.rejected.push({
        row: lineNo,
        reason: `${row.length} column(s) where the header has ${headers.length}. Fields would land in the wrong places.`,
      });
      return;
    }
    const fullName = get(row, 'fullName');
    if (!fullName) {
      plan.rejected.push({ row: lineNo, reason: 'No name.' });
      return;
    }
    const interests = get(row, 'interests');
    const draft: DraftLead = {
      fullName,
      email: get(row, 'email'),
      phone: get(row, 'phone'),
      company: get(row, 'company'),
      title: get(row, 'title'),
      notes: get(row, 'notes'),
      interests: interests
        ? interests
            .split(/[;|,]/)
            .map((s) => s.trim())
            .filter(Boolean)
        : null,
      externalRef: get(row, 'externalRef'),
      basis: readBasis(get(row, 'consentBasis')),
      consentNotice: get(row, 'consentNotice'),
    };

    // Within the file first: importing the same export twice is the common
    // case, and the second copy has no row in the database to be caught by.
    const key = withinFileKey(draft);
    const earlier = key ? seenInFile.get(key) : undefined;
    if (earlier !== undefined) {
      plan.duplicates.push({ row: lineNo, reason: `Same as row ${earlier} in this file.` });
      return;
    }
    const clash = opts.isDuplicate?.(draft);
    if (clash) {
      plan.duplicates.push({ row: lineNo, reason: clash });
      return;
    }
    if (key) seenInFile.set(key, lineNo);
    plan.accepted.push(draft);
  });

  return plan;
}

function withinFileKey(d: DraftLead): string | null {
  if (d.externalRef) return `ref:${d.externalRef.toLowerCase()}`;
  if (d.email) return `email:${d.email.toLowerCase()}`;
  return null;
}
