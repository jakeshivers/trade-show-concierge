import { basisOf, isRedacted, retentionStandingOf, type LawfulBasis } from './consent';

/**
 * §8c, as a number that says what it is missing.
 *
 * Pure. §8a's rule at a different scale: **a lead count that does not say who
 * did not capture is a fabricated bill.** The scope is unusually blunt about
 * this — cost-per-lead is only as good as the lead count, the lead count is bad
 * at most companies because a rep at hour six of day two does not open a CRM,
 * and a confidently wrong ROI number is worse than an absent one because
 * somebody cuts a show over it.
 *
 * That is the same argument step 17 made about a cost total, so it gets the same
 * shape rather than a new one: a figure, a coverage verdict beside it, and a
 * headline word that changes when the coverage is thin. The wording changes too
 * — an incomplete cost is "at least $41,300", and an incomplete lead count is
 * "**at least** 34 leads, from 3 of 6 people on the booth".
 *
 * **Who counts as "on the booth" is the load-bearing decision.** It is the
 * people rostered on a booth shift, not everyone attending: the analyst going to
 * two briefings and the engineer running a demo in a partner's suite are at the
 * show and are not standing where badges get scanned, and counting them makes
 * every show look under-covered, which is the same as reporting nothing. §5e
 * reached the identical conclusion from the other side — a warning that fires on
 * the ordinary case is one nobody reads. Where a show has no shifts rostered at
 * all, coverage is **unknown** rather than 0 of 0, which would read as perfect.
 *
 * And the tense rule, one more time: before a show opens, no leads is not thin
 * capture, it is a show that has not happened. Coverage is only a judgement from
 * the first day onward.
 */

export type CapturingStaff = {
  userId: string;
  fullName: string;
  /** Rostered on at least one booth shift. See the header. */
  onBooth: boolean;
};

export type CountableLead = {
  id: string;
  capturedById: string | null;
  capturedAt: Date;
  deleteAfter: Date | null;
  redactedAt: Date | null;
  consentBasis: string | null;
  duplicateOfId: string | null;
};

export type CoverageStanding =
  /** Everybody on the booth captured something. */
  | 'sound'
  /** Some did, some did not. The count is a floor. */
  | 'partial'
  /** Nobody captured anything, on a show that has opened. */
  | 'none'
  /** Nobody is rostered, so there is nothing to measure against. */
  | 'unknown'
  /** The show has not opened. Silence is not a finding yet. */
  | 'not_yet';

export type LeadCoverage = {
  /** Leads that count: not redacted-away duplicates, one row per person. */
  leadCount: number;
  /** Rows held back from the count because they duplicate another. */
  duplicateCount: number;
  boothStaff: number;
  capturingStaff: number;
  /** Named, because "3 of 6" is a prompt to go and ask the other three. */
  silent: { userId: string; fullName: string }[];
  standing: CoverageStanding;
  /** True when the count must be introduced with "at least". */
  isFloor: boolean;
  /**
   * Whether the show is over.
   *
   * Here for the tense, which is §5a's rule on the return side. "Ask them to
   * add what they have" is the right sentence while a show is running and the
   * wrong one a year after it closed — and the note used to hedge it in prose
   * ("if the show is still on") because it did not have this. A hedge is what a
   * sentence does when the code has not been asked the question.
   */
  hasClosed: boolean;
  /** One sentence, in the tense the standing deserves. */
  headline: string;
  basis: Record<LawfulBasis, number>;
  /** Rows still holding personal data past their retention date. */
  retentionOverdue: number;
  retentionDueSoon: number;
};

/**
 * Whether capture could plausibly have started.
 *
 * The calendar is the usual answer and the *status* overrides it, because a show
 * marked `live` is one somebody has said is happening — move-in day networking
 * and a press preview both produce leads before the opening bell. Trusting the
 * date alone would call a show with six recorded leads "not yet open", which is
 * an app arguing with the person standing in the booth.
 */
export function hasOpened(
  show: { startsOn: Date; status: string },
  asOf: Date,
): boolean {
  if (show.status === 'live' || show.status === 'complete') return true;
  return asOf.getTime() >= show.startsOn.getTime();
}

/**
 * Whether capture can still change. `hasOpened`'s mirror, and the status
 * overrides the calendar for the same reason: a show somebody has marked
 * complete is over whatever the dates say.
 */
export function hasClosed(
  show: { endsOn: Date; status: string },
  asOf: Date,
): boolean {
  if (show.status === 'complete' || show.status === 'cancelled') return true;
  return asOf.getTime() > show.endsOn.getTime();
}

