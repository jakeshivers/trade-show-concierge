import { getActor, isAdmin } from '@/lib/auth/actor';
import { listCostCenters } from '@/lib/costcenters/store';
import { Badge, Card, Empty, PageHeader, Table, Td, Th } from '../../_components/ui';
import { AddCostCenterForm, RenameForm, ToggleForm } from './forms';

/**
 * The dimension every financial row is required to carry, and which nothing in
 * this app could create until now.
 *
 * §4 is enforced everywhere — an expense, a hotel, a side event, a crate, an
 * asset and a collateral item all refuse to save without a cost center — and
 * `scripts/seed.ts` was the only thing that had ever made one. A real
 * organization therefore starts with an empty list and *every* money-filing form
 * in the product is unsubmittable, with no error saying why: the select is
 * simply empty.
 */

export const metadata = { title: 'Cost centers' };
export const dynamic = 'force-dynamic';

export default async function CostCentersPage() {
  const actor = await getActor();
  if (!isAdmin(actor)) {
    return (
      <Empty>
        Cost centers are the shape of the budget, so only an admin changes them. You pick one
        wherever this app files money.
      </Empty>
    );
  }

  const centers = await listCostCenters(actor);
  const active = centers.filter((c) => c.active);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Cost centers"
        blurb="Every financial row in this product carries one from the moment it is created, and none of them can be reassigned afterwards. That is why they are here rather than typed in beside each invoice."
      />

      {active.length === 0 && (
        <p className="rounded-md bg-warn-soft px-3 py-2 text-sm text-warn">
          There are no active cost centers, so nothing in this workspace can file money yet —
          not an invoice, a hotel, a side event, a crate or a print run. Add one below.
        </p>
      )}

      <Card title="In use">
        {centers.length === 0 ? (
          <Empty>
            None yet. A cost center starts being used the moment somebody files an expense, hotel,
            crate, asset or print run against it.
          </Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Code</Th>
                <Th>Name</Th>
                <Th numeric>Expenses</Th>
                <Th numeric>People</Th>
                <Th>{''}</Th>
              </tr>
            </thead>
            <tbody>
              {centers.map((c) => (
                <tr key={c.id}>
                  <Td>
                    <span className="font-mono text-xs">{c.code}</span>
                    {!c.active && (
                      <Badge tone="neutral" className="ml-2">off</Badge>
                    )}
                  </Td>
                  <Td>
                    <RenameForm id={c.id} name={c.name} />
                  </Td>
                  <Td numeric>{c.expenses}</Td>
                  <Td numeric>{c.people}</Td>
                  <Td>
                    <ToggleForm id={c.id} active={c.active} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <p className="mt-3 text-xs text-text-muted">
          A cost center is switched off rather than deleted, and its code cannot be changed.
          Everything already filed against one points at it — a delete would either be refused
          by the database or would quietly strip the dimension off historical rows, which is the
          state the &ldquo;never backfilled&rdquo; rule exists to prevent, reached from the other end.
        </p>
      </Card>

      <Card title="Add one">
        <AddCostCenterForm />
      </Card>
    </div>
  );
}
