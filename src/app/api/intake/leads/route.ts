import { NextResponse, type NextRequest } from 'next/server';
import { readBearer, REFUSALS } from '@/lib/leads/intake';
import { intakeLead, resolveIntakeKey } from '@/lib/leads/store';

/**
 * `POST /api/intake/leads` — the REST intake endpoint. SCOPE.md §2, "CSV import
 * **and a REST intake endpoint** so any scanner can feed us".
 *
 * The only route in this product that is not a person at a screen, and the only
 * one that authenticates without `getActor()`. What it holds is a token, and
 * `resolveIntakeKey` turns that into an `IntakePrincipal` — deliberately not an
 * `Actor`, so this handler cannot reach anything else in the app even by
 * mistake. `intake.ts` has the argument.
 *
 * Three response decisions worth stating, because each is a way an intake
 * endpoint teaches its callers to behave badly:
 *
 * - **A duplicate is 200, not 409.** A scanner on convention-centre wifi retries
 *   requests whose responses it never saw, and answering "conflict" makes a
 *   correctly-recorded lead look like a failure — after which somebody writes a
 *   retry loop that manufactures the duplicates the endpoint exists to prevent.
 *   The body says `duplicate` and names the lead it matched, so a caller that
 *   wants to know can.
 * - **A validation failure is 422 with the sentence a person would be shown.**
 *   The same `validateLead` a form goes through, so the endpoint and the screen
 *   cannot disagree about what a lead is.
 * - **A wrong or unknown show is one answer.** A caller enumerating show ids
 *   must not learn which exist in another workspace, which is §3's rule about a
 *   Member loading a colleague's travel request.
 *
 * It is deliberately unbatched. A batch endpoint has to decide what a partial
 * failure means, and the honest answer — some written, some not, here is the
 * list — is `commitImport`, which already exists behind a screen where a person
 * can read it.
 */

export const dynamic = 'force-dynamic';

type Body = {
  showId?: unknown;
  fullName?: unknown;
  email?: unknown;
  phone?: unknown;
  company?: unknown;
  title?: unknown;
  notes?: unknown;
  interests?: unknown;
  externalRef?: unknown;
  consentBasis?: unknown;
  consentNotice?: unknown;
};

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;

export async function POST(request: NextRequest) {
  const token = readBearer(request.headers.get('authorization'));
  if (!token) {
    const r = REFUSALS.noCredential();
    return NextResponse.json({ error: r.message, kind: r.kind }, { status: r.status });
  }

  const resolved = await resolveIntakeKey(token);
  if ('refusal' in resolved) {
    return NextResponse.json(
      { error: resolved.refusal.message, kind: resolved.refusal.kind },
      { status: resolved.refusal.status },
    );
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    const r = REFUSALS.invalid('The request body is not JSON.');
    return NextResponse.json({ error: r.message, kind: r.kind }, { status: r.status });
  }

  // A key scoped to one show may omit `showId` entirely, which is the shape a
  // scanner's fixed configuration actually has.
  const showId = str(body.showId) ?? resolved.principal.showId;
  if (!showId) {
    const r = REFUSALS.invalid(
      'No showId, and this key is not scoped to a show. Send `showId`, or use a key issued for one show.',
    );
    return NextResponse.json({ error: r.message, kind: r.kind }, { status: r.status });
  }

  const outcome = await intakeLead(resolved.principal, {
    showId,
    input: {
      fullName: str(body.fullName) ?? '',
      email: str(body.email),
      phone: str(body.phone),
      company: str(body.company),
      title: str(body.title),
      notes: str(body.notes),
      interests: Array.isArray(body.interests)
        ? body.interests.filter((i): i is string => typeof i === 'string')
        : null,
      externalRef: str(body.externalRef),
      // Absent means absent. The endpoint will not read a missing field as
      // consent, which is `consent.ts`'s first rule reached through HTTP.
      basis: str(body.consentBasis),
      consentNotice: str(body.consentNotice),
    },
  });

  switch (outcome.kind) {
    case 'created':
      return NextResponse.json({ status: 'created', leadId: outcome.leadId }, { status: 201 });
    case 'duplicate':
      return NextResponse.json(
        { status: 'duplicate', leadId: outcome.leadId, detail: outcome.reason },
        { status: 200 },
      );
    case 'refused':
      return NextResponse.json(
        { error: outcome.refusal.message, kind: outcome.refusal.kind },
        { status: outcome.refusal.status },
      );
  }
}
