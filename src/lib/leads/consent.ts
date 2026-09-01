/**
 * What we are allowed to do with a lead, and for how long.
 *
 * Pure. This is the GDPR half of §9.8, and it is a small file because the whole
 * posture reduces to three refusals that the rest of the app then cannot get
 * wrong.
 *
 * **1. Unknown is a recorded answer, never a default.** `leads.consent_basis`
 * has no database default on purpose. A badge-scanner CSV has no consent
 * column — the vendor collected the consent, or did not, at their own kiosk —
 * so an import that wrote `consent` because the field was absent would be
 * manufacturing a lawful basis out of the absence of one. That is §5a's
 * fabricated bill in a jurisdiction that fines for it. So `unknown` is a first
 * class basis, it is what an unmapped import produces, and `marketabilityOf`
 * refuses on it.
 *
 * **2. Refusing to market is not refusing to keep.** The two decisions are
 * separate and this file keeps them separate. A business card handed over at a
 * booth is lawfully held under legitimate interest for the ordinary purposes of
 * following up a conversation the person started; what it does not carry is
 * permission to add them to a mailing list, and — as of step 19 — to push them
 * into a CRM that will. So an `unknown` lead stays, stays counted, and is
 * withheld from every outbound path. A model that deleted it instead would lose
 * the lead count, which is the number §8c already says is the weakest link.
 *
 * **3. Erasure must not erase the count.** This is the correction worth the
 * most. A retention date that expires, or a person who asks to be forgotten,
 * cannot be honoured by deleting the row: every ROI figure that show has ever
 * produced would move, silently, months later, and cost-per-lead would improve
 * on its own. So erasure is *redaction* — the personal columns are nulled, the
 * shell keeps `captured_at`, `captured_by_id` and the show, and
 * `redacted_at` says it happened. The person is gone from our systems; the fact
 * that a conversation occurred is not personal data and stays. That also means
 * a redacted row must never be rendered as a lead with a blank name, which is
 * why `isRedacted` exists rather than callers testing `fullName === ''`.
 */

export type LawfulBasis = 'consent' | 'legitimate_interest' | 'unknown';

export const BASIS_LABEL: Record<LawfulBasis, string> = {
  consent: 'Consented',
  legitimate_interest: 'Legitimate interest',
  unknown: 'Not recorded',
};

export function basisOf(raw: string | null | undefined): LawfulBasis {
  if (raw === 'consent' || raw === 'legitimate_interest') return raw;
  return 'unknown';
}

/**
 * Free text from an import, mapped onto a basis — and mapped conservatively.
 *
 * Only an affirmative value becomes `consent`. Anything unrecognised, blank, or
 * negative is `unknown`, because the cost of guessing wrong is asymmetric: a
 * lead wrongly marked unknown is chased up by a person, and a lead wrongly
 * marked consented is a regulatory finding.
 */
export function readBasis(raw: string | null | undefined): LawfulBasis {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v) return 'unknown';
  if (['consent', 'consented', 'opt-in', 'opt in', 'opted in', 'y', 'yes', 'true', '1'].includes(v)) {
    return 'consent';
  }
  if (['legitimate interest', 'legitimate_interest', 'li', 'business card'].includes(v)) {
    return 'legitimate_interest';
  }
  return 'unknown';
}

export type ConsentFacts = {
  basis: LawfulBasis;
  consentCapturedAt: Date | null;
  consentNotice: string | null;
  redactedAt: Date | null;
};

export type Marketability =
  | { usable: true }
  | { usable: false; reason: string; fix: string | null };

/**
 * May this row leave the building — a mailing list, a CRM sync, an export?
 *
 * Four refusals, and the second is the one that catches real data. A basis of
 * `consent` with no timestamp is a checkbox somebody ticked in a spreadsheet
 * after the fact; recorded consent has a moment attached or it is a claim about
 * one. Same shape as an unconfirmed deadline: the assertion is only worth what
 * the evidence behind it is.
 */
