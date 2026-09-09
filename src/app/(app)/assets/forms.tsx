'use client';

import { useActionState, useState } from 'react';
import type { AssetRow } from '@/lib/assets/board';
import type { AssetOption } from '@/lib/assets/board';
import type { ShowAllocationRow } from '@/lib/assets/store';
import type { CollateralRow } from '@/lib/assets/store';
import { Badge } from '../_components/ui';
import { Field, Form, Input, Message, QuietSubmit, Select, Submit, Textarea, ZonedDateTime } from '../_components/form-ui';
import { AvailabilityNote } from './_present';
import {
  addAsset,
  addCollateral,
  allocate,
  countBack,
  moveStock,
  packAllocation,
  release,
  removeAsset,
  removeCollateral,
  reserve,
  rewindow,
  signIn,
  signOut,
  unallocate,
  updateAsset,
  updateCollateral,
} from './actions';

export type CostCenter = { id: string; code: string; name: string };

const KINDS = [
  ['booth', 'Booth'],
  ['display', 'Display'],
  ['furniture', 'Furniture'],
  ['av_equipment', 'AV equipment'],
  ['crate', 'Crate'],
  ['other', 'Other'],
] as const;

/* --------------------------------- assets ---------------------------------- */

function AssetFields({ row, costCenters }: { row?: AssetRow; costCenters: CostCenter[] }) {
  const a = row?.asset;
  return (
    <>
      {a && <input type="hidden" name="assetId" value={a.id} />}
      <Field label="Name" hint="What somebody would recognise stencilled on a crate.">
        <Input name="name" density="comfortable" required defaultValue={a?.name} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Kind">
          <Select name="kind" density="comfortable" defaultValue={a?.kind ?? 'display'}>
            {KINDS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Asset tag" hint="The barcode on the crate. Unique in this workspace.">
          <Input name="assetTag" density="comfortable" defaultValue={a?.assetTag ?? ''} />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Purchase value"
          hint="Capital, in dollars. What the alert quotes when it goes missing."
        >
          <Input
            name="purchaseValue"
            density="comfortable"
            inputMode="decimal"
            defaultValue={a?.purchaseValueCents != null ? (a.purchaseValueCents / 100).toFixed(2) : ''}
          />
        </Field>
        <Field label="Cost center" hint="Whose budget this belongs to. Set when the asset is created and not changed afterwards.">
          <Select name="costCenterId" density="comfortable">
            <option value="">—</option>
            {costCenters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} · {c.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Storage location">
          <Input name="storageLocation" density="comfortable" defaultValue={a?.storageLocation ?? ''} />
        </Field>
        <Field label="Weight (lb)">
          <Input name="weightLb" density="comfortable" inputMode="decimal" />
        </Field>
        <Field label="Dimensions">
          <Input name="dimensions" density="comfortable" />
        </Field>
      </div>
      {/*
        Condition is deliberately absent when editing. It is a fact discovered on
        a return, written by the person who unpacked it — a form that could type
        it is a second way to move it, and the two would disagree.
      */}
      {!a && (
        <Field
          label="Condition today"
          hint="Only settable here, at creation. After that it moves on a check-in and nowhere else."
        >
          <Select name="condition" density="comfortable" defaultValue="good">
            <option value="good">Good</option>
            <option value="needs_repair">Needs repair</option>
            <option value="damaged">Damaged</option>
            <option value="retired">Retired</option>
          </Select>
        </Field>
      )}
    </>
  );
}

export function NewAssetForm({ costCenters }: { costCenters: CostCenter[] }) {
  const [state, action, pending] = useActionState(addAsset, {});
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-sm text-brand hover:underline">
        Add an asset
      </button>
    );
  }
  return (
    <Form action={action} state={state} className="space-y-3">
      <AssetFields costCenters={costCenters} />
      <Message state={state} />
      <div className="flex items-center gap-3">
        <Submit pending={pending} busy="Adding…">
          Add asset
        </Submit>
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-text-muted hover:underline">
          Cancel
        </button>
      </div>
    </Form>
  );
}

export function EditAssetForm({ row, costCenters }: { row: AssetRow; costCenters: CostCenter[] }) {
  const [state, action, pending] = useActionState(updateAsset, {});
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-xs text-text-muted hover:underline">
        Edit
      </button>
    );
  }
  return (
    <Form action={action} state={state} className="mt-3 w-full space-y-3 rounded-md bg-muted p-3">
      <AssetFields row={row} costCenters={costCenters} />
      <Message state={state} />
      <div className="flex items-center gap-3">
        <Submit pending={pending} busy="Saving…">
          Save
        </Submit>
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-text-muted hover:underline">
          Cancel
        </button>
      </div>
    </Form>
  );
}

