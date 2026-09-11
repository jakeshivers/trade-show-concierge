import {
  MATURITY_LABEL,
  type Maturity,
  type Quotable,
  type RoiGap,
  type ShowRoi,
} from '@/lib/roi/rollup';
import { Badge, Table, Td, Th, money, type Tone } from '../_components/ui';

/**
 * The ROI vocabulary both screens render through — the portfolio and the show's
 * own tab.
 *
 * Same reason `cost/_present.tsx` and `shipping/_present.tsx` exist, and here it
 * is load-bearing rather than tidy. The thing these two screens must never
 * disagree about is **whether a figure is printed at all**. A withheld number
 * that one screen quietly prints anyway is not a styling inconsistency; it is
 * the fabricated bill arriving by the back door, on the screen a budget gets set
 * from. So `Figure` is the only way a per-unit number reaches a page, and the
 * reason travels with it.
 */

export const MATURITY_TONE: Record<Maturity, Tone> = {
  future: 'neutral',
  immature: 'info',
  maturing: 'warn',
  mature: 'good',
};

export { MATURITY_LABEL };

const GAP_TONE: Record<RoiGap['kind'], Tone> = {
  cost: 'warn',
  leads: 'warn',
  matching: 'info',
  maturity: 'info',
  replay: 'bad',
  disagreement: 'warn',
};

/* `UI-REWORK.md` §14, a third time: "a floor" is the docs' word for these and
 * says nothing to somebody deciding whether to trust the number above them. */
const GAP_LABEL: Record<RoiGap['kind'], string> = {
  cost: 'cost incomplete',
  leads: 'count incomplete',
  matching: 'matching',
  maturity: 'too early',
  replay: 'replayed',
  disagreement: 'two figures',
};

/**
 * One number, or the sentence explaining why there is not one.
 *
 * A withheld figure is rendered as prominently as a quoted one, deliberately. A
 * greyed-out dash trains a reader to skip it, and the reason is the part of this
 * page that is worth anything — "2 of 3 people on the booth recorded nothing" is
 * a thing somebody can act on, and "—" is not.
 */
export function Figure({
  label,
  value,
  note,
}: {
  label: string;
  value: Quotable | { ok: true; multiple: number } | { ok: false; reason: string };
  note?: string;
}) {
  const shown =
    value.ok
      ? 'cents' in value
        ? money(value.cents)
        : `${value.multiple.toFixed(1)}×`
      : null;
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium uppercase tracking-wider text-text-muted">{label}</p>
      {shown !== null ? (
        <>
          <p className="tabular text-2xl font-semibold tracking-tight">{shown}</p>
          {note && <p className="text-xs text-text-muted">{note}</p>}
        </>
      ) : (
        <>
          <p className="text-sm font-medium text-warn">Not shown</p>
          <p className="text-xs text-text-muted">{(value as { reason: string }).reason}</p>
        </>
      )}
    </div>
  );
}

/** The banner a replayed workspace must carry, in one place so it cannot drift. */
export function ReplayBanner() {
  return (
    <div className="rounded-lg border border-bad/40 bg-bad-soft p-3 text-sm">
      <p className="font-medium">These pipeline figures are replayed, not read from a CRM.</p>
      <p className="mt-1 text-text-muted">
        No CRM is connected, so the numbers below are a general pattern for how booth
        conversations convert — they say nothing about this company. Because a warning on a
        money figure is easy to read past, <strong>every ratio built on them is left
        blank</strong> rather than printed with a note attached.
      </p>
    </div>
  );
}

export function RoiGaps({ gaps }: { gaps: RoiGap[] }) {
  if (gaps.length === 0) {
    return (
      <p className="text-sm text-text-muted">
        Nothing is missing from the figures above — both halves are complete and the window is
        stated on every one.
      </p>
    );
  }
  return (
    <ul className="space-y-2">
      {gaps.map((gap, i) => (
        <li key={i} className="text-sm">
          <Badge tone={GAP_TONE[gap.kind]}>{GAP_LABEL[gap.kind]}</Badge>{' '}
          <span className="text-text-muted">{gap.what}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Where the matching went — and the one table on this page whose columns must
 * never be summed into a single "match rate".
 *
 * `Not sent by us` is this product refusing on a stranger's behalf; `Not in the
 * CRM` is the customer's CRM answering. A single percentage would make the first
 * look like the second, which is the misreading that gets step 18's refusal
 * removed. On screen the word is "not sent" rather than "withheld", because
 * `/roi` was using that one word for two different acts at once — a figure we
 * decline to print and a lead we decline to transmit.
 */
export function MatchTable({ roi }: { roi: ShowRoi }) {
  const m = roi.matching;
  const rows: { label: string; n: number; why: string }[] = [
    { label: 'Linked to a CRM record', n: m.matched, why: 'These are what pipeline is attributed through.' },
    {
      label: 'Not sent by us',
      n: m.withheld,
      why: 'Nobody recorded what these people were told at the booth, so nothing about them is sent to a third party. They are still held and still counted — they just cannot appear in a pipeline figure. Recording it on the Leads tab is what changes that.',
    },
    {
      label: 'Not in the CRM',
      n: m.unmatched,
      why: 'Offered and not found. An ordinary outcome for a booth conversation that went nowhere.',
    },
    {
      label: 'Erased',
      n: m.erased,
      why: 'Redacted on request or past retention. The link was removed on purpose; the count did not move.',
    },
    {
      label: 'Never offered to a CRM',
      n: m.unsynced,
      why: 'No sync has looked at them yet — which is different from the CRM not knowing them, and is fixed by running one.',
    },
  ];
  return (
    <Table>
      <thead>
        <tr>
          <Th>Leads</Th>
          <Th numeric>Count</Th>
          <Th>What it means</Th>
        </tr>
      </thead>
      <tbody>
        {rows
          .filter((r) => r.n > 0)
          .map((r) => (
            <tr key={r.label}>
              <Td>{r.label}</Td>
              <Td numeric>{r.n}</Td>
              <Td>
                <span className="text-xs text-text-muted">{r.why}</span>
              </Td>
            </tr>
          ))}
      </tbody>
    </Table>
  );
}
