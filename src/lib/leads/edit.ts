import { readBasis, type LawfulBasis } from './consent';

/**
 * Pure validation for the things a person types.
 *
 * Two rules here are worth more than the rest of the file.
 *
 * **A consent basis is never inferred from a form's defaults.** The manual entry
 * form asks, with "not recorded" as a real option that is selected until
 * somebody chooses otherwise. A select that defaulted to "consented" would
 * manufacture a lawful basis from a person tabbing past a control, which is
 * `consent.ts`'s first rule reached through the UI instead of through an import.
 *
 * **Erasure needs a written reason**, like skipping a task, waiving a deadline
 * and returning an asset damaged. It is the fourth time this rule has arrived
 * from an unrelated direction, and the reason is the same every time: the act
 * removes something from the record, so the record has to say why.
 */

export class LeadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeadError';
  }
}

export type LeadDraft = {
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

export type LeadInput = Omit<LeadDraft, 'basis'> & { basis: string | null };

export function validateLead(input: LeadInput): LeadDraft {
  const fullName = input.fullName.trim();
  if (!fullName) throw new LeadError('A lead needs a name. Without a person there is no lead.');
  if (input.email && !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(input.email.trim())) {
    throw new LeadError(`“${input.email}” is not an email address.`);
  }

  const basis = readBasis(input.basis);
  if (basis === 'consent' && !input.consentNotice?.trim()) {
    throw new LeadError(
      'Recording consent means recording what the person was told. Consent to an unstated purpose is not consent to any purpose — record the notice, or record legitimate interest, which is what a business card is.',
    );
  }

  return {
    fullName,
    email: input.email?.trim().toLowerCase() || null,
    phone: input.phone?.trim() || null,
    company: input.company?.trim() || null,
    title: input.title?.trim() || null,
    notes: input.notes?.trim() || null,
    interests: input.interests?.filter((i) => i.trim()).map((i) => i.trim()) ?? null,
    externalRef: input.externalRef?.trim() || null,
    basis,
    consentNotice: input.consentNotice?.trim() || null,
  };
}

export type MeetingDraft = {
  subject: string;
  company: string | null;
  isExistingCustomer: boolean;
  scheduledAt: Date | null;
  occurredAt: Date | null;
  noShowAt: Date | null;
  leadId: string | null;
  ownerId: string | null;
  notes: string | null;
};

export type MeetingInput = Omit<MeetingDraft, 'subject'> & { subject: string };

/**
 * A meeting is scheduled, or it happened, or it did not — and the third is the
 * one a simpler model loses. A booked meeting nobody showed up to is not a
 * meeting held, and leaving `occurredAt` null makes it indistinguishable from a
 * meeting still in the future. Counting those as held inflates the meeting count
 * exactly the way duplicates inflate the lead count.
 */
export function validateMeeting(input: MeetingInput): MeetingDraft {
  const subject = input.subject.trim();
  if (!subject) throw new LeadError('A meeting needs a subject — who, or what it was about.');
  if (input.occurredAt && input.noShowAt) {
    throw new LeadError('A meeting cannot both have happened and been a no-show.');
  }
  if (!input.scheduledAt && !input.occurredAt && !input.noShowAt) {
    throw new LeadError(
      'Say when this was scheduled for, or when it actually happened. A meeting with no time on it cannot be counted or chased.',
    );
  }
  return {
    subject,
    company: input.company?.trim() || null,
    isExistingCustomer: input.isExistingCustomer,
    scheduledAt: input.scheduledAt,
    occurredAt: input.occurredAt,
    noShowAt: input.noShowAt,
    leadId: input.leadId,
    ownerId: input.ownerId,
    notes: input.notes?.trim() || null,
  };
}

export const MIN_REDACTION_REASON = 8;

export function validateRedactionReason(reason: string): string {
  const r = reason.trim();
  if (r.length < MIN_REDACTION_REASON) {
    throw new LeadError(
      'Erasure is permanent and needs a written reason — an erasure request, a retention period ending, a row captured in error.',
    );
  }
  return r;
}