export function DeleteAssetForm({ assetId }: { assetId: string }) {
  const [state, action, pending] = useActionState(removeAsset, {});
  return (
    <Form action={action} state={state} className="inline">
      <input type="hidden" name="assetId" value={assetId} />
      <QuietSubmit pending={pending} busy="Deleting…">
        Delete
      </QuietSubmit>
      <Message state={state} />
    </Form>
  );
}

/* ------------------------------- reservations ------------------------------- */

export function ReserveForm({
  showId,
  timezone,
  options,
}: {
  showId: string;
  timezone: string;
  options: AssetOption[];
}) {
  const [state, action, pending] = useActionState(reserve, {});
  return (
    <Form action={action} state={state} className="space-y-3">
      <input type="hidden" name="showId" value={showId} />
      <Field
        label="Asset"
        hint="Everything is listed, with the reason it cannot be promised beside anything that cannot."
      >
        <Select name="assetId" density="comfortable" required>
          <option value="">Pick one…</option>
          {options.map((o) => (
            <option key={o.asset.id} value={o.asset.id}>
              {o.asset.name}
              {o.availability.kind !== 'available' ? ` — ${describe(o)}` : ''}
            </option>
          ))}
        </Select>
      </Field>
      <ul className="space-y-0.5 text-xs">
        {options
          .filter((o) => o.availability.kind !== 'available')
          .map((o) => (
            <li key={o.asset.id} className="flex flex-wrap gap-x-2">
              <span className="font-medium">{o.asset.name}</span>
              <AvailabilityNote availability={o.availability} />
            </li>
          ))}
      </ul>
      <Windows timezone={timezone} />
      <Field label="Notes">
        <Textarea name="notes" rows={2} />
      </Field>
      <Message state={state} />
      <Submit pending={pending} busy="Reserving…">
        Reserve
      </Submit>
    </Form>
  );
}

function describe(o: AssetOption): string {
  switch (o.availability.kind) {
    case 'unserviceable':
      return o.availability.why;
    case 'committed':
      return 'already promised for these dates';
    case 'tight_turnaround':
      return `${o.availability.gapHours.toFixed(0)}h turnaround`;
    default:
      return '';
  }
}

function Windows({ timezone, row }: { timezone: string; row?: AssetRow }) {
  return (
    <div className="space-y-2">
      <p className="text-xs text-text-muted">
        This is when the asset is <em>unavailable</em>, not when the show runs. Freight leaves for
        an advance warehouse one to three weeks before move-in and comes home weeks after move-out,
        so a window that matches the show dates promises the thing to somebody else while it is on
        a truck. Nothing is prefilled from the show for the same reason a warehouse cutoff is not.
      </p>
      <ZonedDateTime
        label="Leaves"
        dateName="reservedFromDate"
        timeName="reservedFromTime"
        instant={row?.reservation?.reservedFrom ?? null}
        timeZone={timezone}
        required
        defaultTime="08:00"
      />
      <ZonedDateTime
        label="Back"
        dateName="reservedToDate"
        timeName="reservedToTime"
        instant={row?.reservation?.reservedTo ?? null}
        timeZone={timezone}
        required
        defaultTime="17:00"
      />
    </div>
  );
}

export function RewindowForm({
  showId,
  timezone,
  row,
}: {
  showId: string;
  timezone: string;
  row: AssetRow;
}) {
  const [state, action, pending] = useActionState(rewindow, {});
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-xs text-text-muted hover:underline">
        Re-window
      </button>
    );
  }
  return (
    <Form action={action} state={state} className="mt-2 w-full space-y-3 rounded-md bg-muted p-3">
      <input type="hidden" name="showId" value={showId} />
      <input type="hidden" name="reservationId" value={row.reservation!.id} />
      <input type="hidden" name="assetId" value={row.asset.id} />
      <Windows timezone={timezone} row={row} />
      <Message state={state} />
      <div className="flex items-center gap-3">
        <Submit pending={pending} busy="Saving…">
          Save
        </Submit>
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-text-muted hover:underline">
          Cancel
        </button>
      </div>
    </Form>
  );
}

export function ReleaseForm({ showId, reservationId }: { showId: string; reservationId: string }) {
  const [state, action, pending] = useActionState(release, {});
  return (
    <Form action={action} state={state} className="inline">
      <input type="hidden" name="showId" value={showId} />
      <input type="hidden" name="reservationId" value={reservationId} />
      {/* The second press carries the acknowledgement — §5e's rule about un-staffing. */}
      {state.error && <input type="hidden" name="acknowledged" value="yes" />}
      <QuietSubmit pending={pending} busy="Releasing…">
        {state.error ? 'Release anyway' : 'Release'}
      </QuietSubmit>
      <Message state={state} />
    </Form>
  );
}