export function assessCoverage(
  args: {
    show: { startsOn: Date; endsOn: Date; status: string };
    staff: CapturingStaff[];
    leads: CountableLead[];
  },
  asOf: Date,
): LeadCoverage {
  const { show, staff, leads } = args;

  const counted = leads.filter((l) => l.duplicateOfId === null);
  const boothStaff = staff.filter((s) => s.onBooth);
  const capturedBy = new Set(counted.map((l) => l.capturedById).filter(Boolean) as string[]);
  const silent = boothStaff
    .filter((s) => !capturedBy.has(s.userId))
    .map((s) => ({ userId: s.userId, fullName: s.fullName }));

  const basis: Record<LawfulBasis, number> = {
    consent: 0,
    legitimate_interest: 0,
    unknown: 0,
  };
  let retentionOverdue = 0;
  let retentionDueSoon = 0;
  for (const lead of counted) {
    if (!isRedacted(lead)) basis[basisOf(lead.consentBasis)] += 1;
    const standing = retentionStandingOf(lead, asOf);
    if (standing === 'overdue') retentionOverdue += 1;
    if (standing === 'due_soon') retentionDueSoon += 1;
  }

  const opened = hasOpened(show, asOf);
  const closed = hasClosed(show, asOf);
  const capturingStaff = boothStaff.filter((s) => capturedBy.has(s.userId)).length;

  // Order matters, and the third line is the one worth arguing about. "Nobody
  // captured anything" has to mean *there are no leads*, not "no rostered person
  // captured one" — a show whose entire lead set arrived in a vendor's CSV has a
  // real count and unmeasured coverage, and calling that `none` would put "no
  // leads recorded" next to a list of them. It is `partial` with everybody
  // silent, which reads as "at least 5 leads, from 0 of 3 people on the booth",
  // and is exactly the finding.
  let standing: CoverageStanding;
  if (!opened) standing = 'not_yet';
  else if (boothStaff.length === 0) standing = 'unknown';
  else if (counted.length === 0) standing = 'none';
  else if (silent.length > 0) standing = 'partial';
  else standing = 'sound';

  const isFloor = standing === 'partial' || standing === 'none' || standing === 'unknown';

  return {
    leadCount: counted.length,
    duplicateCount: leads.length - counted.length,
    boothStaff: boothStaff.length,
    capturingStaff,
    silent,
    standing,
    isFloor,
    hasClosed: closed,
    headline: headlineFor(counted.length, capturingStaff, boothStaff.length, standing),
    basis,
    retentionOverdue,
    retentionDueSoon,
  };
}

function headlineFor(
  count: number,
  capturing: number,
  booth: number,
  standing: CoverageStanding,
): string {
  const leads = `${count} lead${count === 1 ? '' : 's'}`;
  switch (standing) {
    case 'not_yet':
      return count === 0
        ? 'No leads yet. The show has not opened.'
        : `${leads} before the doors open.`;
    case 'unknown':
      return `At least ${leads}. Nobody is rostered on a booth shift, so there is nothing to say how complete that is.`;
    case 'none':
      return `Nothing recorded, from ${booth} ${booth === 1 ? 'person' : 'people'} on the booth.`;
    case 'partial':
      return `At least ${leads}, from ${capturing} of ${booth} people on the booth.`;
    case 'sound':
      return `${leads}, from all ${booth} people on the booth.`;
  }
}

/**
 * Whether a per-lead figure may be quoted at all — §19's cost-per-lead, asked a
 * step early because the refusal belongs with the count rather than with the
 * division.
 *
 * A quotient over a floor is not a floor: dividing a real cost by an undercounted
 * denominator makes cost-per-lead too *high*, which reads as a bad show, and the
 * decision it drives is cutting a show that worked. So the ratio is withheld
 * rather than published with an asterisk.
 */
export function mayQuotePerLead(coverage: LeadCoverage): { ok: boolean; reason?: string } {
  if (coverage.leadCount === 0) {
    return { ok: false, reason: 'No leads are recorded yet, so there is nothing to divide the cost by.' };
  }
  if (coverage.standing === 'none' || coverage.standing === 'unknown') {
    return {
      ok: false,
      reason:
        'Nobody is scheduled on a booth shift, so there is no way to tell how many leads were ' +
        'missed. A cost-per-lead figure here would be a guess with a decimal point on it.',
    };
  }
  if (coverage.standing === 'partial') {
    return {
      ok: false,
      reason:
        `${coverage.silent.length} of ${coverage.boothStaff} people on the booth entered no ` +
        'leads, so the real count is higher than this. Dividing the cost by too few leads ' +
        'makes each one look more expensive than it was — and that is the number people cut ' +
        'a show over. It will appear once everyone has entered theirs.',
    };
  }
  return { ok: true };
}
