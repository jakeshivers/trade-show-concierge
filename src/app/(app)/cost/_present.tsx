import { CATEGORY_LABEL, type CostLine, type CoverageGap, type ShowCost } from '@/lib/cost/rollup';
import { Badge, Table, Td, Th, money, type Tone } from '../_components/ui';

/**
 * The cost vocabulary both cost screens render through — the portfolio and the
 * show's own tab.
 *
 * Same reason `shipping/_present.tsx` exists: the moment two screens draw the
 * same figure they can disagree about what it means, and nothing would catch it.
 * Here the thing they must not disagree about is the *word in front of the
 * number*. A total is called "true cost" only when coverage is complete and "at
 * least" otherwise, and one screen quietly saying "total" would undo the whole
 * argument for the second half of this page.
 */

export const COVERAGE_TONE: Record<string, Tone> = {
  complete: 'good',
  partial: 'warn',
  thin: 'bad',
  empty: 'neutral',
};

/* "a floor" and "thin" were the docs' words for these, on a badge read by
 * somebody deciding whether to trust the number beside it. What they need to
 * know is how much of the bill is missing. See `leads/_present.tsx`. */
export const COVERAGE_LABEL: Record<string, string> = {
  complete: 'complete',
  partial: 'some costs missing',
  thin: 'most costs missing',
  empty: 'nothing recorded',
};

const GAP_TONE: Record<CoverageGap['kind'], Tone> = {
  unpriced: 'warn',
  absent: 'bad',
  assumption: 'info',
  double_count: 'info',
};

const GAP_LABEL: Record<CoverageGap['kind'], string> = {
  unpriced: 'no figure',
  absent: 'missing',
  assumption: 'assumed',
  double_count: 'may be the same money',
};

/** The headline, and the word in front of it. Never a bare number. */
export function CostHeadline({ cost }: { cost: ShowCost }) {
  return (
    <div className="flex flex-wrap items-baseline gap-3">
      <span className="text-xs font-medium uppercase tracking-wider text-text-muted">
        {cost.isFloor ? 'At least' : 'True cost'}
      </span>
      <span className="tabular text-3xl font-semibold tracking-tight">
        {money(cost.totalCents)}
      </span>
      <Badge tone={COVERAGE_TONE[cost.coverage.verdict]}>
        coverage: {COVERAGE_LABEL[cost.coverage.verdict]}
      </Badge>
    </div>
  );
}

export function CostLines({ lines }: { lines: CostLine[] }) {
  const shown = lines.filter((l) => l.cents > 0 || l.counted > 0 || l.gaps.length > 0);
  return (
    <Table>
      <thead>
        <tr>
          <Th>Line</Th>
          <Th numeric>Recorded</Th>
          <Th numeric>Paid</Th>
          <Th numeric>Rows</Th>
          <Th>What is missing from it</Th>
        </tr>
      </thead>
      <tbody>
        {shown.map((line) => (
          <tr key={line.category}>
            <Td>{CATEGORY_LABEL[line.category]}</Td>
            <Td numeric>{money(line.cents)}</Td>
            <Td numeric>{line.cents === 0 ? '—' : money(line.paidCents)}</Td>
            <Td numeric>{line.counted}</Td>
            <Td>
              {line.gaps.length === 0 ? (
                <span className="text-text-muted">—</span>
              ) : (
                <ul className="space-y-1">
                  {line.gaps.map((gap, i) => (
                    <li key={i} className="text-xs">
                      <Badge tone={GAP_TONE[gap.kind]}>{GAP_LABEL[gap.kind]}</Badge>{' '}
                      <span className="text-text-muted">{gap.what}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/**
 * The three figures that sit *beside* the total rather than inside it, each for
 * a different reason, and each of which would be a wrong number if added.
 */
export function CostMemos({ cost }: { cost: ShowCost }) {
  return (
    <dl className="space-y-3 text-sm">
      {cost.creditFundedCents > 0 && (
        <div>
          <dt className="font-medium">{money(cost.creditFundedCents)} covered by ticket credits</dt>
          <dd className="text-text-muted">
            Not added. That money was spent last year on a ticket somebody cancelled, and the
            show it was bought for already carries it — counting it here would bill the same
            dollars to two shows. Counting only the cash and saying nothing would make a trip
            flown entirely on credit look free.
          </dd>
        </div>
      )}
      {cost.consumedCents > 0 && (
        <div>
          <dt className="font-medium">{money(cost.consumedCents)} of stock issued to this show</dt>
          <dd className="text-text-muted">
            Valued at unit cost, and not added. A print run is an outlay on the show that
            ordered it; what a later show takes off the shelf is a valuation of things already
            paid for. Both are real and only one of them is money.
          </dd>
        </div>
      )}
      {/*
        Drayage: the fourth memo, and the only one whose figure is a *prediction*
        rather than real money in the wrong period. Which is why it is here and
        not in the total, and why it says so in the first clause rather than a
        footnote — the number beside it is somebody else's future invoice.
      */}
      <div>
        {cost.drayage.estimate.ok ? (
          <>
            <dt className="font-medium">
              {cost.drayage.isFloor ? 'At least ' : ''}
              {money(cost.drayage.estimate.cents)} of drayage, estimated
            </dt>
            <dd className="text-text-muted">
              Not added — nobody has been billed this yet. It is the general contractor’s
              charge for moving freight between the dock and the booth, computed from this
              show’s rate card and the weight of its crates
              {cost.drayage.confirmed
                ? '.'
                : ', from a card nobody has checked against this year’s manual — contractors re-price annually.'}
              {cost.drayage.billedCents !== null && (
                <>
                  {' '}
                  The real bill came to <strong>{money(cost.drayage.billedCents)}</strong> and{' '}
                  <em>is</em> in the total above. A gap between the two is usually freight that
                  went in loose.
                </>
              )}
            </dd>
          </>
        ) : (
          <>
            <dt className="font-medium">Drayage is not in this figure</dt>
            <dd className="text-text-muted">{cost.drayage.estimate.reason}</dd>
          </>
        )}
      </div>
      {cost.attendeeDays !== null && (
        <div>
          <dt className="font-medium">{cost.attendeeDays} attendee-days on site</dt>
          <dd className="text-text-muted">
            Deliberately not priced. Whether staff time belongs in a show’s cost is an open
            decision (SCOPE §11.8), and there is no loaded rate recorded anywhere in this
            workspace — so a dollar figure here would be a number we invented, which is the one
            thing this page exists not to do.
          </dd>
        </div>
      )}
    </dl>
  );
}