/* --------------------------------- custody ---------------------------------- */

export function SignOutForm({ showId, reservationId }: { showId?: string; reservationId: string }) {
  const [state, action, pending] = useActionState(signOut, {});
  return (
    <Form action={action} state={state} className="inline">
      {showId && <input type="hidden" name="showId" value={showId} />}
      <input type="hidden" name="reservationId" value={reservationId} />
      <Submit pending={pending} busy="Signing out…">
        Sign it out
      </Submit>
      <Message state={state} />
    </Form>
  );
}

export function SignInForm({ row, showId }: { row: AssetRow; showId?: string }) {
  const [state, action, pending] = useActionState(signIn, {});
  const out = row.reservation?.conditionOnCheckout ?? null;
  const [condition, setCondition] = useState<string>(out ?? 'good');
  const worse = out !== null && RANK[condition] > RANK[out];
  return (
    <Form action={action} state={state} className="space-y-2">
      {showId && <input type="hidden" name="showId" value={showId} />}
      <input type="hidden" name="reservationId" value={row.reservation!.id} />
      <input type="hidden" name="conditionOnCheckout" value={out ?? ''} />
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Condition it came back in">
          <Select value={condition} onChange={(e) => setCondition(e.target.value)} name="conditionOnReturn">
            <option value="good">Good</option>
            <option value="needs_repair">Needs repair</option>
            <option value="damaged">Damaged</option>
            <option value="retired">Retired — do not send it out again</option>
          </Select>
        </Field>
        <Submit pending={pending} busy="Checking in…">
          Check it in
        </Submit>
      </div>
      {out && (
        <p className="text-xs text-text-muted">
          It went out <Badge>{out.replace('_', ' ')}</Badge>. Both ends are recorded, which is the
          only reason the difference is a fact rather than a memory.
        </p>
      )}
      {worse && (
        <Field label="What happened" hint="Required: this is the moment the record stops being routine.">
          <Textarea name="note" rows={2} required />
        </Field>
      )}
      <Message state={state} />
    </Form>
  );
}

const RANK: Record<string, number> = { good: 0, needs_repair: 1, damaged: 2, retired: 3 };

/* -------------------------------- collateral -------------------------------- */

function CollateralFields({ row, costCenters }: { row?: CollateralRow; costCenters: CostCenter[] }) {
  const i = row?.item;
  return (
    <>
      {i && <input type="hidden" name="itemId" value={i.id} />}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <Input name="name" density="comfortable" required defaultValue={i?.name} />
        </Field>
        <Field label="SKU">
          <Input name="sku" density="comfortable" defaultValue={i?.sku ?? ''} />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field
          label="Low-stock threshold"
          hint="Compared against what is free, not what is on the shelf."
        >
          <Input
            name="lowStockThreshold"
            density="comfortable"
            inputMode="numeric"
            required
            defaultValue={i?.lowStockThreshold ?? 0}
          />
        </Field>
        <Field label="Unit cost">
          <Input
            name="unitCost"
            density="comfortable"
            inputMode="decimal"
            defaultValue={i?.unitCostCents != null ? (i.unitCostCents / 100).toFixed(2) : ''}
          />
        </Field>
        <Field label="Cost center">
          <Select name="costCenterId" density="comfortable">
            <option value="">—</option>
            {costCenters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} · {c.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Storage location">
        <Input name="storageLocation" density="comfortable" defaultValue={i?.storageLocation ?? ''} />
      </Field>
    </>
  );
}

export function NewCollateralForm({ costCenters }: { costCenters: CostCenter[] }) {
  const [state, action, pending] = useActionState(addCollateral, {});
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-sm text-brand hover:underline">
        Add a collateral item
      </button>
    );
  }
  return (
    <Form action={action} state={state} className="space-y-3">
      <CollateralFields costCenters={costCenters} />
      <p className="text-xs text-text-muted">
        It starts at nothing on hand. Stock arrives through a movement so the ledger has a first
        entry, rather than a quantity that came from nowhere and cannot be explained later.
      </p>
      <Message state={state} />
      <div className="flex items-center gap-3">
        <Submit pending={pending} busy="Adding…">
          Add item
        </Submit>
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-text-muted hover:underline">
          Cancel
        </button>
      </div>
    </Form>
  );
}

export function EditCollateralForm({ row, costCenters }: { row: CollateralRow; costCenters: CostCenter[] }) {
  const [state, action, pending] = useActionState(updateCollateral, {});
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-xs text-text-muted hover:underline">
        Edit
      </button>
    );
  }
  return (
    <Form action={action} state={state} className="mt-2 w-full space-y-3 rounded-md bg-muted p-3">
      <CollateralFields row={row} costCenters={costCenters} />
      <Message state={state} />
      <div className="flex items-center gap-3">
        <Submit pending={pending} busy="Saving…">
          Save
        </Submit>
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-text-muted hover:underline">
          Cancel
        </button>
      </div>
    </Form>
  );
}

