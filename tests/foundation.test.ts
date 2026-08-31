import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import {
  getActor,
  canApproveRequestFor,
  canApprove,
  isAdmin,
  routeApproval,
  isValidBreakGlass,
} from '@/lib/auth/actor';

/**
 * Step 1 foundation checks. These exist so later steps have a known-good base:
 * if the seam or the seed breaks, this fails before anything downstream does.
 */

const db = getDb();

describe('seed', () => {
  it('creates one org with a staffed team', async () => {
    const orgs = await db.select().from(s.organizations);
    expect(orgs).toHaveLength(1);

    const people = await db.select().from(s.users);
    expect(people).toHaveLength(6);
    expect(people.filter((p) => p.role === 'admin')).toHaveLength(1);
    expect(people.filter((p) => p.role === 'travel_manager')).toHaveLength(1);
  });

  it('gives every user a cost center', async () => {
    const people = await db.select().from(s.users);
    expect(people.every((p) => p.costCenterId !== null)).toBe(true);
  });

  it('records the advance order deadline with a dollar penalty', async () => {
    const deadlines = await db
      .select()
      .from(s.showDeadlines)
      .where(eq(s.showDeadlines.kind, 'advance_order'));

    expect(deadlines.length).toBeGreaterThan(0);
    // A deadline without a dollar figure is a nag, not a decision. SCOPE.md §5a.
    expect(deadlines.every((d) => d.penaltyEstimateCents !== null)).toBe(true);
  });

  it('keeps scheduled and live flight times in separate columns', async () => {
    // No flights seeded yet, but the shape must hold: scheduled is non-nullable,
    // estimated is nullable. SCOPE.md non-negotiable #3.
    const cols = s.flights;
    expect(cols.scheduledDeparture.notNull).toBe(true);
    expect(cols.estimatedDeparture.notNull).toBe(false);
  });
});

describe('getActor seam', () => {
  it('resolves a seeded dev actor', async () => {
    process.env.DEV_ACTOR_EMAIL = 'shelley@northwindrobotics.test';
    const actor = await getActor();
    expect(actor.fullName).toBe('Shelley Shivers');
    expect(actor.role).toBe('admin');
    expect(isAdmin(actor)).toBe(true);
  });

  it('rejects when no actor is configured', async () => {
    delete process.env.DEV_ACTOR_EMAIL;
    await expect(getActor()).rejects.toThrow('No authenticated actor');
  });
});

describe('separation of duties', () => {
  let manager: Awaited<ReturnType<typeof getActor>>;
  let member: Awaited<ReturnType<typeof getActor>>;

  beforeAll(async () => {
    process.env.DEV_ACTOR_EMAIL = 'marcus@northwindrobotics.test';
    manager = await getActor();
    process.env.DEV_ACTOR_EMAIL = 'priya@northwindrobotics.test';
    member = await getActor();
  });

  it('lets a travel manager approve someone else', () => {
    expect(canApprove(manager)).toBe(true);
    expect(canApproveRequestFor(manager, member.userId)).toBe(true);
  });

  it('never lets anyone approve their own request', () => {
    expect(canApproveRequestFor(manager, manager.userId)).toBe(false);
  });

  it('does not let a member approve at all', () => {
    expect(canApprove(member)).toBe(false);
    expect(canApproveRequestFor(member, manager.userId)).toBe(false);
  });

  it('never lets an impersonating admin approve', async () => {
    process.env.DEV_ACTOR_EMAIL = 'shelley@northwindrobotics.test';
    const admin = await getActor();
    expect(canApproveRequestFor(admin, member.userId)).toBe(true);

    // Impersonation must not become a path around the approval rule. SCOPE.md §3.
    const impersonating = { ...admin, impersonatedBy: admin.userId };
    expect(canApproveRequestFor(impersonating, member.userId)).toBe(false);
  });
});

describe('approval routing', () => {
  const member = { userId: 'u1', role: 'member' } as never;
  const manager = { userId: 'u2', role: 'travel_manager' } as never;
  const admin = { userId: 'u3', role: 'admin' } as never;

  it('routes to eligible approvers when they exist', () => {
    const route = routeApproval('u1', [member, manager, admin]);
    expect(route.kind).toBe('eligible_approvers');
    if (route.kind === 'eligible_approvers') {
      expect(route.approverIds).toEqual(['u2', 'u3']);
    }
  });

  it('excludes the requester from their own approver list', () => {
    const route = routeApproval('u2', [member, manager, admin]);
    if (route.kind !== 'eligible_approvers') throw new Error('expected approvers');
    expect(route.approverIds).toEqual(['u3']);
  });

  it('falls back to break-glass when the only approver is the requester', () => {
    // A one-admin org must not deadlock on its own separation-of-duties rule.
    const route = routeApproval('u3', [member, admin]);
    expect(route.kind).toBe('break_glass');
  });

  it('requires a real justification for break-glass', () => {
    expect(isValidBreakGlass('ok')).toBe(false);
    expect(isValidBreakGlass('Sole admin; board meeting travel, fare expires today.')).toBe(true);
  });
});
