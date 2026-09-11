/**
 * Target accounts, and the one piece of business logic in this product that has
 * to run on somebody's phone.
 *
 * Everything else here decides on a server: a policy verdict, a readiness score,
 * a receiving window, an attribution model. This does not get to. A
 * target-company alert is worth something for the ninety seconds a booth staffer
 * is standing in front of the person and nothing whatsoever afterwards, and on a
 * show floor there is no network to ask. So the match happens on the device,
 * against a cached list, while the company name is still being typed.
 *
 * That forces the shape of this file. It is **pure and it is shipped to the
 * client**, which is a first here, and the rule that follows from it is that the
 * server must call the same function — `store.ts` renders the same standings for
 * the Leads tab. Two implementations of "is this a target" would disagree about
 * "Lakeside Mfg" within a week, and the disagreement would surface as somebody
 * on the floor being told nothing while the report says they met the account.
 *
 * **Matching is exact, after normalisation, and deliberately not fuzzy.**
 * Normalisation strips case, punctuation and the legal suffix — "Lakeside
 * Manufacturing, Inc." and "lakeside manufacturing" are one string. Anything
 * beyond that is an alias somebody typed on purpose. The temptation is a
 * similarity score, and the reason to refuse it is that the failure is not a
 * wrong row on a screen: it is a person at a booth telling a stranger that their
 * company is one we came here for. A missed target is a missed conversation. A
 * fabricated one is an embarrassing conversation that we caused, and the person
 * holding the badge has no way to check it.
 *
 * **"Met" is derived, never stored.** A target is met because a lead exists on
 * this show whose company matches — so it moves when the lead does, an erasure
 * takes the evidence and the claim together, and "6 of 9 met" cannot disagree
 * with the list underneath it. The credit ledger's rule and the ROI attribution
 * rule, arriving from a third direction.
 */

export type TargetPriority = 'must_meet' | 'target' | 'watch';

export type TargetAccount = {
  id: string;
  companyName: string;
  aliases: string[];
  priority: TargetPriority;
  reason: string | null;
  ownerId: string | null;
  ownerName: string | null;
};

/** A lead, reduced to the only field this file reads. */
export type TargetableLead = {
  id: string;
  fullName: string;
  company: string | null;
  capturedAt: Date;
  /** Set when the row has been marked a duplicate of another. Not counted. */
  duplicateOfId?: string | null;
};

/**
 * Legal suffixes, which are noise in a company name typed at a booth.
 *
 * Conservative on purpose. "Group", "Partners" and "Technologies" are *not*
 * here: they distinguish real companies from each other ("Vance Group" is not
 * "Vance"), and stripping them would merge two accounts into one silently —
 * which is this file's failure mode pointing inward instead of outward.
 */
const SUFFIXES = new Set([
  'inc',
  'incorporated',
  'llc',
  'llp',
  'ltd',
  'limited',
  'plc',
  'corp',
  'corporation',
  'co',
  'company',
  'gmbh',
  'ag',
  'sa',
  'srl',
  'spa',
  'bv',
  'nv',
  'ab',
  'oy',
  'as',
  'aps',
  'pty',
  'pte',
  'kk',
  'kg',
]);

/**
 * A company name reduced to what two spellings of it have in common.
 *
 * Case, punctuation and a trailing legal suffix, and nothing else. Note that
 * only a *trailing* suffix goes: "Co-operative Foods" keeps its first word,
 * because `co` there is not a suffix and dropping it makes a different company.
 */
export function normalizeCompany(name: string | null | undefined): string {
  if (!name) return '';
  const words = name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  while (words.length > 1 && SUFFIXES.has(words[words.length - 1])) words.pop();
  return words.join(' ');
}

/** Every spelling this account answers to, normalised. */
export function keysFor(target: TargetAccount): string[] {
  const keys = [target.companyName, ...target.aliases].map(normalizeCompany).filter(Boolean);
  return [...new Set(keys)];
}

/**
 * Does this company, as typed, name a target account?
 *
 * Called on every keystroke of the company field in the day-of capture form, so
 * it is a linear scan over a list that is realistically under fifty rows and is
 * not indexed. If a workspace ever has a target list where that matters, the
 * index belongs here rather than in a caller.
 */
export function matchTarget(
  company: string | null | undefined,
  targets: TargetAccount[],
): TargetAccount | null {
  const key = normalizeCompany(company);
  if (!key) return null;
  return targets.find((t) => keysFor(t).includes(key)) ?? null;
}

export type TargetStanding = {
  target: TargetAccount;
  /** Every lead on this show that matched. Empty means unmet. */
  leads: TargetableLead[];
  met: boolean;
  /**
   * A must-meet with nobody's name on it. Escalates rather than going quiet —
   * `show_deadlines.owner_id`'s rule, and the same reason: an alert addressed to
   * an owner who does not exist reaches nobody, silently, on the row that most
   * needs it.
   */
  unowned: boolean;
};

const RANK: Record<TargetPriority, number> = { must_meet: 0, target: 1, watch: 2 };

/**
 * Every target, with whether it has been met — worst first.
 *
 * "Worst" is unmet before met, then priority, then name; the board is read at
 * hour six of day two and the first row has to be the one worth walking across
 * the hall for. Duplicate-marked leads do not count, for the reason they do not
 * count anywhere else: the same conversation twice is one conversation.
 */
export function targetStandings(
  targets: TargetAccount[],
  leads: TargetableLead[],
): TargetStanding[] {
  const countable = leads.filter((l) => !l.duplicateOfId);
  return targets
    .map((target) => {
      const keys = keysFor(target);
      const hits = countable
        .filter((l) => keys.includes(normalizeCompany(l.company)))
        .sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());
      return {
        target,
        leads: hits,
        met: hits.length > 0,
        unowned: target.ownerId === null && target.priority === 'must_meet',
      };
    })
    .sort((a, b) => {
      if (a.met !== b.met) return a.met ? 1 : -1;
      if (RANK[a.target.priority] !== RANK[b.target.priority]) {
        return RANK[a.target.priority] - RANK[b.target.priority];
      }
      return a.target.companyName.localeCompare(b.target.companyName);
    });
}

export type TargetSummary = {
  total: number;
  met: number;
  mustMeetUnmet: number;
  unowned: number;
  /** What the header says. Never a bare ratio; see below. */
  sentence: string;
};

/**
 * The one sentence at the top of the target card.
 *
 * "6 of 9 met" is the obvious rendering and it is the §8c failure again: a ratio
 * over a list somebody typed reads as a measure of the show when it is a measure
 * of the list. So the count is stated, and the thing worth acting on — a
 * must-meet nobody has spoken to — is named ahead of it rather than averaged
 * into it.
 */
export function summarizeTargets(standings: TargetStanding[]): TargetSummary {
  const met = standings.filter((s) => s.met).length;
  const mustMeetUnmet = standings.filter((s) => !s.met && s.target.priority === 'must_meet').length;
  const unowned = standings.filter((s) => s.unowned).length;
  const total = standings.length;

  let sentence: string;
  if (total === 0) {
    // Not "0 of 0 met", which renders as either perfect or a failure and is
    // neither. Nobody has said who we came here for.
    sentence = 'No target accounts on this show yet.';
  } else if (mustMeetUnmet > 0) {
    sentence = `${mustMeetUnmet} must-meet account${mustMeetUnmet === 1 ? '' : 's'} not spoken to yet — ${met} of ${total} targets met.`;
  } else {
    sentence = `${met} of ${total} target accounts met.`;
  }
  return { total, met, mustMeetUnmet, unowned, sentence };
}
