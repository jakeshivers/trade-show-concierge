import Link from 'next/link';
import { Badge, Card } from '../_components/ui';
import type { TranscriptEntry } from '@/lib/assistant/store';

/**
 * How a transcript is drawn — and the one framing decision on this screen.
 *
 * A chat UI's natural shape is prose with the machinery hidden behind a
 * disclosure triangle nobody opens. That is the wrong default *here*, because
 * the prose is the least reliable thing on the page. Everything else in this
 * product is a value out of a store rendered directly; an assistant message is a
 * paraphrase of one, produced by the only component in the system that can be
 * confidently wrong.
 *
 * So a tool step renders as a visible row: what ran, with which arguments, and
 * what it returned. Collapsed by default because a shipment board is four
 * hundred lines, but *present* — a person who doubts a sentence can open the
 * thing it was written from, on the same screen, without being told to go and
 * check. A number the model got wrong is then contradicted rather than standing
 * alone, which is the difference between a wrong answer and an undetectable one.
 */

const TOOL_LABEL: Record<string, string> = {
  list_shows: 'the show calendar',
  get_show: 'a show',
  my_itinerary: 'your itinerary',
  readiness_portfolio: 'readiness across every show',
  show_checklist: "a show's checklist",
  deadline_register: "a show's deadline register",
  team_board: "a show's roster and coverage",
  staffing_conflicts: 'cross-show staffing conflicts',
  lodging_board: "a show's hotels",
  flight_board: 'the flight board',
  shipment_board: 'the shipping board',
  travel_requests: 'travel requests',
  travel_request: 'one travel request',
  people: 'who you may request travel for',
  cost_centers: 'cost centers',
  draft_travel_request: 'drafted a travel request',
  draft_lodging: 'drafted a lodging record',
};

export function ToolStepRow({ entry }: { entry: Extract<TranscriptEntry, { kind: 'tool' }> }) {
  const label = TOOL_LABEL[entry.name] ?? entry.name;

  if (entry.error) {
    return (
      <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs">
        <div className="flex items-center gap-2">
          <Badge tone="warn">not available</Badge>
          <span className="text-text-muted">
            Tried to read {label} and could not.
          </span>
        </div>
        <p className="mt-1 text-text-muted">{entry.error}</p>
      </div>
    );
  }

  return (
    <details className="rounded-lg border border-border bg-surface px-3 py-2 text-xs">
      <summary className="cursor-pointer list-none text-text-muted marker:hidden">
        <span className="font-medium text-text">Read {label}</span>
        {entry.input && Object.keys(entry.input).length > 0 && (
          <span className="ml-2 font-mono text-[11px]">
            {Object.entries(entry.input)
              .map(([k, v]) => `${k}=${String(v)}`)
              .join(' ')}
          </span>
        )}
        <span className="ml-2">— open what it returned</span>
      </summary>
      <pre className="tabular mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-panel p-2 text-[11px] leading-relaxed">
        {JSON.stringify(entry.result, null, 1)}
      </pre>
    </details>
  );
}

export function DraftNotice({
  travelRequestId,
  lodgingId,
}: {
  travelRequestId: string | null;
  lodgingId: string | null;
}) {
  if (!travelRequestId && !lodgingId) return null;

  return (
    <Card className="border-warn/40">
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone="warn">draft — nothing is booked</Badge>
        {travelRequestId && (
          <span className="text-sm">
            A travel request was filed with the constraints as parsed. Nothing has been
            searched or priced, and the booking agent will not search it until you have
            read the parse and confirmed it.{' '}
            <Link className="font-medium text-brand underline" href={`/travel/${travelRequestId}`}>
              Review and confirm →
            </Link>
          </span>
        )}
        {lodgingId && (
          <span className="text-sm">
            A hotel record was created. This app tracks hotels rather than reserving them,
            and the room block cutoff was left blank on purpose — setting it creates a
            deadline the alert engine will chase, so it needs a date off the contract.
          </span>
        )}
      </div>
    </Card>
  );
}

export function ScriptedBanner() {
  return (
    <Card className="border-warn/40">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <Badge tone="warn">scripted</Badge>
        <span>
          No language model is configured, so this assistant is a keyword matcher. It picks
          which tools to run and reads them out of the workspace for real — every figure
          below is live — but it writes no prose of its own, because a canned sentence about
          a workspace is a fabricated claim in a way a canned tracking payload is not. Set{' '}
          <code className="rounded bg-surface px-1 py-0.5 text-xs">ANTHROPIC_API_KEY</code> for
          the real thing.
        </span>
      </div>
    </Card>
  );
}
