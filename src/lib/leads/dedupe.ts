/**
 * What counts as the same person, and — the half that matters more — what
 * deliberately does not.
 *
 * Pure. Duplicates inflate a lead count in the flattering direction, and
 * cost-per-lead is a quotient, so a 15% duplicate rate makes a show look 15%
 * cheaper per lead than it was. That is the error nobody audits, because the
 * number looks better rather than worse.
 *
 * Three rules, in descending confidence:
 *
 * 1. **The scanner's own reference is identity.** If two rows carry the same
 *    `external_ref` on the same show they are the same scan, full stop. This is
 *    also what makes the REST endpoint idempotent, which is not a nicety: a
 *    scanner on convention-centre wifi retries, and a retry that creates a lead
 *    is the undetectable half of the count problem.
 * 2. **Email is identity within a show.** Two staff scanning the same badge an
 *    hour apart is the ordinary case, not the exception.
 * 3. **Name plus company is a *suspicion*, never a merge.** "John Smith at
 *    Acme" matches a lot of people at a big enough show, and silently dropping a
 *    real second lead is the same failure as counting a fake one, pointing the
 *    other way. So it is surfaced and never auto-resolved.
 *
 * **Never across shows.** Meeting the same person at Automate in June and at
 * MedTech in October is two real engagements with two costs and two
 * attributions; collapsing them would hand one show credit for the other's
 * conversation. `crm_external_id` is where cross-show identity gets resolved, by
 * the system that owns identity, which is not us.
 */

export type DedupeCandidate = {
  id: string;
  fullName: string;
  email: string | null;
  company: string | null;
  externalRef: string | null;
  capturedAt: Date;
  capturedByName: string | null;
};

export type Incoming = {
  fullName: string;
  email: string | null;
  company: string | null;
  externalRef: string | null;
};

export type Match =
  | { kind: 'same_scan'; lead: DedupeCandidate; reason: string }
  | { kind: 'same_email'; lead: DedupeCandidate; reason: string }
  | { kind: 'possible'; lead: DedupeCandidate; reason: string };

const lower = (v: string | null) => (v ? v.trim().toLowerCase() : null);

/** A name reduced enough to survive "Dr. Jane A. Okafor" vs "Jane Okafor". */
function nameKey(v: string): string {
  return v
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !['dr', 'mr', 'ms', 'mrs', 'prof'].includes(w))
    .sort()
    .join(' ');
}

/**
 * The strongest match against one show's existing leads, or nothing.
 *
 * Redacted rows still participate: an erased lead keeps its `external_ref`, so
 * re-importing the same file after an erasure request must not resurrect the
 * person. That is the case a "skip redacted rows" shortcut would get exactly
 * backwards.
 */
export function findMatch(incoming: Incoming, existing: DedupeCandidate[]): Match | null {
  const ref = lower(incoming.externalRef);
  if (ref) {
    const hit = existing.find((e) => lower(e.externalRef) === ref);
    if (hit) {
      return {
        kind: 'same_scan',
        lead: hit,
        reason: `Scanner reference ${incoming.externalRef} is already on this show.`,
      };
    }
  }

  const email = lower(incoming.email);
  if (email) {
    const hit = existing.find((e) => lower(e.email) === email);
    if (hit) {
      return {
        kind: 'same_email',
        lead: hit,
        reason: `${incoming.email} was already captured on this show${
          hit.capturedByName ? ` by ${hit.capturedByName}` : ''
        }.`,
      };
    }
  }

  const company = lower(incoming.company);
  if (company) {
    const key = nameKey(incoming.fullName);
    const hit = existing.find((e) => lower(e.company) === company && nameKey(e.fullName) === key);
    if (hit) {
      return {
        kind: 'possible',
        lead: hit,
        reason: `Same name and company as a lead captured on this show. Two different people is possible, so this is not merged.`,
      };
    }
  }

  return null;
}

/** The matches that block a write. A `possible` is reported and admitted. */
export function isBlocking(match: Match | null): match is Match {
  return match !== null && match.kind !== 'possible';
}