export function DeleteCollateralForm({ itemId }: { itemId: string }) {
  const [state, action, pending] = useActionState(removeCollateral, {});
  return (
    <Form action={action} state={state} className="inline">
      <input type="hidden" name="itemId" value={itemId} />
      <QuietSubmit pending={pending} busy="Deleting…">
        Delete
      </QuietSubmit>
      <Message state={state} />
    </Form>
  );
}

export function MoveStockForm({ itemId }: { itemId: string }) {
  const [state, action, pending] = useActionState(moveStock, {});
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-xs text-brand hover:underline">
        Record a movement
      </button>
    );
  }
  return (
    <Form action={action} state={state} className="mt-2 space-y-2 rounded-md bg-muted p-3">
      <input type="hidden" name="itemId" value={itemId} />
      <div className="flex flex-wrap items-end gap-2">
        <Field label="What happened">
          <Select name="kind" defaultValue="received">
            <option value="received">Received — new stock arrived</option>
            <option value="written_off">Written off — damaged, lost, out of date</option>
            <option value="counted">Counted — a physical count that disagreed with the ledger</option>
          </Select>
        </Field>
        <Field label="Quantity">
          <Input name="quantity" inputMode="numeric" required className="w-24" />
        </Field>
      </div>
      <Field label="Why" hint="Required. A balance that moved without a stated reason is not auditable.">
        <Input name="reason" density="comfortable" required />
      </Field>
      <p className="text-xs text-text-muted">
        A count is the quantity you actually see on the shelf; the ledger records the difference as
        a signed entry rather than overwriting itself.
      </p>
      <Message state={state} />
      <div className="flex items-center gap-3">
        <Submit pending={pending} busy="Recording…">
          Record
        </Submit>
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-text-muted hover:underline">
          Cancel
        </button>
      </div>
    </Form>
  );
}

/* ------------------------------- allocations -------------------------------- */

export function AllocateForm({ showId, items }: { showId: string; items: CollateralRow[] }) {
  const [state, action, pending] = useActionState(allocate, {});
  return (
    <Form action={action} state={state} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="showId" value={showId} />
      <Field label="Item">
        <Select name="itemId" required defaultValue="">
          <option value="">Pick one…</option>
          {items.map((c) => (
            <option key={c.item.id} value={c.item.id}>
              {c.item.name} — {c.standing.available} free of {c.standing.onHand}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Quantity">
        <Input name="quantity" inputMode="numeric" required className="w-24" />
      </Field>
      <Submit pending={pending} busy="Allocating…">
        Allocate
      </Submit>
      <Message state={state} className="w-full" />
    </Form>
  );
}

export function PackForm({ showId, allocationId }: { showId?: string; allocationId: string }) {
  const [state, action, pending] = useActionState(packAllocation, {});
  return (
    <Form action={action} state={state} className="inline">
      {showId && <input type="hidden" name="showId" value={showId} />}
      <input type="hidden" name="allocationId" value={allocationId} />
      <QuietSubmit pending={pending} busy="Packing…">
        Pack it
      </QuietSubmit>
      <Message state={state} />
    </Form>
  );
}

export function CountBackForm({
  showId,
  row,
}: {
  showId?: string;
  row: ShowAllocationRow;
}) {
  const [state, action, pending] = useActionState(countBack, {});
  return (
    <Form action={action} state={state} className="flex flex-wrap items-end gap-2">
      {showId && <input type="hidden" name="showId" value={showId} />}
      <input type="hidden" name="allocationId" value={row.allocation.id} />
      <Field
        label="How many came back"
        hint="Zero is a real answer and a blank is not — a blank means nobody looked."
      >
        <Input name="counted" inputMode="numeric" required className="w-24" />
      </Field>
      <Submit pending={pending} busy="Counting…">
        Count it back
      </Submit>
      <Message state={state} className="w-full" />
    </Form>
  );
}

export function UnallocateForm({ showId, allocationId }: { showId?: string; allocationId: string }) {
  const [state, action, pending] = useActionState(unallocate, {});
  return (
    <Form action={action} state={state} className="inline">
      {showId && <input type="hidden" name="showId" value={showId} />}
      <input type="hidden" name="allocationId" value={allocationId} />
      <QuietSubmit pending={pending} busy="Removing…">
        Remove
      </QuietSubmit>
      <Message state={state} />
    </Form>
  );
}