export function marketabilityOf(lead: ConsentFacts): Marketability {
  if (lead.redactedAt) {
    return {
      usable: false,
      reason: 'This person asked to be erased, or their retention period ended.',
      fix: null,
    };
  }
  if (lead.basis === 'unknown') {
    return {
      usable: false,
      reason: 'No lawful basis was recorded when this lead was captured.',
      fix: 'Record what the person was told at the booth, or leave it and use the lead only for the follow-up they asked for.',
    };
  }
  if (lead.basis === 'consent' && !lead.consentCapturedAt) {
    return {
      usable: false,
      reason: 'Consent is claimed with no time it was given.',
      fix: 'Record when consent was captured, or record legitimate interest instead, which is what a business card actually is.',
    };
  }
  if (lead.basis === 'consent' && !lead.consentNotice) {
    return {
      usable: false,
      reason: 'Consent was recorded with no note of what the person was told.',
      fix: 'Record the notice they were shown. Consent to an unstated purpose is not consent to any purpose.',
    };
  }
  return { usable: true };
}

export function isRedacted(lead: { redactedAt: Date | null }): boolean {
  return lead.redactedAt !== null;
}

/* -------------------------------- retention -------------------------------- */

/**
 * How long a lead is kept when nobody said otherwise.
 *
 * Two years: long enough that a show's leads outlive the 6-12 month attribution
 * window §8e insists on, short enough to be a real limit. It is a default rather
 * than a policy screen because a retention period nobody has configured must
 * still be *some* finite number — an unset limit is how "we keep it forever"
 * happens without anybody deciding it.
 */
export const DEFAULT_RETENTION_DAYS = 730;

export function retentionDueAt(capturedAt: Date, explicit: Date | null): Date {
  return explicit ?? new Date(capturedAt.getTime() + DEFAULT_RETENTION_DAYS * 86_400_000);
}

export type RetentionStanding =
  /** Within its period. */
  | 'live'
  /** Inside 30 days of its erasure date. */
  | 'due_soon'
  /** Past its date and still holding personal data. This is the breach. */
  | 'overdue'
  /** Already redacted. */
  | 'erased';

export const RETENTION_WARN_DAYS = 30;

export function retentionStandingOf(
  lead: { capturedAt: Date; deleteAfter: Date | null; redactedAt: Date | null },
  asOf: Date,
): RetentionStanding {
  if (lead.redactedAt) return 'erased';
  const due = retentionDueAt(lead.capturedAt, lead.deleteAfter);
  const days = (due.getTime() - asOf.getTime()) / 86_400_000;
  if (days <= 0) return 'overdue';
  if (days <= RETENTION_WARN_DAYS) return 'due_soon';
  return 'live';
}

/**
 * What erasure writes.
 *
 * Everything here is a personal identifier or free text that reliably contains
 * one — booth notes are full of "wife works at Boeing" — and everything absent
 * is deliberately kept: the show, who captured it, when, the source, and the
 * import batch. Those are facts about our own process, and a count assembled
 * from them says nothing about any person.
 *
 * `crm_external_id` is nulled too. Keeping a pointer into a system that still
 * holds the record would make our erasure a fiction with a footnote.
 */
export type Redaction = {
  fullName: string;
  email: null;
  phone: null;
  company: null;
  title: null;
  notes: null;
  interests: null;
  crmExternalId: null;
  consentNotice: null;
  redactedAt: Date;
  redactionReason: string;
};

export const REDACTED_NAME = '[erased]';

export function planRedaction(reason: string, now: Date): Redaction {
  return {
    fullName: REDACTED_NAME,
    email: null,
    phone: null,
    company: null,
    title: null,
    notes: null,
    interests: null,
    crmExternalId: null,
    consentNotice: null,
    redactedAt: now,
    redactionReason: reason,
  };
}
