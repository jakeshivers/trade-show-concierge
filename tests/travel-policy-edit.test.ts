import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, isNull, desc } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import { getActor, ForbiddenError, type Actor } from '@/lib/auth/actor';
import { PolicyEditError, toPolicyRow, type PolicyFormInput } from '@/lib/travel/policy-edit';
import { listPolicyLayers, resolveTravelPolicy, saveOrgPolicy } from '@/lib/travel/policy-store';

/**
 * The editor the policy engine has been waiting for since step 3.
 *
 * `policy/validate.ts` carries the comment "Consumed by the admin policy editor
 * (build step 7)" and was called by nothing. What matters here is not that a row
 * saves — it is that **a policy which would make the agent refuse everything
 * cannot be saved**, and that saving never rewrites the rules a past booking was
 * judged under.
 */

const db = getDb();
const ADMIN = 'shelley@northwindrobotics.test';
const MEMBER = 'priya@northwindrobotics.test';

async function actorFor(email: string): Promise<Actor> {
  process.env.DEV_ACTOR_EMAIL = email;
  return getActor();
}

const form = (over: Partial<PolicyFormInput> = {}): PolicyFormInput => ({
  label: 'test',
  maxAirfareDomestic: '850.00',
  maxAirfareInternational: '2400.00',
  autoApproveUnder: '600.00',
  denyOver: '3000.00',
  maxCabinDomestic: 'economy',
  maxCabinInternational: 'business',
  premiumCabinAllowedOverHours: '6',
  minAdvanceBookingDays: '14',
  maxStops: '1',
  minConnectionMinutes: '45',
  arrivalBufferHoursBeforeMoveIn: '4',
  nonRefundableAllowedUnder: '400.00',
  maxAcceptableRefundPenalty: '150.00',
  preferredAirlines: 'AA UA',
  blockedAirlines: null,
  personalCarrierAllowance: null,
  maxHotelNightlyRate: '350.00',
  perShowTravelBudget: '12000.00',
  requireCreditFirst: true,
  ...over,
});

let admin: Actor;
let originalId: string;

beforeAll(async () => {
  admin = await actorFor(ADMIN);
  const live = await db
    .select()
    .from(s.travelPolicies)
    .where(
      and(
        eq(s.travelPolicies.orgId, admin.orgId),
        eq(s.travelPolicies.scope, 'org'),
        isNull(s.travelPolicies.supersededAt),
      ),
    )
    .orderBy(desc(s.travelPolicies.version))
    .limit(1);
  originalId = live[0].id;
});

afterAll(async () => {
  // Remove every version this suite added and put the seeded one back live.
  await db
    .delete(s.travelPolicies)
    .where(and(eq(s.travelPolicies.orgId, admin.orgId), eq(s.travelPolicies.label, 'test')));
  await db
    .update(s.travelPolicies)
    .set({ supersededAt: null })
    .where(eq(s.travelPolicies.id, originalId));
});

describe('parsing the form', () => {
  it('parses money as decimals, never floats', () => {
    expect(toPolicyRow(form({ maxAirfareDomestic: '850.05' })).maxAirfareDomesticCents).toBe(85_005);
  });

  it('treats blank as "no rule" rather than zero', () => {
    // The distinction the whole layering model rests on.
    expect(toPolicyRow(form({ maxAirfareDomestic: '' })).maxAirfareDomesticCents).toBeNull();
  });

  it('takes IATA codes and refuses airline names', () => {
    expect(toPolicyRow(form({ preferredAirlines: 'aa, ua ,dl' })).preferredAirlines).toEqual([
      'AA', 'UA', 'DL',
    ]);
    expect(() => toPolicyRow(form({ preferredAirlines: 'United' }))).toThrow(PolicyEditError);
  });

  it('refuses a number that is a typo rather than a rule', () => {
    expect(() => toPolicyRow(form({ maxStops: '40' }))).toThrow(PolicyEditError);
  });
});

describe('saving', () => {
  it('supersedes rather than editing in place', async () => {
    const before = await listPolicyLayers(admin);
    const liveBefore = before.find((l) => l.scope === 'org' && l.supersededAt === null)!;

    const { version } = await saveOrgPolicy(admin, toPolicyRow(form()));
    expect(version).toBe(liveBefore.version + 1);

    const after = await listPolicyLayers(admin);
    // The old row still exists and still carries its own numbers — a booking
    // made under it can still say what it was judged against.
    const old = after.find((l) => l.id === liveBefore.id)!;
    expect(old.supersededAt).not.toBeNull();
    expect(old.maxAirfareDomesticCents).toBe(liveBefore.maxAirfareDomesticCents);
  });

  it('refuses a policy the agent could never book against, and rolls back', async () => {
    const before = await listPolicyLayers(admin);
    const liveBefore = before.find((l) => l.scope === 'org' && l.supersededAt === null)!;

    // Auto-approve above the deny ceiling: nothing is ever approvable, and the
    // symptom would be "the agent cannot find flights".
    await expect(
      saveOrgPolicy(admin, toPolicyRow(form({ autoApproveUnder: '9000.00', denyOver: '3000.00' }))),
    ).rejects.toThrow(PolicyEditError);

    const after = await listPolicyLayers(admin);
    const liveAfter = after.find((l) => l.scope === 'org' && l.supersededAt === null)!;
    // Rolled back completely: same row live, no orphan version left behind.
    expect(liveAfter.id).toBe(liveBefore.id);
    expect(after.length).toBe(before.length);

    // And the policy still resolves, which is what the agent depends on.
    await expect(resolveTravelPolicy(admin.orgId, {})).resolves.toBeTruthy();
  });

  it('will not let a Member near it', async () => {
    const priya = await actorFor(MEMBER);
    await expect(saveOrgPolicy(priya, toPolicyRow(form()))).rejects.toThrow(ForbiddenError);
    await expect(listPolicyLayers(priya)).rejects.toThrow(ForbiddenError);
    await actorFor(ADMIN);
  });
});
